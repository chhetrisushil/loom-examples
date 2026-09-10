import type { ExecutionState } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type LiveQuery, liveQuery } from "@loom/live-query";
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
export interface ReleaseRuntime {
  runtime: WorkflowRuntime;
  /** The log itself, so a caller reading child streams does not have to reach into the
   *  runtime's private field to find it. */
  eventStore: InMemoryAsyncEventStore;
  /**
   * A live read of any execution in this runtime — `loadState` composed with the store's
   * subscription, so a caller waits on EVENTS instead of a clock. What the supervisor drives
   * is asynchronous by construction (spawn intents become child executions, completions
   * become parent resumes), and polling for a terminal state means a fixed interval that is
   * either wasteful or too slow, plus an iteration cap that is a guess about how long the
   * work takes.
   */
  live: LiveQuery;
}

export function buildRuntime(): ReleaseRuntime {
  const holder: { supervisor?: ChildSupervisor } = {};
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
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
  return {
    runtime,
    eventStore,
    live: liveQuery({
      eventStore,
      reader: runtime,
      // Re-folds run from the store's subscribe callback with nothing awaiting them, so a
      // rejection here would otherwise be unhandled.
      onError: (err) => console.error("[live-query]", err),
    }),
  };
}

/**
 * Resolve when `executionId` reaches a terminal state, driven by the log rather than a clock.
 *
 * `subscribe` pushes the current state immediately and again after every event, so an
 * execution that finished before this call still resolves — and one that has not finished
 * costs nothing until an event lands. The previous shape here was 400 polls at 5ms: an
 * interval that is either wasteful or too slow, and a cap that is a guess about how long a
 * release takes.
 */
export async function awaitTerminal(live: LiveQuery, executionId: string): Promise<ExecutionState> {
  return new Promise<ExecutionState>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    live
      .subscribe(executionId, (state) => {
        if (settled || (state.status !== "completed" && state.status !== "failed")) return;
        settled = true;
        // May not be assigned yet if the very first push is terminal; the `settled` flag
        // below tears down in that case.
        unsubscribe?.();
        resolve(state);
      })
      .then(
        (off) => {
          unsubscribe = off;
          if (settled) off();
        },
        (err) => reject(err)
      );
  });
}
