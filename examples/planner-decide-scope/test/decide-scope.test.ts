import { analyzeRunnerReach } from "@loom/compiler";
import { CapabilityDeniedError } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_FLOW,
  TRIAGE_FLOW,
  UNGRANTED_FLOW,
  createTriageApp,
  delegatedPrincipal,
} from "../src/app";
import { LLM_TOOL_ID } from "../src/llm";

interface PlanChoice {
  ops: unknown[];
  findings: { code: string; message: string }[];
}

const startTriage = (app: ReturnType<typeof createTriageApp>, flow: string, executionId: string) =>
  app.runtime.start(
    app.definitions[flow as typeof TRIAGE_FLOW],
    {},
    { executionId, principal: delegatedPrincipal }
  );

describe("the planner decides through loom's decide scope", () => {
  it("the planner's LLM call is authorized and observed AS the deciding execution, with the delegated principal", async () => {
    const app = createTriageApp();
    const h = await startTriage(app, TRIAGE_FLOW, "t1");
    await h.waitForSuspend();

    expect(app.llm.calls).toBe(1);
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0]).toMatchObject({
      toolId: LLM_TOOL_ID,
      workflowId: TRIAGE_FLOW,
      executionId: "t1",
      principal: delegatedPrincipal,
    });
    // the delegation token and the actor survive the hop, not just the tenant
    expect(app.requests[0]?.principal?.delegation).toEqual(delegatedPrincipal.delegation);
    expect(app.requests[0]?.principal?.actor).toBe("alice");
    // the middleware chain sees the same identity
    expect(app.contexts[0]).toMatchObject({
      workflowId: TRIAGE_FLOW,
      executionId: "t1",
      principal: delegatedPrincipal,
    });
    // transient: the plan is the ONE record the call left in the log
    const types = await app.eventTypes("t1");
    expect(types.filter((t) => t === "DECISION_RECORDED")).toHaveLength(1);
    expect(types).not.toContain("STEP_STARTED");
  });

  it("NEGATIVE: a flow WITHOUT the grant is DENIED by the authorizer and the model never runs", async () => {
    const app = createTriageApp();
    const h = await startTriage(app, UNGRANTED_FLOW, "t2");
    const state = await h.waitForSuspend();
    // The effect never ran: the denial is real enforcement, not an absent check.
    expect(app.llm.calls).toBe(0);
    // The authorizer WAS asked, as the deciding execution, and refused (twice: the planner retries).
    expect(app.requests.map((r) => [r.workflowId, r.executionId])).toEqual([
      [UNGRANTED_FLOW, "t2"],
      [UNGRANTED_FLOW, "t2"],
    ]);
    // GAP (loom-ui planner): ReferencePlanner turns the CapabilityDeniedError into a `model-error`
    // finding and RECORDS the empty plan as the decision, instead of letting the denial fail the
    // execution. The kernel raised CapabilityDeniedError; what the flow sees is a failed plan.
    const decisions = state.variables._decisions as Record<string, { choice: PlanChoice }>;
    const [recorded] = Object.values(decisions);
    expect(recorded?.choice.ops).toEqual([]);
    expect(recorded?.choice.findings.map((f) => f.code)).toEqual(["model-error", "plan-failed"]);
    expect(recorded?.choice.findings[0]?.message).toMatch(
      /Capability denied: effect "llm.complete"/
    );
    expect(recorded?.choice.findings[0]?.message).toMatch(/has no grants/);
    expect(await app.eventTypes("t2")).toContain("DECISION_RECORDED");
  });

  it("REPLAY: resuming serves the plan from the log; the model is not called again", async () => {
    const app = createTriageApp();
    const h = await startTriage(app, TRIAGE_FLOW, "t3");
    await h.waitForSuspend();
    expect(app.llm.calls).toBe(1);

    const done = await (
      await app.runtime.resume("t3", { eventType: "reviewed", payload: {} })
    ).waitForCompletion();
    expect(app.llm.calls).toBe(1);
    expect(app.requests).toHaveLength(1);
    expect(done.status).toBe("completed");
    expect(done.variables._output).toMatchObject({ findings: 0, modelId: "fake-llm@1" });
    expect(done.variables._output).toHaveProperty("nodes", expect.any(Number));
    expect((await app.eventTypes("t3")).filter((t) => t === "DECISION_RECORDED")).toHaveLength(1);
  });

  it("checkPlannerConformance with a scopeProbe over the real runtime passes with zero findings", async () => {
    const app = createTriageApp();
    const h = await app.runtime.start(
      app.definitions[CONFORMANCE_FLOW],
      {},
      { executionId: "c1", principal: delegatedPrincipal }
    );
    const done = await h.waitForCompletion();
    expect((done.variables._output as { findings: unknown[] }).findings).toEqual([]);
    // the probe was not vacuous: compose and revise each called through the scope once
    expect(app.requests.filter((r) => r.executionId === "c1")).toHaveLength(2);
    expect(app.llm.calls).toBe(2);
  });

  it("verify (L31): a scope call written in the flow is counted; the same call made by a planner the flow hands `ctx` to is INVISIBLE", () => {
    const direct = analyzeRunnerReach(`
      const r = async (ctx) => {
        await ctx.decide("plan", (scope) => scope.invokeTransient("llm.complete", {}));
      };
    `);
    expect(direct.steps).toEqual([{ toolId: "llm.complete", viaDecider: true }]);

    // This is the shape of src/app.ts: the decider lives in the planner LIBRARY. Nothing is counted
    // AND nothing is reported unresolved (only the `{ decide: ctx.decide }` idiom is), so
    // capability-compat / effect-class see a flow that reaches no tool. GAP, reported not worked
    // around: if this starts returning llm.complete or an unresolved entry, update the README.
    const viaPlanner = analyzeRunnerReach(`
      const r = async (ctx) => {
        const plan = await planner.compose({ intent, catalog, capabilities }, ctx);
      };
    `);
    expect(viaPlanner.steps).toEqual([]);
    expect(viaPlanner.unresolved).toEqual([]);
  });
});
