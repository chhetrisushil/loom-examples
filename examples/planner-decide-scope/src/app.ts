import { checkPlannerConformance } from "@loom-ui/planner";
import type { FlowDefinition } from "@loom/core";
import {
  type CapabilityRequest,
  DelegationAuthorizer,
  type EffectContext,
  type EffectMiddleware,
  EffectRuntime,
  GrantTable,
  delegationDigest,
  signDelegation,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { recordReach } from "@loom/verify";
import { type FlowRunner, type PrincipalResolver, WorkflowRuntime } from "@loom/workflow-runtime";
import { z } from "zod";
import { capabilities, triageCatalog } from "./catalog";
import { LLM_TOOL_ID, fakeLlm } from "./llm";
import { createPlanner, modelFor } from "./planner";

type Json = Record<string, unknown>;
const io = z.object({}).passthrough() as z.ZodSchema<Json>;

export const TRIAGE_FLOW = "ticket-triage";
export const UNGRANTED_FLOW = "ticket-triage-ungranted";
export const CONFORMANCE_FLOW = "planner-conformance";
export const MEMO_FLOW = "memo-probe";
export const FANOUT_FLOW = "fan-out-probe";
export const RECORDED_FLOW = "reach-recorded";
const SECRET = "example-delegation-secret";

/** The principal a request arrives with: a tenant, an actor, and a token attenuated to the LLM effect. */
export const delegatedPrincipal = {
  tenant: "acme",
  actor: "alice",
  delegation: signDelegation(SECRET, "alice", [LLM_TOOL_ID]),
};

/**
 * The app's token store. The kernel records a principal on EXECUTION_STARTED as a DESCRIPTION
 * (identity + a digest of the delegation, never the bearer token), and effects run as that durable
 * owner after every park/resume/restart. So a delegated principal needs something that can put the
 * token back: this app-owned store, keyed by the digest the kernel recorded. A start that carries a
 * delegation with no such restorer is refused (`PrincipalUnrestorableError`), because it would be
 * denied after its first park.
 */
const tokenStore = new Map([
  [delegationDigest(delegatedPrincipal.delegation), delegatedPrincipal.delegation],
]);

/** Rebuild the effect principal from the recorded record; an unknown digest restores no delegation. */
const principalResolver: PrincipalResolver = {
  resolve(record) {
    const token =
      record.delegation === undefined ? undefined : tokenStore.get(record.delegation.id);
    // The delegation was recorded but the token is gone: fail closed (undefined denies every effect).
    if (record.delegation !== undefined && token === undefined) return undefined;
    return { ...record.identity, ...(token === undefined ? {} : { delegation: token }) };
  },
};

const intent = { objective: "Triage the billing queue", source: "user" as const };

export function createTriageApp(opts: { reach?: boolean } = {}) {
  const llm = fakeLlm();
  // What the effect runtime saw: the authorizer's request and the middleware's context, per call.
  const requests: CapabilityRequest[] = [];
  const contexts: EffectContext[] = [];

  // A flow-scoped grant (keyed by workflowId). DelegationAuthorizer also verifies the token, and
  // may only NARROW what the base grants. The recorder wraps it so the example can show what the
  // authorizer was asked; a production authorizer needs no recorder.
  const granted: Record<string, string[]> = {
    [TRIAGE_FLOW]: [LLM_TOOL_ID],
    [CONFORMANCE_FLOW]: [LLM_TOOL_ID],
    [MEMO_FLOW]: [LLM_TOOL_ID],
    [FANOUT_FLOW]: [LLM_TOOL_ID],
    [RECORDED_FLOW]: [LLM_TOOL_ID],
  };
  let grants = new GrantTable(granted);
  const inner = new DelegationAuthorizer({
    secret: SECRET,
    // read through `grants` on every call so `grant()` below takes effect for later executions
    base: { authorize: (req: CapabilityRequest) => grants.authorize(req) },
  });
  const authorizer = {
    authorize(req: CapabilityRequest) {
      requests.push(req);
      return inner.authorize(req);
    },
  };
  const observe: EffectMiddleware = (ctx, input, next) => {
    contexts.push(ctx);
    return next(input);
  };

  const effects = new EffectRuntime([observe], { authorizer });
  effects.register(LLM_TOOL_ID, llm.effect);

  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    principalResolver,
    onWarn: () => {},
  });
  const planner = createPlanner(opts);

  const define = (id: string): FlowDefinition<Json, Json> => ({
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  });

  // The real `ctx` IS the planner's DecideContext: compose runs ONE ctx.decide, whose scope the
  // model factory reaches the LLM through. The plan is the recorded decision.
  const triage: FlowRunner<Json, Json> = async (ctx) => {
    const plan = await planner.compose({ intent, catalog: triageCatalog, capabilities }, ctx);
    await ctx.suspend({ on: "reviewed" });
    return { nodes: plan.ops.length, findings: plan.findings.length, modelId: plan.report.modelId };
  };

  // checkPlannerConformance driven by the REAL ctx. The probe reads what the authorizer saw, so
  // "every scope call carries the deciding execution" is checked against the runtime, not a fake.
  const conformance: FlowRunner<Json, Json> = async (ctx) => {
    const findings = await checkPlannerConformance(planner, {
      intent,
      catalog: triageCatalog,
      capabilities,
      meta: { author: "example", createdAt: "2026-10-04T00:00:00Z", sourceKind: "example" },
      revision: { text: "add an insight explaining the growth" },
      ctx,
      modelCalls: () => llm.state.calls,
      // reach contract (L32/G23): the planner's declaration must cover every tool the probe saw
      checkReach: true,
      scopeProbe: {
        identity: ctx.executionId,
        calls: () =>
          requests
            .filter((r) => r.executionId === ctx.executionId)
            .map((r) => ({ identity: r.executionId, toolId: r.toolId })),
      },
    });
    return { findings } as unknown as Json;
  };

  // Two decisions, each making the SAME model request twice through its own factory-built stack.
  // The memo dedupes within a decider; nothing is shared between deciders.
  const memoProbe: FlowRunner<Json, Json> = async (ctx) => {
    const request = { system: "probe", messages: [{ role: "user", content: "same" }] };
    for (const id of ["first", "second"]) {
      await ctx.decide(id, async (scope) => {
        const model = modelFor(scope);
        await model.complete(request as never);
        await model.complete(request as never);
        return id;
      });
    }
    return {};
  };

  // Several DISTINCT requests at once inside one decider: the limiter caps what is in flight.
  const fanOut: FlowRunner<Json, Json> = async (ctx) => {
    await ctx.decide("fan-out", async (scope) => {
      const model = modelFor(scope);
      await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          model.complete({
            system: "probe",
            messages: [{ role: "user", content: `q${n}` }],
          } as never)
        )
      );
      return "done";
    });
    return {};
  };

  // The test-side half of declared reach: run the planner against a RECORDING ctx and keep what it
  // actually reached, so a test can compare it with the declaration (`assertReachMatches`).
  const recorder = recordReach();
  const recorded: FlowRunner<Json, Json> = async (ctx) => {
    await planner.compose({ intent, catalog: triageCatalog, capabilities }, recorder.ctx(ctx));
    return {};
  };

  runtime.registerFlow(define(RECORDED_FLOW), recorded);
  runtime.registerFlow(define(MEMO_FLOW), memoProbe);
  runtime.registerFlow(define(FANOUT_FLOW), fanOut);
  runtime.registerFlow(define(TRIAGE_FLOW), triage);
  runtime.registerFlow(define(UNGRANTED_FLOW), triage);
  runtime.registerFlow(define(CONFORMANCE_FLOW), conformance);

  return {
    runtime,
    eventStore,
    /**
     * Widen the flow-keyed grant table: later starts of `workflowId` may use the LLM effect.
     * A DEMO/TEST affordance: in production the grant table is policy/config, and `grant()` stands
     * in for an operator changing it.
     */
    grant: (workflowId: string) => {
      granted[workflowId] = [LLM_TOOL_ID];
      grants = new GrantTable(granted);
    },
    /**
     * A second runtime over the SAME stores and effects: what a process restart looks like. It
     * registers only the triage flow (the one the resume test needs).
     */
    freshRuntime: () => {
      const rt = new WorkflowRuntime({
        eventStore,
        snapshotStore,
        effectRuntime: effects,
        principalResolver,
        onWarn: () => {},
      });
      rt.registerFlow(define(TRIAGE_FLOW), triage);
      return rt;
    },
    /** The planner a flow hands `ctx` to: the object `verify.reach` maps `planner` to. */
    planner,
    /** The triage runner, so its SOURCE can be analysed for what it hands `ctx` to. */
    triageRunner: triage,
    reachRecorder: recorder,
    llm: llm.state,
    requests,
    contexts,
    definitions: {
      [TRIAGE_FLOW]: define(TRIAGE_FLOW),
      [UNGRANTED_FLOW]: define(UNGRANTED_FLOW),
      [CONFORMANCE_FLOW]: define(CONFORMANCE_FLOW),
      [MEMO_FLOW]: define(MEMO_FLOW),
      [FANOUT_FLOW]: define(FANOUT_FLOW),
      [RECORDED_FLOW]: define(RECORDED_FLOW),
    },
    eventTypes: async (executionId: string) =>
      (await eventStore.read(executionId)).map((e) => e.eventType),
  };
}
export type TriageApp = ReturnType<typeof createTriageApp>;
