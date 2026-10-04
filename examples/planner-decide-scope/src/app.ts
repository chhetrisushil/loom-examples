import { checkPlannerConformance } from "@loom-ui/planner";
import type { FlowDefinition } from "@loom/core";
import {
  type CapabilityRequest,
  DelegationAuthorizer,
  type EffectContext,
  type EffectMiddleware,
  EffectRuntime,
  GrantTable,
  signDelegation,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, WorkflowRuntime } from "@loom/workflow-runtime";
import { z } from "zod";
import { capabilities, triageCatalog } from "./catalog";
import { LLM_TOOL_ID, fakeLlm } from "./llm";
import { createPlanner } from "./planner";

type Json = Record<string, unknown>;
const io = z.object({}).passthrough() as z.ZodSchema<Json>;

export const TRIAGE_FLOW = "ticket-triage";
export const UNGRANTED_FLOW = "ticket-triage-ungranted";
export const CONFORMANCE_FLOW = "planner-conformance";
const SECRET = "example-delegation-secret";

/** The principal a request arrives with: a tenant, an actor, and a token attenuated to the LLM effect. */
export const delegatedPrincipal = {
  tenant: "acme",
  actor: "alice",
  delegation: signDelegation(SECRET, "alice", [LLM_TOOL_ID]),
};

const intent = { objective: "Triage the billing queue", source: "user" as const };

export function createTriageApp() {
  const llm = fakeLlm();
  // What the effect runtime saw: the authorizer's request and the middleware's context, per call.
  const requests: CapabilityRequest[] = [];
  const contexts: EffectContext[] = [];

  // A flow-scoped grant (keyed by workflowId). DelegationAuthorizer also verifies the token, and
  // may only NARROW what the base grants. The recorder wraps it so the example can show what the
  // authorizer was asked; a production authorizer needs no recorder.
  const grants = new GrantTable({
    [TRIAGE_FLOW]: [LLM_TOOL_ID],
    [CONFORMANCE_FLOW]: [LLM_TOOL_ID],
  });
  const inner = new DelegationAuthorizer({ secret: SECRET, base: grants });
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
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const planner = createPlanner();

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
      scopeProbe: {
        identity: ctx.executionId,
        calls: () =>
          requests
            .filter((r) => r.executionId === ctx.executionId)
            .map((r) => ({ identity: r.executionId })),
      },
    });
    return { findings } as unknown as Json;
  };

  runtime.registerFlow(define(TRIAGE_FLOW), triage);
  runtime.registerFlow(define(UNGRANTED_FLOW), triage);
  runtime.registerFlow(define(CONFORMANCE_FLOW), conformance);

  return {
    runtime,
    eventStore,
    llm: llm.state,
    requests,
    contexts,
    definitions: {
      [TRIAGE_FLOW]: define(TRIAGE_FLOW),
      [UNGRANTED_FLOW]: define(UNGRANTED_FLOW),
      [CONFORMANCE_FLOW]: define(CONFORMANCE_FLOW),
    },
    eventTypes: async (executionId: string) =>
      (await eventStore.read(executionId)).map((e) => e.eventType),
  };
}
export type TriageApp = ReturnType<typeof createTriageApp>;
