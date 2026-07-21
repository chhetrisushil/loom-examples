import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type ChildSupervisor, superviseChildren } from "@loom/orchestration";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { buildFlow, childFlows, publishFlow, releaseFlow, smokeFlow } from "./flows";

/**
 * Build a runtime with the child supervisor wired into `onEvent`. The supervisor is the
 * one piece that turns spawn intents (recorded by awaitChild/awaitChildren/awaitAll) into
 * running child executions and their completions back into parent resumes — it sees every
 * execution's events via onEvent. The `holder` breaks the construction cycle (the runtime
 * needs onEvent, onEvent needs the supervisor, the supervisor needs the runtime).
 */
export function buildRuntime(): WorkflowRuntime {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (event) => holder.supervisor?.onEvent(event),
  });

  // Register the parent + every child flow (each pair keeps its own input/output types).
  runtime.registerFlow(releaseFlow.definition, releaseFlow.runner);
  runtime.registerFlow(buildFlow.definition, buildFlow.runner);
  runtime.registerFlow(smokeFlow.definition, smokeFlow.runner);
  runtime.registerFlow(publishFlow.definition, publishFlow.runner);
  holder.supervisor = superviseChildren({
    runtime,
    flows: childFlows,
    onError: (err) => console.error("[supervisor]", err),
  });
  return runtime;
}
