import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import {
  type OperatorPreferences,
  type PreferenceScope,
  type RecordInput,
  createPreferenceState,
  recordFlowDef,
  recordRunner,
  registerPreferenceEffects,
  resolveFlowDef,
  resolveRunner,
} from "./preferences";

// The two preference operations as durable runs. Both go through the same
// `durableState` contract, so a load is a recorded step and a save is a recorded CAS —
// which is what puts "the preferences this run used" in the run's own log rather than in
// a map beside it. That property is worth nothing yet; it is worth everything at the
// point the input stops being something the operator typed.

export interface PreferenceService {
  /** Record a stated choice. Returns the merged, effective set. */
  state(scope: PreferenceScope, stated: Partial<OperatorPreferences>): Promise<OperatorPreferences>;
  /** The effective set for a scope — the canonical defaults when nothing was stated. */
  resolve(scope: PreferenceScope): Promise<OperatorPreferences>;
  /** The durable log for one preference run (the recorded load/save steps). */
  events(executionId: string): Promise<EventEnvelope[]>;
}

export function createPreferenceService(): PreferenceService {
  const state = createPreferenceState();
  const effects = new EffectRuntime();
  registerPreferenceEffects(state, effects);

  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });

  const record = recordRunner(state);
  const resolve = resolveRunner(state);
  runtime.registerFlow(recordFlowDef, record as FlowRunner<unknown, unknown>);
  runtime.registerFlow(resolveFlowDef, resolve as FlowRunner<unknown, unknown>);
  const recordFlow: RegisteredFlow<RecordInput, OperatorPreferences> = {
    definition: recordFlowDef,
    runner: record,
  };
  const resolveFlow: RegisteredFlow<PreferenceScope, OperatorPreferences> = {
    definition: resolveFlowDef,
    runner: resolve,
  };

  // Each run gets its own execution id: stating a choice is an event in the operator's
  // life, not a step in a session, and a shared id would make the second statement replay
  // the first one's recorded steps and appear to do nothing.
  let n = 0;
  const nextId = (prefix: string): string => `${prefix}-${++n}`;

  async function run<TIn, TOut>(
    flow: RegisteredFlow<TIn, TOut>,
    input: TIn,
    prefix: string
  ): Promise<TOut> {
    const handle = await runtime.start(flow, input, { executionId: nextId(prefix) });
    const finished = await handle.waitForCompletion();
    return finished.variables._output as TOut;
  }

  return {
    state: (scope, stated) => run(recordFlow, { scope, stated }, "state"),
    resolve: (scope) => run(resolveFlow, scope, "resolve"),
    events: (executionId) => eventStore.read(executionId),
  };
}
