import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryReadModelStore, ReadModelService } from "@loom/plugin-read-model";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import type { PreferenceScope } from "./preferences";
import {
  EMPTY_PROFILE,
  FLAG_LAPSED,
  type FlagLapsedPayload,
  OPERATOR_ACTION,
  type OperatorActionPayload,
  type OperatorProfile,
  PROFILE_MODEL,
  type ResolveInput,
  dueLapses,
  foldProfile,
  resolveProfileFlowDef,
  resolveProfileRunner,
  subjectOf,
} from "./profile";

// The runtime side of Phase 2. Three things happen here and they are deliberately
// separate: the app records what an operator DID (ordinary domain events), a read model
// indexes those events, and a resolve run derives a profile from the index and journals
// it. Nothing in the middle writes profile state, so replaying any run cannot change a
// profile — the property is structural rather than a rule someone has to remember.

interface ActionInput {
  tenant: string;
  operator: string;
  action: string;
}

const actionFlowDef: FlowDefinition<ActionInput, { recorded: true }> = {
  _tag: "FlowDefinition",
  id: "operator-interaction",
  name: "Record an operator interaction",
  version: "1.0.0",
  inputSchema: z.object({
    tenant: z.string(),
    operator: z.string(),
    action: z.string(),
  }) as unknown as z.ZodSchema<ActionInput>,
  outputSchema: z.object({ recorded: z.literal(true) }) as z.ZodSchema<{ recorded: true }>,
  steps: [],
};

const actionRunner: FlowRunner<ActionInput, { recorded: true }> = async (ctx, input) => {
  // An ordinary domain event. The fold skips it, the read model indexes it, and the
  // profile is derived from it later by something that is not this run.
  ctx.emit(OPERATOR_ACTION, input satisfies OperatorActionPayload);
  return { recorded: true };
};

interface LapseInput {
  lapses: FlagLapsedPayload[];
}

const lapseFlowDef: FlowDefinition<LapseInput, { emitted: number }> = {
  _tag: "FlowDefinition",
  id: "expire-flags",
  name: "Expire unevidenced flags",
  version: "1.0.0",
  inputSchema: z.object({
    lapses: z.array(
      z.object({
        tenant: z.string(),
        operator: z.string(),
        flag: z.string(),
        lastEvidencedAt: z.number(),
      })
    ),
  }) as unknown as z.ZodSchema<LapseInput>,
  outputSchema: z.object({ emitted: z.number() }) as z.ZodSchema<{ emitted: number }>,
  steps: [],
};

const lapseRunner: FlowRunner<LapseInput, { emitted: number }> = async (ctx, { lapses }) => {
  for (const lapse of lapses) ctx.emit(FLAG_LAPSED, lapse);
  return { emitted: lapses.length };
};

export interface ProfileService {
  /** Record something the operator did. The only write path in Phase 2. */
  observe(tenant: string, operator: string, action: string): Promise<void>;
  /** The profile as the read model currently sees it — the DERIVED value, unjournaled. */
  derive(tenant: string, operator: string): Promise<OperatorProfile>;
  /**
   * The scheduled expiry pass: derive, find what has outlived its horizon as of `now`,
   * and APPEND a lapse for each. Returns how many it emitted. Idempotent in effect — a
   * second pass finds the flag already lapsed and emits nothing.
   */
  expire(tenant: string, operator: string, now: number): Promise<number>;
  /**
   * Resolve the profile into a run and journal it (`ctx.decide`). Re-running the same
   * `executionId` serves the recorded profile, whatever the read model says by then.
   */
  resolve(scope: PreferenceScope, executionId: string): Promise<OperatorProfile>;
  /**
   * Genuinely re-execute a finished run from its recorded state. `ctx.decide` serves the
   * recorded profile and the deriver is never consulted — which is the whole claim.
   */
  replay(executionId: string): Promise<OperatorProfile>;
  /** The durable log for one execution. */
  events(executionId: string): Promise<EventEnvelope[]>;
  /** How many times the read model has actually been folded (the deriver's call count). */
  derivations(): number;
}

export function createProfileService(): ProfileService {
  const rows = new InMemoryReadModelStore();
  const readModels = new ReadModelService(rows);
  readModels.register(PROFILE_MODEL);

  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    // The live tail: every event the app writes is offered to the read model, which keeps
    // only the kinds it declares. Ingestion is idempotent per row, so a catch-up scan
    // after a restart converges with whatever this delivered.
    onEvent: (event) => readModels.handleEvent(event),
  });

  runtime.registerFlow(actionFlowDef, actionRunner as FlowRunner<unknown, unknown>);
  runtime.registerFlow(lapseFlowDef, lapseRunner as FlowRunner<unknown, unknown>);
  const actionFlow: RegisteredFlow<ActionInput, { recorded: true }> = {
    definition: actionFlowDef,
    runner: actionRunner,
  };
  const lapseFlow: RegisteredFlow<LapseInput, { emitted: number }> = {
    definition: lapseFlowDef,
    runner: lapseRunner,
  };

  let derivations = 0;

  async function derive(tenant: string, operator: string): Promise<OperatorProfile> {
    derivations++;
    const subject = subjectOf(tenant, operator);
    const page = await readModels.query(PROFILE_MODEL.id, { where: { subject }, limit: 10_000 });
    return page.rows.length === 0 ? EMPTY_PROFILE(subject) : foldProfile(subject, page.rows);
  }

  const resolveRunner = resolveProfileRunner(async (subject) => {
    const [tenant = "", operator = ""] = subject.split(":");
    return derive(tenant, operator);
  });
  runtime.registerFlow(resolveProfileFlowDef, resolveRunner as FlowRunner<unknown, unknown>);
  const resolveFlow: RegisteredFlow<ResolveInput, OperatorProfile> = {
    definition: resolveProfileFlowDef,
    runner: resolveRunner,
  };

  let n = 0;
  const run = async <TIn, TOut>(
    flow: RegisteredFlow<TIn, TOut>,
    input: TIn,
    executionId: string
  ): Promise<TOut> => {
    const handle = await runtime.start(flow, input, { executionId });
    const finished = await handle.waitForCompletion();
    return finished.variables._output as TOut;
  };

  return {
    async observe(tenant, operator, action) {
      await run(actionFlow, { tenant, operator, action }, `act-${++n}`);
    },
    derive,
    async expire(tenant, operator, now) {
      const lapses = dueLapses(await derive(tenant, operator), now);
      if (lapses.length === 0) return 0;
      const { emitted } = await run(lapseFlow, { lapses }, `expire-${++n}`);
      return emitted;
    },
    resolve: (scope, executionId) => run(resolveFlow, { scope }, executionId),
    async replay(executionId) {
      const state = await runtime.loadState(executionId);
      if (state === null) throw new Error(`no recorded execution "${executionId}"`);
      const handle = await runtime.restoreFromState(state);
      const finished = await handle.waitForCompletion();
      return finished.variables._output as OperatorProfile;
    },
    events: (executionId) => eventStore.read(executionId),
    derivations: () => derivations,
  };
}
