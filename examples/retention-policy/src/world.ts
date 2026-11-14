// The simulated world: SQLite stores in a temp dir, a runtime and content store that both read ONE
// simulated clock, and a small flow whose runs finish (or don't) on different simulated days.
//
// No real waits anywhere: `clock.set(day)` is the only way time passes, and every event timestamp,
// every content-store touch time and every retention/sweep `now` comes from it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow$, step$ } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { claimCheckMiddleware } from "@loomwork/middleware";
import { SqliteContentStore, SqliteEventStore, SqliteSnapshotStore } from "@loomwork/plugin-sqlite";
import type { FlowRunner, RegisteredFlow } from "@loomwork/workflow-runtime";
import { LogLifecycle, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { z } from "zod";
import { DAY } from "./retention";

export { DAY };

/** The app's pinned domain event kind: an execution that recorded one is never reclaimed. */
export const FINDING_RECORDED = "FindingRecorded";

/**
 * The app's pinned event kinds, stated ONCE. They are handed to `LogLifecycle` (`pinnedEventTypes`
 * with `pinByEventTypes: true`, which also pins for retention); the content sweep then reads them back from
 * `lifecycle.pinnedEventTypes` (see passes.ts), so the two cannot drift.
 */
export const PINNED_KINDS: readonly string[] = [FINDING_RECORDED];

/** A tool whose result is disposable telemetry (the default claim-check envelope: RECLAIMABLE). */
export const TELEMETRY_TOOL = "metrics.read";
/** A tool whose result is load-bearing data: `retain: true` envelope, never TTL-reclaimed. */
export const LEDGER_TOOL = "ledger.read";
const INLINE_CAP_BYTES = 256;

/** One simulated clock, in whole days from the epoch (day 0 = 2026-01-01T00:00:00Z). */
export class SimClock {
  private ms = 0;
  readonly now = (): number => this.ms;
  /** Move to the start of simulated day `day`. Time only moves forward. */
  set(day: number): void {
    const next = day * DAY;
    if (next < this.ms) throw new Error(`clock moves forward only (${this.ms / DAY} -> ${day})`);
    this.ms = next;
  }
  get day(): number {
    return this.ms / DAY;
  }
}

const RunInput = z.object({
  label: z.string(),
  tool: z.enum([TELEMETRY_TOOL, LEDGER_TOOL]).default(TELEMETRY_TOOL),
  /** Record a FindingRecorded event citing the blob it read. */
  finding: z.boolean().default(false),
  /** Park on a gate before finishing (a long-running or never-finishing execution). */
  pause: z.boolean().default(false),
});
type RunInput = z.infer<typeof RunInput>;
const Continue = z.object({ by: z.string() });

const stepFor = (id: string, toolId: string) =>
  step$({
    id,
    name: `Read a large payload (${toolId})`,
    toolId,
    inputSchema: z.object({ label: z.string() }),
    outputSchema: z.unknown() as z.ZodSchema<unknown>,
  });
const readTelemetry = stepFor("read-telemetry", TELEMETRY_TOOL);
const readLedger = stepFor("read-ledger", LEDGER_TOOL);

/** A deterministic payload comfortably over the inline cap, so the middleware offloads it. */
function payloadFor(label: string): { label: string; rows: string[] } {
  return { label, rows: Array.from({ length: 40 }, (_, i) => `${label}:${i}:${"x".repeat(16)}`) };
}

const runner: FlowRunner<RunInput, { label: string }> = async (ctx, input) => {
  const read = await ctx.run(input.tool === LEDGER_TOOL ? readLedger : readTelemetry, {
    label: input.label,
  });
  if (input.finding) {
    const ref = (read as { ref?: { __loomContent: string } }).ref;
    ctx.emit(FINDING_RECORDED, { label: input.label, evidence: ref });
  }
  if (input.pause) await ctx.suspend<z.infer<typeof Continue>>({ on: "Continue" });
  return { label: input.label };
};

export const reportFlow = {
  definition: flow$({
    id: "report-run",
    name: "Report run",
    version: "1.0.0",
    inputSchema: RunInput,
    outputSchema: z.object({ label: z.string() }),
    steps: [readTelemetry, readLedger],
    resumeSchemas: { Continue },
  }),
  runner,
} as RegisteredFlow;

/**
 * The same flow after a deploy that added a review stage. `resumeAs` (loom ADR 0104) re-opens an
 * execution that already ENDED on the old code and migrates it here: the old log replays (it already
 * answers the original `Continue` gate), so the run parks at the FIRST gate the old log has no answer
 * for. That is the one new `Review` gate below. The `Reopen` resume event answers NO gate; it is only
 * a plain log entry. This is how a terminal execution comes back to life, and why retention must not
 * treat "has a terminal event" as "is over". Recipe: loom docs/usage.md, "Re-open a finished
 * execution and leave it parked: `resumeAs`".
 */
export const reviewedFlow = {
  definition: flow$({
    id: "report-run-reviewed",
    name: "Report run (with review)",
    version: "2.0.0",
    inputSchema: RunInput,
    outputSchema: z.object({ label: z.string() }),
    steps: [readTelemetry, readLedger],
    resumeSchemas: { Continue, Reopen: Continue, Review: Continue },
  }),
  runner: (async (ctx, input) => {
    const out = await runner(ctx, input);
    await ctx.suspend<z.infer<typeof Continue>>({ on: "Review" });
    return out;
  }) as FlowRunner<RunInput, { label: string }>,
} as RegisteredFlow;

export interface World {
  dir: string;
  clock: SimClock;
  eventStore: SqliteEventStore;
  snapshotStore: SqliteSnapshotStore;
  contentStore: SqliteContentStore;
  /** The retention archive (ADR 0022 A6): a whole execution is copied here before it is deleted. */
  archive: { eventStore: SqliteEventStore; snapshotStore: SqliteSnapshotStore };
  runtime: WorkflowRuntime;
  lifecycle: LogLifecycle;
  /** Start a run on the current simulated day. */
  run(executionId: string, input: Partial<RunInput> & { label: string }): Promise<void>;
  /** Re-open an ENDED run on the reviewed flow (ADR 0104 `resumeAs`); it parks on the new `Review` gate. */
  reopen(executionId: string): Promise<void>;
  /** Answer a parked run's gate on the current simulated day; it then finishes. */
  continueRun(executionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface WorldOptions {
  /**
   * The clock the CONTENT STORE stamps touch times with. Default: the simulated log clock (correct).
   * Pass a different one to reproduce the clock disagreement of loom docs/usage-cli.md, "Clocks in a sweep".
   */
  contentClock?: () => number;
}

export function newWorld(options: WorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "loom-retention-policy-"));
  const clock = new SimClock();
  const eventStore = new SqliteEventStore(join(dir, "events.db"));
  const snapshotStore = new SqliteSnapshotStore(join(dir, "snapshots.db"));
  // The content store stamps touch times with the SIMULATED clock: the sweep's race guard compares
  // them with a cutoff on the store's clock, so a wall-clock store would look freshly touched.
  const contentStore = new SqliteContentStore(join(dir, "content.db"), {
    now: options.contentClock ?? clock.now,
  });
  const archive = {
    eventStore: new SqliteEventStore(join(dir, "archive-events.db")),
    snapshotStore: new SqliteSnapshotStore(join(dir, "archive-snapshots.db")),
  };

  const effects = new EffectRuntime([
    claimCheckMiddleware({
      store: contentStore,
      inlineCapBytes: INLINE_CAP_BYTES,
      // Telemetry is the default (reclaimable). Only the ledger tool's blobs are RETAINED.
      retain: (toolId) => toolId === LEDGER_TOOL,
    }),
  ]);
  for (const id of [TELEMETRY_TOOL, LEDGER_TOOL]) {
    effects.register(
      id,
      new ToolEffect<{ label: string }, unknown>(async ({ label }) => payloadFor(label), {
        idempotent: true,
      }) as never
    );
  }
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: clock.now,
    validateInput: true,
  });
  runtime.registerFlow(reportFlow.definition, reportFlow.runner);
  runtime.registerFlow(reviewedFlow.definition, reviewedFlow.runner);

  // Pins are LogLifecycle options, not part of the (numbers-only) policy value. The kinds are
  // declared ONCE: `pinnedEventTypes` keeps them through compaction, `pinByEventTypes: true` makes
  // retention pin every run that holds one (no second `pinByEventKinds` list, no extra read), and
  // `lifecycle.pinnedEventTypes` hands the same list to the sweep.
  const lifecycle = new LogLifecycle(eventStore, snapshotStore, {
    archive,
    pinnedEventTypes: PINNED_KINDS,
    pinByEventTypes: true,
  });

  return {
    dir,
    clock,
    eventStore,
    snapshotStore,
    contentStore,
    archive,
    runtime,
    lifecycle,
    async run(executionId, input) {
      const handle = await runtime.start(reportFlow, input as never, { executionId });
      await Promise.race([handle.waitForCompletion(), handle.waitForSuspend()]);
    },
    async reopen(executionId) {
      const handle = await runtime.resumeAs(
        executionId,
        reviewedFlow.definition.id,
        { eventType: "Reopen", payload: { by: "operator" } },
        { strategy: "operator-ack" }
      );
      await handle.waitForSuspend();
    },
    async continueRun(executionId) {
      const handle = await runtime.resume(executionId, {
        eventType: "Continue",
        payload: { by: "operator" },
      });
      await handle.waitForCompletion();
    },
    async close() {
      await Promise.all([
        eventStore.close(),
        snapshotStore.close(),
        contentStore.close(),
        archive.eventStore.close(),
        archive.snapshotStore.close(),
      ]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
