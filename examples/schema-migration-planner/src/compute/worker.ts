import { join } from "node:path";
import { EffectRuntime } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore, SqliteTimerStore } from "@loom/plugin-sqlite";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { MigrationExecutionFlow } from "../capabilities/flows";

// ── The branch worker ─────────────────────────────────────────────────────────
//
// A simulated migration is not cheap work: it clones a table, backfills tens of
// millions of rows, and holds that capacity for as long as it takes. Running three
// of those inside the coordinator process is the demo's convenient lie — a real one
// wants its own compute, sized for the branch rather than for the web server.
//
// This is that compute. It is NOT a different program: the same flow, registered on
// a WorkflowRuntime over the SAME durable stores. That is the whole premise of the
// placement seam — an ExecutionPackage carries identity and resume coordinates, never
// code or state, so the worker reconstructs the branch from the shared log.
//
// Shared SQLite, not a copy: `journal_mode = WAL` lets the coordinator and the worker
// hold the same files from different processes on one host. That bound is honest —
// SQLite has no fencing, so this is a single-host arrangement. Multi-node would want
// Postgres, where `acquireFence` keeps a partitioned zombie worker from writing.
export function buildBranchWorkerRuntime(dataDir: string): WorkflowRuntime {
  const runtime = new WorkflowRuntime({
    eventStore: new SqliteEventStore(join(dataDir, "events.db")),
    snapshotStore: new SqliteSnapshotStore(join(dataDir, "snapshots.db")),
    effectRuntime: new EffectRuntime(),
    // NOT optional, and the reason is a trap worth stating. A runtime derives a
    // suspension's `wakeAt` from its `timeout` **only when a TimerStore is wired**;
    // unwired, the condition is committed without one — byte-identically, silently. So a
    // worker built as "just a runtime with the flows registered" discards every declared
    // deadline of every branch it parks, and nothing downstream can tell the difference
    // between "no deadline" and "the deadline was dropped on the machine that suspended".
    //
    // Firing is a separate job: the worker RECORDS deadlines, the coordinator's
    // TimerService fires them. Splitting compute means every runtime that can suspend
    // needs the store; only one of them needs the service.
    timerStore: new SqliteTimerStore(join(dataDir, "timers.db")),
  });
  runtime.registerFlow(MigrationExecutionFlow.definition, MigrationExecutionFlow.runner);
  return runtime;
}
