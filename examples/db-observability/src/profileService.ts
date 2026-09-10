import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { Policy } from "@loom/learning";
import { InMemoryReadModelStore, ReadModelService } from "@loom/plugin-read-model";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { ExplorationFloor } from "./exploration";
import { flagDefinition } from "./flags";
import type { PreferenceScope } from "./preferences";
import {
  EMPTY_PROFILE,
  FLAG_DECLARED,
  FLAG_LAPSED,
  type FlagDeclaredPayload,
  type FlagLapsedPayload,
  OPERATOR_ACTION,
  type OperatorActionPayload,
  type OperatorProfile,
  PROFILE_MODEL,
  type ResolveInput,
  type SessionProfile,
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

interface DeclareInput {
  tenant: string;
  operator: string;
  flag: string;
  value: boolean;
}

const declareFlowDef: FlowDefinition<DeclareInput, { declared: true }> = {
  _tag: "FlowDefinition",
  id: "declare-flag",
  name: "Declare a capability flag",
  version: "1.0.0",
  inputSchema: z.object({
    tenant: z.string(),
    operator: z.string(),
    flag: z.string(),
    value: z.boolean(),
  }) as unknown as z.ZodSchema<DeclareInput>,
  outputSchema: z.object({ declared: z.literal(true) }) as z.ZodSchema<{ declared: true }>,
  steps: [],
};

const declareRunner: FlowRunner<DeclareInput, { declared: true }> = async (ctx, input) => {
  ctx.emit(FLAG_DECLARED, input satisfies FlagDeclaredPayload);
  return { declared: true };
};

interface OutcomeInput {
  explorationId: string;
  used: boolean;
}

const outcomeFlowDef: FlowDefinition<OutcomeInput, { scored: true }> = {
  _tag: "FlowDefinition",
  id: "score-exploration",
  name: "Score a surfaced capability",
  version: "1.0.0",
  inputSchema: z.object({
    explorationId: z.string(),
    used: z.boolean(),
  }) as unknown as z.ZodSchema<OutcomeInput>,
  outputSchema: z.object({ scored: z.literal(true) }) as z.ZodSchema<{ scored: true }>,
  steps: [],
};

const outcomeRunner: FlowRunner<OutcomeInput, { scored: true }> = async (
  ctx,
  { explorationId, used }
) => {
  // The shape `@loom/learning` mines for direct credit: an OUTCOME_RECORDED naming the
  // decision. `score: 0` is a measurement; omitting the event is not.
  ctx.emit("OUTCOME_RECORDED", { decisionId: explorationId, score: used ? 1 : 0 });
  return { scored: true };
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
   * Open a session: resolve the profile (journalled through `ctx.decide`) and draw the
   * exploration floor. Canonical mode zeroes the profile and suppresses the draw.
   */
  open(
    scope: PreferenceScope,
    executionId: string,
    options?: { canonical?: { active: boolean; reason?: string }; available?: string[] }
  ): Promise<SessionProfile>;
  /** State a flag directly — C7. Never expires, and no inference overwrites it. */
  declare(tenant: string, operator: string, flag: string, value: boolean): Promise<void>;
  /**
   * Score an exploration. `used: false` is recorded as a ZERO rather than left absent:
   * credit assignment skips an absent outcome, so recording only the successes produces
   * a profile that inflates monotonically.
   */
  scoreExploration(explorationId: string, executionId: string, used: boolean): Promise<void>;
  /**
   * Genuinely re-execute a finished run from its recorded state. `ctx.decide` serves the
   * recorded profile and the deriver is never consulted — which is the whole claim.
   */
  replay(executionId: string): Promise<SessionProfile>;
  /** The durable log for one execution. */
  events(executionId: string): Promise<EventEnvelope[]>;
  /** Every event this service has written, in time order — what a report reads. */
  allEvents(): Promise<EventEnvelope[]>;
  /** How many times the read model has actually been folded (the deriver's call count). */
  derivations(): number;
}

export function createProfileService(
  explorationPolicy: Policy<string> = new ExplorationFloor()
): ProfileService {
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
  runtime.registerFlow(declareFlowDef, declareRunner as FlowRunner<unknown, unknown>);
  runtime.registerFlow(outcomeFlowDef, outcomeRunner as FlowRunner<unknown, unknown>);
  const actionFlow: RegisteredFlow<ActionInput, { recorded: true }> = {
    definition: actionFlowDef,
    runner: actionRunner,
  };
  const lapseFlow: RegisteredFlow<LapseInput, { emitted: number }> = {
    definition: lapseFlowDef,
    runner: lapseRunner,
  };
  const declareFlow: RegisteredFlow<DeclareInput, { declared: true }> = {
    definition: declareFlowDef,
    runner: declareRunner,
  };
  const outcomeFlow: RegisteredFlow<OutcomeInput, { scored: true }> = {
    definition: outcomeFlowDef,
    runner: outcomeRunner,
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
  }, explorationPolicy);
  runtime.registerFlow(resolveProfileFlowDef, resolveRunner as FlowRunner<unknown, unknown>);
  const resolveFlow: RegisteredFlow<ResolveInput, SessionProfile> = {
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
    open: (scope, executionId, options) =>
      run(
        resolveFlow,
        {
          scope,
          ...(options?.canonical !== undefined && { canonical: options.canonical }),
          ...(options?.available !== undefined && { available: options.available }),
        },
        executionId
      ),
    async declare(tenant, operator, flag, value) {
      // Refuses an id outside the catalogue, exactly like every other path: an operator
      // may correct the system, not extend the vocabulary it reasons in.
      flagDefinition(flag);
      await run(declareFlow, { tenant, operator, flag, value }, `declare-${++n}`);
    },
    async scoreExploration(explorationId, executionId, used) {
      await run(outcomeFlow, { explorationId, used }, executionId);
    },
    async replay(executionId) {
      const state = await runtime.loadState(executionId);
      if (state === null) throw new Error(`no recorded execution "${executionId}"`);
      const handle = await runtime.restoreFromState(state);
      const finished = await handle.waitForCompletion();
      return finished.variables._output as SessionProfile;
    },
    events: (executionId) => eventStore.read(executionId),
    async allEvents() {
      const ids = await eventStore.listExecutions();
      const logs = await Promise.all(ids.map((id) => eventStore.read(id)));
      return logs.flat().sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
    },
    derivations: () => derivations,
  };
}
