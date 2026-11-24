import {
  type AgentLoopConfig,
  agentLoop$,
  createAgentModelEffect,
  memoryRecallEffect,
  memoryWriteBackEffect,
} from "@loomwork/agent";
import { agent$, flow$, tool$ } from "@loomwork/core";
import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import type { LlmRequest } from "@loomwork/llm";
import { InMemoryMemoryStore, TieredMemory } from "@loomwork/memory";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  InMemoryGrantBroker,
  type MintRequest,
  type TaskGrant,
  TaskGrantAuthorizer,
  directedBy,
  installTaskAuthority,
  lineageOrigin,
  taskLeaseMiddleware,
} from "@loomwork/task-authority";
import { type FlowRunner, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { z } from "zod";
import { EMAIL, INCIDENTS, MODEL, PAGER, RECALL, WRITE, digestScript } from "./model";

export const SECRET = "digest-demo-secret"; // signs grants and binds the holder; one per deployment
export const MINUTE = 60_000;
/** Mid-minute, so the first cron occurrence is the next whole minute. */
export const T0 = Math.floor(1_700_000_000_000 / MINUTE) * MINUTE + MINUTE / 2;

const mk = (id: string) =>
  tool$({
    id,
    name: id,
    description: id,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });
export const TOOLS = [mk(INCIDENTS), mk(EMAIL), mk(PAGER)];

export interface WorldOptions {
  /** Install `directedBy` (park) and turn on the kernel's seen-origins tracking. */
  provenance?: boolean;
  /** Give the runtime a timer store (a `TimerService` needs one). */
  timers?: boolean;
  /** Which cross-lineage parks the broker may approve (default: none). */
  approveCrossLineage?: ConstructorParameters<typeof InMemoryGrantBroker>[0]["approveCrossLineage"];
}

export interface AgentFlowOptions {
  /** No memory, recall or write-back: just the model and its tools (a scheduled tick). */
  bare?: boolean;
  onExhausted?: "fail" | "park";
  /** The memory scope this run recalls from (and writes back to). */
  scope?: string;
  onDenied?: "fail" | "opaque" | "reason";
}

/**
 * One in-memory deployment: runtime, broker, effects and a memory, all on one controllable clock.
 * `calls` counts what the real handlers did, which is what a denial must leave at zero.
 */
export class World {
  readonly clock = { t: T0 };
  readonly store = new InMemoryAsyncEventStore();
  readonly memory = new TieredMemory({
    store: new InMemoryMemoryStore(),
    tiers: { working: { maxEntries: 100 } },
  });
  readonly calls: Record<string, number> = {};
  /** The task id of the grant each `email.send` ran under, in order (what `ctx.principal` carried). */
  readonly senders: string[] = [];
  readonly timerStore = new InMemoryTimerStore();
  readonly requests: LlmRequest[] = [];
  readonly configs: Record<string, AgentLoopConfig> = {};
  readonly broker: InMemoryGrantBroker;
  readonly effects: EffectRuntime;
  readonly runtime: WorkflowRuntime;

  constructor(o: WorldOptions = {}) {
    this.broker = new InMemoryGrantBroker({
      secret: SECRET,
      now: () => this.clock.t,
      ...(o.approveCrossLineage !== undefined && { approveCrossLineage: o.approveCrossLineage }),
    });
    // The lease middleware counts leased effects durably, before they run; the authorizer denies anything
    // outside the grant. `base` is the host's own policy (here: allow), consulted after the grant.
    const effects: EffectRuntime = new EffectRuntime(
      [
        taskLeaseMiddleware({
          secret: SECRET,
          source: this.broker,
          now: () => this.clock.t,
          effects: () => effects,
        }),
        // Placed AFTER the lease middleware. Only the governed write is checked for who directed it.
        ...(o.provenance === true
          ? [directedBy({ secret: SECRET, action: "park", appliesTo: [EMAIL] })]
          : []),
      ],
      {
        authorizer: new TaskGrantAuthorizer({
          secret: SECRET,
          base: { authorize: () => ({ allowed: true }) },
          now: () => this.clock.t,
        }),
      }
    );
    this.effects = effects;
    effects.register(
      MODEL,
      createAgentModelEffect({
        complete: async (r: LlmRequest) => {
          this.requests.push(r);
          return digestScript(r);
        },
      })
    );
    for (const id of [INCIDENTS, EMAIL, PAGER])
      effects.register(
        id,
        new ToolEffect(async (_input, ctx) => {
          this.calls[id] = (this.calls[id] ?? 0) + 1;
          if (id === EMAIL)
            this.senders.push(
              (ctx.principal?.taskGrant as TaskGrant | undefined)?.taskId ?? "anonymous"
            );
          return { ok: true };
        })
      );
    effects.register(RECALL, memoryRecallEffect(this.memory));
    effects.register(
      WRITE,
      memoryWriteBackEffect(this.memory, {
        originOf: (ctx) => lineageOrigin(SECRET)(ctx.principal),
      })
    );
    this.runtime = new WorkflowRuntime({
      eventStore: this.store,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      resumeAuthenticator: {
        verify: () => ({ status: "verified", actor: "ops", verifiedBy: "demo" }),
      },
      onWarn: () => {},
      ...(o.timers === true && { timerStore: this.timerStore }),
      ...(o.provenance === true && { seenOriginsEnabled: true }), // the kernel tracks who directed each run (ADR 0152)
    });
    installTaskAuthority(this.runtime, {
      source: this.broker,
      secret: SECRET,
      now: () => this.clock.t,
    });
  }

  /** Register a digest flow: an `agentLoop$` whose model, recall and write-back all go through the effect ring. */
  agentFlow(id: string, o: AgentFlowOptions = {}): FlowDefinition {
    const config: AgentLoopConfig = {
      definition: agent$({ id: `${id}-agent`, name: id, tools: TOOLS }),
      modelToolId: MODEL,
      maxIterations: 5,
      ...(o.bare !== true && {
        memory: this.memory,
        memoryScope: o.scope ?? "team:alpha",
        recall: { toolId: RECALL },
        writeBack: { toolId: WRITE },
      }),
      ...((o.onDenied !== undefined || o.onExhausted !== undefined) && {
        authority: {
          ...(o.onDenied !== undefined && { onDenied: o.onDenied }),
          ...(o.onExhausted !== undefined && { onExhausted: o.onExhausted }),
        },
      }),
    };
    this.configs[id] = config;
    const definition = flow$({
      id,
      name: id,
      version: "1.0.0",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({}).passthrough(),
      steps: [],
    });
    const runner: FlowRunner<{ prompt: string }, unknown> = (ctx, input) =>
      agentLoop$(ctx, config, input);
    this.runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
    return definition;
  }

  /** Mint a root grant (the task id is its root id) and start the flow AS that task. */
  async run(
    flow: FlowDefinition,
    executionId: string,
    prompt: string,
    request: Omit<MintRequest, "taskId" | "issuedTo" | "ttlMs">
  ) {
    const grant = await this.broker.mint({
      taskId: executionId,
      issuedTo: "digest-agent",
      ttlMs: 60 * 60_000,
      ...request,
    });
    await this.runtime.start(
      flow,
      { prompt },
      { executionId, principal: { actor: grant.issuedTo, taskGrant: grant } }
    );
    return settled(this.runtime, executionId);
  }

  events(executionId: string): Promise<readonly EventEnvelope[]> {
    return this.store.read(executionId);
  }
}

/** Wait on a CONDITION: poll until the execution has left `running`. Bounded, so a stuck run fails loudly. */
export async function until(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export async function settled(runtime: WorkflowRuntime, id: string) {
  let state = await runtime.loadState(id);
  await until(async () => {
    state = await runtime.loadState(id);
    return state !== null && state.status !== "running";
  }, `${id} to settle`);
  return state as NonNullable<typeof state>;
}

/** The refusal reasons of every EFFECT_DENIED event of an execution. */
export const deniedReasons = (events: readonly EventEnvelope[]): string[] =>
  events.filter((e) => e.eventType === "EFFECT_DENIED").map((e) => JSON.stringify(e.payload));
