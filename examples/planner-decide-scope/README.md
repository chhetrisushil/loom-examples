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
  const invoker = memoInvoker(limitInvoker(scopeInvoker(scope), 2));
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
| **Flow-scoped grants**: a flow without the grant cannot use the effect | test 2 |
| **Cancellation + budget admission**: composed with the execution's, not the runtime's | loom's own `decideTransientIdentity.test.ts`; not re-proved here |
| **Replay**: the decision is served from the log, the model is not called | test 3 |

## Rules the example follows

- **Build the invoker stack per decider, inside the factory.** `scopeInvoker` fixes the identity,
  and `memoInvoker` keys on everything *but* the signal, so a memo (or limiter) shared across
  scopes could serve one execution another's result and skip its authorization.
- **Never configure `principal` (or `as` / `resources`) on anything layered over a
  `scopeInvoker`**, including hydration. The scope *is* the identity; the adapter rejects those
  options rather than silently running as someone else.
- Register the LLM as an **effect** and let the model reach it only via the scope. A model that
  closes over an `EffectRuntime` directly would bypass the stamped identity.

## What the tests prove

1. **Stamped identity.** The authorizer and the middleware see `llm.complete` with `workflowId`,
   `executionId` and the full delegated principal; the log holds one `DECISION_RECORDED` and no
   `STEP_STARTED`.
2. **Deny.** The same flow body registered under a flow id with no grant is refused by the
   authorizer as the deciding execution; the effect never runs.
3. **Replay.** Suspend, then resume: the model count stays at 1 and no second authorizer call.
4. **Conformance.** `checkPlannerConformance` with a `scopeProbe` over the *real* runtime (the
   probe reads what the authorizer saw) returns zero findings: compose and revise each call
   through the scope once, as the deciding execution, and a second compose calls nothing.
5. **Verify (L31).** `analyzeRunnerReach` counts a literal `scope.invokeTransient` written in the
   flow, but not the one made by a planner the flow merely hands `ctx` to (see gaps).

## Gaps found while building this (reported, not worked around)

- **A denial becomes a durable failed plan.** `ReferencePlanner` catches *every* model error,
  including `CapabilityDeniedError`, as a `model-error` finding, retries (the authorizer is asked
  twice) and records the empty plan as the decision. The execution suspends/continues instead of
  failing, and fixing the grant later does not re-plan because the decision id is unchanged.
  Test 2 pins the current behaviour.
- **`@loom/verify` cannot see a planner's scope call.** A flow that hands `ctx` to a library
  planner is neither counted nor reported unresolved (only the `{ decide: ctx.decide }` idiom is),
  so `capability-compat` / `effect-class` see a flow that reaches no tool.
