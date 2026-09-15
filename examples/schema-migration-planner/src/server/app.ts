import { join } from "node:path";
import { BroadcastingProjectionRuntime, InProcessA2ABus, defineConfig } from "@loom/app";
import type { EventEnvelope } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { BranchRegistry } from "@loom/event-runtime";
import { SqliteTimerStore, sqliteStorage } from "@loom/plugin-sqlite";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../agents/definitions";
import { buildCatalog } from "../capabilities/catalog";
import { MigrationExecutionFlow } from "../capabilities/flows";
import { buildPlacementDispatcher } from "../compute/dispatcher";
import { Orchestrator } from "../orchestrator/Orchestrator";
import { MISSION_ID, type ServerFrame } from "../wire";

const SURFACES = ["mission", "telemetry", "branch"];

export interface ServerApp {
  readonly missionId: string;
  readonly orchestrator: Orchestrator;
  readonly projectionRuntime: BroadcastingProjectionRuntime;
  // The durable workflow runtime — exposed so speculative branches can be forked
  // from a task execution (missionRuntime.fork) and driven independently.
  readonly missionRuntime: WorkflowRuntime;
  // Git-style branch registry: movable refs + fork lineage for speculation.
  readonly branchRegistry: BranchRegistry;
  /** The placement dispatcher, when a branch worker is configured (#392). */
  readonly branchDispatcher?: ExecutionDispatcher;
  // A serialized ProjectionSnapshot of the mission + telemetry surfaces.
  snapshot(): string;
  // Observe the A2UI patch frames the server would push to SSE clients.
  subscribeBroadcast(cb: (frame: ServerFrame) => void): () => void;
  close(): void;
}

// Builds the entire durable, server-side agentic backend for one mission. The
// composition root (SQLite stores, WorkflowRuntime, effect runtime, projection
// wiring, catalog + flow registration) is now assembled by `defineConfig`; this
// file only adds the app-specific pieces: the broadcasting projection runtime
// (SSE), the bring-your-own A2A transport with its pluggable compute dispatcher,
// and the Orchestrator. Kept transport-free so it can be driven headlessly in
// tests and wrapped by the HTTP server in main.ts.
export function createApp(opts: {
  dataDir: string;
  missionId?: string;
  /**
   * Where branch simulations run. Given a worker URL, every forked branch is dispatched
   * to it instead of running inside this process — the shadow backfill is the expensive
   * part, and it wants capacity sized for a branch rather than for a web server. Omit and
   * the example behaves exactly as before.
   */
  branchWorkerUrl?: string;
}): ServerApp {
  const missionId = opts.missionId ?? MISSION_ID;

  const observers = new Set<(frame: ServerFrame) => void>();
  const emitPatch = (envelope: EventEnvelope): void => {
    for (const cb of observers) cb({ kind: "patch", envelope });
  };
  const projectionRuntime = new BroadcastingProjectionRuntime(missionId, SURFACES, emitPatch);

  const catalog = buildCatalog();
  // Built before defineConfig so the timer service can be handed the same dispatcher the
  // branch orchestrator uses — one placement decision, honoured on both paths.
  let runtimeRef: WorkflowRuntime | undefined;
  const branchDispatcher =
    opts.branchWorkerUrl !== undefined
      ? buildPlacementDispatcher(opts.branchWorkerUrl, () => {
          if (runtimeRef === undefined) throw new Error("runtime not built yet");
          return runtimeRef;
        })
      : undefined;
  const app = defineConfig({
    storage: sqliteStorage({ dir: opts.dataDir, branching: true }),
    projectionRuntime,
    surfaces: SURFACES,
    catalog,
    // The branchable migration flow isn't planner-routed — the Migration Board
    // drives it directly — so register it explicitly.
    flows: [MigrationExecutionFlow as RegisteredFlow],
    // Durable deadlines, so the shadow-verification gate inside each branch has a real
    // one — and so something other than an operator can wake a parked branch.
    // #392 — with a branch worker configured, a wake goes back to the lane the execution
    // was started in. Without the dispatcher here, a branch placed on the worker and then
    // parked for verification would be resumed by the timer service inside THIS process.
    timers: {
      store: new SqliteTimerStore(join(opts.dataDir, "timers.db")),
      ...(branchDispatcher !== undefined && { dispatcher: branchDispatcher }),
    },
  });

  runtimeRef = app.runtime;

  if (!app.stores.branchRegistry) {
    throw new Error("branch registry required for the Migration Board");
  }
  const branchRegistry = app.stores.branchRegistry;

  // Bring-your-own A2A transport, fed the durable runtime defineConfig built. This
  // custom bus wires a pluggable compute dispatcher (a LocalDispatcher over a
  // LocalWorkerRuntime) so a fiber can later move off-box without touching the
  // transport — so it stays app-owned rather than using app.bus.
  const bus = new InProcessA2ABus(app.runtime);
  for (const agent of FLEET) {
    const card = AGENT_CARDS[agent.id];
    if (card) bus.registerAgent(card);
  }
  for (const [capabilityId, agentId] of Object.entries(CAPABILITY_AGENT)) {
    const cap = catalog.get(capabilityId);
    if (cap) bus.registerCapability(capabilityId, agentId, cap.flow);
  }

  const orchestrator = new Orchestrator({
    projectionRuntime,
    missionRuntime: app.runtime,
    catalog,
    bus,
    branchRegistry,
    missionId,
    ...(branchDispatcher !== undefined && { dispatcher: branchDispatcher }),
  });

  return {
    missionId,
    orchestrator,
    projectionRuntime,
    missionRuntime: app.runtime,
    branchRegistry,
    ...(branchDispatcher !== undefined && { branchDispatcher }),
    snapshot: () => projectionRuntime.snapshot(),
    subscribeBroadcast(cb) {
      observers.add(cb);
      return () => observers.delete(cb);
    },
    close() {
      void app.close();
    },
  };
}
