import { LocalDispatcher } from "@loomwork/dispatcher";
import type { ExecutionDispatcher } from "@loomwork/dispatcher";
import { LocalWorkerRuntime } from "@loomwork/worker-runtime-local";
import type { WorkflowRuntime } from "@loomwork/workflow-runtime";

// ── The compute seam ──────────────────────────────────────────────────────────
//
// By default, executions run in-process. A `dispatcher` decides WHERE an
// execution runs, without changing a single flow: an `ExecutionPackage` carries
// resume coordinates (identity + sequence), never code, and the worker resolves
// flows by id from a statically-wired registry.
//
// This helper wraps the local runtime in the same interface a remote / Cloud Run
// dispatcher implements — swap the one line below and the same flows run off-box:
//
//   import { RemoteWorkerRuntime } from "@loomwork/plugin-worker-remote";
//   return new LocalDispatcher(new RemoteWorkerRuntime("https://worker.example.com"));
//   // …or a Cloud Run dispatcher from @loomwork/plugin-cloudrun.
export function buildDispatcher(runtime: WorkflowRuntime): ExecutionDispatcher {
  return new LocalDispatcher(new LocalWorkerRuntime(runtime));
}
