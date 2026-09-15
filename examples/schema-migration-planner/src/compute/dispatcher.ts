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
  return buildPlacementDispatcher(branchWorkerUrl, () => coordinator);
}

/**
 * The same two lanes, but with the local one resolved on first use.
 *
 * The composition root needs this: `defineConfig` builds the runtime, and the dispatcher has
 * to be handed TO `defineConfig` (so the timer service can re-drive a wake on the lane the
 * execution was started in, #392). One placement decision, honoured by the branch
 * orchestrator and by the wake path, rather than two that can disagree.
 */
export function buildPlacementDispatcher(
  branchWorkerUrl: string,
  coordinator: () => WorkflowRuntime
): ExecutionDispatcher {
  let local: ExecutionDispatcher | undefined;
  const localLane = (): ExecutionDispatcher => {
    local ??= new LocalDispatcher(new LocalWorkerRuntime(coordinator()));
    return local;
  };
  const lazyLocal: ExecutionDispatcher = {
    dispatch: (pkg, meta) => localLane().dispatch(pkg, meta),
    cancel: (executionId) => localLane().cancel(executionId),
    health: () => localLane().health(),
  };
  return new PlacementDispatcher({
    targets: {
      local: lazyLocal,
      [BRANCH_TARGET]: new LocalDispatcher(new RemoteWorkerRuntime(branchWorkerUrl)),
    },
    default: "local",
  });
}
