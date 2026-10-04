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

## What the tests prove

1. **Stamped identity.** The authorizer and the middleware see `llm.complete` with `workflowId`,
   `executionId` and the full delegated principal; the log holds one `DECISION_RECORDED` and no
   `STEP_STARTED`.
2. **Deny, then re-plan.** The same flow body under a flow id with no grant is refused by the
   authorizer as the deciding execution; the execution FAILS with `CapabilityDeniedError`, the
   effect never runs and no `DECISION_RECORDED` is left. After the grant is widened, a fresh run
   decides and calls the model (nothing stale to replay).
3. **Replay.** Suspend, then resume (also on a FRESH `WorkflowRuntime` over the same stores):
   the model count stays at 1 and no second authorizer call.
4. **Conformance.** `checkPlannerConformance` with a `scopeProbe` over the *real* runtime (the
   probe reads what the authorizer saw) returns zero findings: compose and revise each call
   through the scope once, as the deciding execution, and a second compose calls nothing.
5. **Verify (L31).** `analyzeRunnerReach` counts a literal `scope.invokeTransient` written in the
   flow, but not the one made by a planner the flow merely hands `ctx` to (see gaps).
6. **Limit / no memo / cancel.** Five distinct concurrent requests peak at 2 in flight; identical
   requests are not deduped; cancelling mid-call gives `ExecutionCancelledError` (`kind: "cancel"`).

## Gaps found while building this (reported, not worked around)

- **Closed (loom-ui G22): a denial used to become a durable failed plan.** `ReferencePlanner`
  now rethrows control-plane errors (`CapabilityDeniedError`, quota, abort, cancellation, ...)
  without retry or recording, so a denial fails the execution and a re-run after fixing the grant
  decides afresh (test 2). Only model/parse failures become findings.
- **`@loom/verify` cannot see a planner's scope call.** A flow that hands `ctx` to a library
  planner is neither counted nor reported unresolved (only the `{ decide: ctx.decide }` idiom is),
  so `capability-compat` / `effect-class` see a flow that reaches no tool.
  Test 5 pins this; loom L32 (PR #483, verify sees a `ctx` handed to a declared library) will
  flip it, at which point update that test and this note.
