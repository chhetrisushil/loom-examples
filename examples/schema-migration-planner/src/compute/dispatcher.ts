import { LocalDispatcher, PlacementDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { RemoteWorkerRuntime } from "@loom/plugin-worker-remote";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import type { WorkflowRuntime } from "@loom/workflow-runtime";

/** The placement lane a branch asks for. Advisory: an unknown target falls back to `local`. */
export const BRANCH_TARGET = "branch";

/**
 * Two lanes over one flow: the coordinator runs the mission in-process, and a branch
 * simulation is dispatched to a worker sized for it. Only the `WorkerRuntime` differs —
 * `LocalWorkerRuntime` calls the runtime directly, `RemoteWorkerRuntime` POSTs the same
 * `ExecutionPackage` to a worker server. Identical package, identical result shape.
 */
export function buildBranchDispatcher(
  coordinator: WorkflowRuntime,
  branchWorkerUrl: string
): ExecutionDispatcher {
  return new PlacementDispatcher({
    targets: {
      local: new LocalDispatcher(new LocalWorkerRuntime(coordinator)),
      [BRANCH_TARGET]: new LocalDispatcher(new RemoteWorkerRuntime(branchWorkerUrl)),
    },
    default: "local",
  });
}
