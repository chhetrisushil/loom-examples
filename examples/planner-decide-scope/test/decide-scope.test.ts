import { readPlannerReach } from "@loom-ui/planner";
import { analyzeRunnerReach } from "@loom/compiler";
import { CapabilityDeniedError } from "@loom/effect-runtime";
import { assertReachMatches } from "@loom/verify";
import { ExecutionCancelledError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_FLOW,
  FANOUT_FLOW,
  MEMO_FLOW,
  RECORDED_FLOW,
  TRIAGE_FLOW,
  UNGRANTED_FLOW,
  createTriageApp,
  delegatedPrincipal,
} from "../src/app";
import { LLM_TOOL_ID } from "../src/llm";
import { verifyTriage } from "../src/verify";

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

  it("NEGATIVE: a flow WITHOUT the grant FAILS with CapabilityDeniedError, records no plan, and a re-run after widening the grant re-plans", async () => {
    const app = createTriageApp();
    const h = await startTriage(app, UNGRANTED_FLOW, "t2");
    // G22: the planner rethrows a control-plane error, so the denial fails the execution.
    const failure = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(failure).toBeInstanceOf(CapabilityDeniedError);
    expect((failure as Error).name).toBe("CapabilityDeniedError");
    // The effect never ran: the denial is real enforcement, not an absent check.
    expect(app.llm.calls).toBe(0);
    // The authorizer WAS asked, as the deciding execution (no pinned retry count).
    expect(app.requests.length).toBeGreaterThanOrEqual(1);
    for (const r of app.requests) {
      expect(r).toMatchObject({
        workflowId: UNGRANTED_FLOW,
        executionId: "t2",
        toolId: LLM_TOOL_ID,
      });
    }
    // Nothing was recorded: no failed plan is left behind to be replayed.
    expect(await app.eventTypes("t2")).not.toContain("DECISION_RECORDED");

    // Fix the grant. A fresh start of the same flow decides afresh (no stale failed plan).
    app.grant(UNGRANTED_FLOW);
    const rerun = await startTriage(app, UNGRANTED_FLOW, "t2b");
    await rerun.waitForSuspend();
    expect(app.llm.calls).toBe(1);
    expect((await app.eventTypes("t2b")).filter((t) => t === "DECISION_RECORDED")).toHaveLength(1);
  });

  it("identical LLM requests are not coalesced, and nothing is shared across deciders or executions (memoInvoker only dedupes mcp.invoke, so the planner does not use it)", async () => {
    const app = createTriageApp();
    await (await startTriage(app, MEMO_FLOW, "m1")).waitForCompletion();
    // 2 decisions x 2 identical requests. A memo over llm.complete would give 2 (or 1 if shared);
    // it is a pass-through for non-MCP effects, so the stack deliberately omits it.
    expect(app.llm.calls).toBe(4);
    expect(app.requests.filter((r) => r.executionId === "m1")).toHaveLength(4);
    await (await startTriage(app, MEMO_FLOW, "m2")).waitForCompletion();
    expect(app.requests.filter((r) => r.executionId === "m2")).toHaveLength(4);
  });

  it("LIMIT: five distinct concurrent requests in one decider never exceed 2 in flight", async () => {
    const app = createTriageApp();
    await (await startTriage(app, FANOUT_FLOW, "f1")).waitForCompletion();
    expect(app.llm.calls).toBe(5);
    expect(app.llm.maxInflight).toBe(2);
  });

  it("CANCEL: cancelling while the LLM effect is in flight rejects with ExecutionCancelledError and records no plan", async () => {
    const app = createTriageApp();
    let release!: () => void;
    app.llm.gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await startTriage(app, TRIAGE_FLOW, "x1");
    const outcome = h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    while (app.llm.inflight === 0) await new Promise((r) => setTimeout(r, 1));
    await app.runtime.cancel("x1", "stop");
    release();
    const err = await outcome;
    expect(err).toBeInstanceOf(ExecutionCancelledError);
    expect((err as ExecutionCancelledError).kind).toBe("cancel");
    expect(await app.eventTypes("x1")).not.toContain("DECISION_RECORDED");
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

  it("REPLAY across a restart: a FRESH WorkflowRuntime over the same stores serves the plan from the log", async () => {
    const app = createTriageApp();
    await (await startTriage(app, TRIAGE_FLOW, "t4")).waitForSuspend();
    expect(app.llm.calls).toBe(1);

    const done = await (
      await app.freshRuntime().resume("t4", { eventType: "reviewed", payload: {} })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
    expect(app.llm.calls).toBe(1);
    expect(app.requests).toHaveLength(1);
    expect((await app.eventTypes("t4")).filter((t) => t === "DECISION_RECORDED")).toHaveLength(1);
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

  it("conformance with checkReach: the planner's declaration covers every tool the probe saw, and a planner WITHOUT one is reach-undeclared", async () => {
    // Positive: the conformance test above runs with checkReach: true and is clean. Here, the
    // negative: the same flow over a planner built without `reach`.
    const bare = createTriageApp({ reach: false });
    const h = await bare.runtime.start(
      bare.definitions[CONFORMANCE_FLOW],
      {},
      { executionId: "c2", principal: delegatedPrincipal }
    );
    const done = await h.waitForCompletion();
    const findings = (done.variables._output as { findings: { code: string }[] }).findings;
    expect(findings.map((f) => f.code)).toEqual(["reach-undeclared"]);
  });

  it("assertReachMatches: what the planner ACTUALLY reached through a recording ctx is covered by its declaration", async () => {
    const app = createTriageApp();
    await (
      await app.runtime.start(
        app.definitions[RECORDED_FLOW],
        {},
        { executionId: "r1", principal: delegatedPrincipal }
      )
    ).waitForCompletion();
    expect(app.reachRecorder.recorded).toEqual({ run: [], transient: [LLM_TOOL_ID] });
    const declared = readPlannerReach(app.planner);
    expect(declared).toEqual({ transient: [LLM_TOOL_ID] });
    expect(() => assertReachMatches(declared ?? {}, app.reachRecorder.recorded)).not.toThrow();
    // not vacuous: a declaration that omits the tool is refused
    expect(() => assertReachMatches({ transient: [] }, app.reachRecorder.recorded)).toThrow(
      /transient tool "llm\.complete" ran but is not declared/
    );
  });

  it("verify (L31 + L32): a scope call written in the flow is counted; the call made by a planner the flow hands `ctx` to is an unresolved warn until `verify.reach` maps it", () => {
    const direct = analyzeRunnerReach(`
      const r = async (ctx) => {
        await ctx.decide("plan", (scope) => scope.invokeTransient("llm.complete", {}));
      };
    `);
    expect(direct.steps).toEqual([{ toolId: "llm.complete", viaDecider: true }]);

    // The shape of src/app.ts: the decider lives in the planner LIBRARY. The compiler records the
    // hand-off as an escape instead of dropping it.
    const viaPlanner = analyzeRunnerReach(`
      const r = async (ctx) => {
        const plan = await planner.compose({ intent, catalog, capabilities }, ctx);
      };
    `);
    expect(viaPlanner.steps).toEqual([]);
    expect(viaPlanner.escapes).toHaveLength(1);
  });

  it("verify (a): without the mapping, the REAL flow's hand-off is an unresolved warn naming the key to add", () => {
    const app = createTriageApp();
    const report = verifyTriage(app, { mapReach: false, grantLlm: true });
    const warns = report.findings.filter(
      (f) => f.rule === "capability-compat" && f.severity === "warn"
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain("ctx handed to planner.compose");
    expect(warns[0]?.message).toContain('verify.reach["planner"]');
  });

  it("verify (b): with `verify.reach: { planner }` the LLM tool is counted against the flow's grants (clean when granted, capability-compat ERROR when not)", () => {
    const granted = verifyTriage(createTriageApp(), { mapReach: true, grantLlm: true });
    expect(granted.findings.filter((f) => f.severity !== "info")).toEqual([]);
    // counted, not merely quiet: the same mapping now FAILS the flow that lacks the grant
    const denied = verifyTriage(createTriageApp(), { mapReach: true, grantLlm: false });
    const errors = denied.findings.filter(
      (f) => f.rule === "capability-compat" && f.severity === "error"
    );
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain(LLM_TOOL_ID);
    expect(denied.ok).toBe(false);
  });

  it("verify (c): a planner built WITHOUT `reach` stays unresolved even when mapped (an empty claim is no claim)", () => {
    const bare = createTriageApp({ reach: false });
    const report = verifyTriage(bare, { mapReach: true, grantLlm: true });
    const warns = report.findings.filter(
      (f) => f.rule === "capability-compat" && f.severity === "warn"
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('verify.reach["planner"]');
  });

  it("verify (d): a declared tool registered `journaled` is a replay-safety ERROR naming the declarer; without the mapping nothing flags it", () => {
    const mapped = verifyTriage(createTriageApp(), {
      mapReach: true,
      grantLlm: true,
      llm: "journaled",
    });
    const errs = mapped.findings.filter(
      (f) => f.rule === "replay-safety" && f.severity === "error"
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain(LLM_TOOL_ID);
    expect(errs[0]?.message).toContain("declared by");
    expect(errs[0]?.message).toContain("planner");
    expect(mapped.ok).toBe(false);
    // fails without the reach mapping: the journaled effect is invisible to the rule
    const unmapped = verifyTriage(createTriageApp(), {
      mapReach: false,
      grantLlm: true,
      llm: "journaled",
    });
    expect(unmapped.findings.filter((f) => f.rule === "replay-safety")).toEqual([]);
  });

  it("verify (e): a declared tool that is NOT registered is a warn, not a silent pass; without the mapping there is no such finding", () => {
    const mapped = verifyTriage(createTriageApp(), {
      mapReach: true,
      grantLlm: true,
      llm: "unregistered",
    });
    const hits = mapped.findings.filter(
      (f) => f.severity === "warn" && JSON.stringify(f).includes(LLM_TOOL_ID)
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const unmapped = verifyTriage(createTriageApp(), {
      mapReach: false,
      grantLlm: true,
      llm: "unregistered",
    });
    expect(unmapped.findings.filter((f) => JSON.stringify(f).includes(LLM_TOOL_ID))).toEqual([]);
  });
});
