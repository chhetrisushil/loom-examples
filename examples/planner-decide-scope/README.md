# planner-decide-scope

A planner that decides **through loom's decide scope**. A support-ticket triage flow asks a
loom-ui `ReferencePlanner` to compose an Experience; the planner's model reaches the LLM *effect*
through `scopeInvoker(scope)`, so the call runs **as the flow that asked**. Nothing here is
specific to any one app: it is the pattern for any planner whose model call must be authorized,
attributed and bounded like the rest of the flow.

```
pnpm --filter @loom/planner-decide-scope start   # prints the stamped identity + grant/deny/replay
pnpm --filter @loom/planner-decide-scope test    # the tests ARE the proof
```

## The pattern

```ts
// src/planner.ts — a factory, called once per decision with THAT decider's scope
const modelFor = (scope: DecideScope): PlannerModel => {
  const invoker = limitInvoker(scopeInvoker(scope), 2);
  return { complete: (req) => invoker.invokeTransient("llm.complete", req) };
};
new ReferencePlanner({ model: modelFor, modelId: "fake-llm@1" });

// src/app.ts — the real loom ctx IS the DecideContext
const plan = await planner.compose({ intent, catalog, capabilities }, ctx);
```

`ctx.decide` hands its decider a `DecideScope`; a call through `scope.invokeTransient` is still
transient (the plan is the one record in the log) but is stamped with the deciding execution:

| What the scope buys | Where this example shows it |
|---|---|
| **Identity**: workflowId + executionId reach the authorizer and middleware | test 1 (`requests[0]`, `contexts[0]`) |
| **Delegation**: the full principal (tenant, actor, delegation token) rides along | test 1; the authorizer is a `DelegationAuthorizer` over a flow-keyed `GrantTable` |
| **Flow-scoped grants**: a flow without the grant cannot use the effect, fails with `CapabilityDeniedError`, and re-plans once the grant is widened | test 2 |
| **Bounded concurrency**: `limitInvoker` caps in-flight model calls per decider | LIMIT test |
| **Cancellation**: cancelling mid-call rejects with `ExecutionCancelledError`, nothing recorded | CANCEL test |
| **Budget admission**: composed with the execution's, not the runtime's | loom's own `decideTransientIdentity.test.ts`; not re-proved here |
| **Replay**: the decision is served from the log, the model is not called | test 3 |

## Rules the example follows

- **Build the invoker stack per decider, inside the factory.** `scopeInvoker` fixes the identity,
  so a limiter (or anything stateful) shared across scopes would couple executions.
- **No `memoInvoker` for an LLM effect.** It dedupes only `mcp.invoke`; every other effect passes
  through uncached, so it is inert here (the NO MEMO test pins that identical requests each run).
  If you memoize MCP calls, build it per decider too: it keys on everything but the signal.
- **Never configure `principal` (or `as` / `resources`) on anything layered over a
  `scopeInvoker`**, including hydration. The scope *is* the identity; the adapter rejects those
  options rather than silently running as someone else.
- Register the LLM as an **effect** and let the model reach it only via the scope. A model that
  closes over an `EffectRuntime` directly would bypass the stamped identity.

## Declaring and wiring reach

The planner cannot know which tool its `model` factory calls, so the app that wrote the factory
declares it, and verify is told which object a flow's `planner` is:

```ts
// src/planner.ts: the declaration rides on the planner instance (Symbol.for("loom.verify.reach"))
new ReferencePlanner({ model: modelFor, modelId: "fake-llm@1", reach: { transient: [LLM_TOOL_ID] } });

// src/verify.ts: map the callee text used in the flow source to that real object
defineConfig({ ..., checks: { verify: { reach: { planner } } } });
```

Declared tools then join the flow's reachable effects, so `capability-compat` checks the flow's
grant for `llm.complete`, `replay-safety` refuses it if it were registered `journaled`, and an
unregistered tool is a warn. A declaration is a claim about the library, so it is tested on both
sides: `checkReach: true` in the planner conformance run, and `recordReach()` +
`assertReachMatches()` against a real run. `src/verify.ts` reads the runner's source with
`analyzeRunnerReach` for brevity; a project gets the same input from the compiler's manifest.

## What the tests prove

1. **Stamped identity.** The authorizer and the middleware see `llm.complete` with `workflowId`,
   `executionId` and the full delegated principal; the log holds one `DECISION_RECORDED` and no
   `STEP_STARTED`.
2. **Deny, then re-plan.** The same flow body under a flow id with no grant is refused by the
   authorizer as the deciding execution; the execution FAILS with `CapabilityDeniedError`, the
   effect never runs and no `DECISION_RECORDED` is left. The failed execution is terminal; after
   the grant is widened (`app.grant()`, a stand-in for an operator changing policy/config), a NEW
   start of the flow decides and calls the model (nothing stale to replay).
3. **Replay.** Suspend, then resume (also on a FRESH `WorkflowRuntime` over the same stores):
   the model count stays at 1 and no second authorizer call.
4. **Conformance.** `checkPlannerConformance` with a `scopeProbe` over the *real* runtime (the
   probe reads what the authorizer saw, and each call carries its `toolId`) and `checkReach: true`
   returns zero findings: compose and revise each call through the scope once, as the deciding
   execution, a second compose calls nothing, and the planner's declared reach covers every tool
   seen. The same run over a planner built without `reach` yields `reach-undeclared`.
5. **Declared reach for verify (L31 + L32 + G23).** The compiler's `analyzeRunnerReach` counts a
   literal `scope.invokeTransient` written in the flow, and records `planner.compose(.., ctx)` as
   an escape. Driving the real `defineConfig` + `app.verify()` over the example's own flow:
   (a) with no `verify.reach` mapping the hand-off is an unresolved `capability-compat` warn
   naming `verify.reach["planner"]`; (b) with `reach: { planner }` the LLM tool is counted: clean
   when the flow is granted, a `capability-compat` error when it is not; (c) a planner built
   without `reach` stays unresolved even when mapped.
   Also: a RECORDING ctx (`recordReach()`) run through the planner sees `transient:
   ["llm.complete"]`, and `assertReachMatches` accepts the declaration and refuses an empty one.
6. **Limit / no memo / cancel.** Five distinct concurrent requests peak at 2 in flight; identical
   requests are not deduped; cancelling mid-call gives `ExecutionCancelledError` (`kind: "cancel"`).

## Gaps found while building this (reported, not worked around)

- **Closed (loom-ui G22): a denial used to become a durable failed plan.** `ReferencePlanner`
  now rethrows control-plane errors (`CapabilityDeniedError`, quota, abort, cancellation, ...)
  without retry or recording, so a denial fails the execution and a re-run after fixing the grant
  decides afresh (test 2). Only model/parse failures become findings.
