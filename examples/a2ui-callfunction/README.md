# a2ui-callfunction — A2UI bidirectional RPC over two grains

Drives a **client-side function** from a Loom flow using the A2UI `callFunction`
surface (`@loom/plugin-a2ui`), two ways — and shows why **no client-side effect
runtime is needed** to stay replay-deterministic.

The client runs the function elsewhere, but only its *recorded result* re-enters
the orchestrator's log (a resume event, or a `STEP_COMPLETED` output); on replay
the result is served from the fold and the client is never re-invoked. The only
discipline the client needs is the **K9 delivery contract projected onto the
transport**: a *deterministic* `callId` (`executionId:stepId`, never random) plus
at-least-once tolerance. See loom ADR 0070.

## The two grains

| Grain | Client function | Mechanism | When |
| --- | --- | --- | --- |
| **A** | `getLocale` (read / idempotent) | `ctx.suspend` gate → client answers → `runtime.resume` | reads; no live socket |
| **B** | `confirmSubmit` (side effect / non-idempotent) | delegated `a2ui.callFunction` effect via `ctx.execute` | mutations; needs in-doubt safety |

Grain B declares the effect `idempotent: false`, so a **crash mid-call** parks
the execution at `EFFECT_INDOUBT` for an operator verdict instead of blindly
re-invoking the client function — the exact "did the client function actually
run?" resolution.

## Run it

```
pnpm --filter @loom/a2ui-callfunction start   # headless narrative of both grains
pnpm --filter @loom/a2ui-callfunction test    # assertions incl. the crash → in-doubt proof
```

## What the test proves

1. **Round-trip** — grain A resumes the gate with the client's read; grain B then
   runs inline as a delegated effect; the flow reaches `status=done`. Grain B
   fires **exactly once**, keyed by `executionId:confirm-submit`, and its answer
   is folded into the step frame.
2. **Crash → in-doubt** — the grain-B client hangs (a simulated crash), leaving
   `confirm-submit` durably `running`. A **fresh app over the same event +
   snapshot stores** re-dispatches (`EXECUTION_RECOVERED`); because the effect is
   `idempotent: false`, the kernel **parks at `EFFECT_INDOUBT` without calling the
   client**. An operator verdict (`completed-with-result`) then completes the
   execution — still without re-firing the client.

## Two things the `callId` must carry

Neither is a replay/determinism risk (replay stays a pure fold), but both are
correctness obligations — see loom ADR 0070:

- **Call-site-unique, not just deterministic (grain A).** A suspend gate has no
  step id, so a callId derived from the function name (`${executionId}:getLocale`)
  would collide if the same function were called twice. This example tags the
  call site (`${executionId}:getLocale#1`), mirroring the step-identity rule.
  Grain B is immune — `ctx.idempotencyKey` (`executionId:stepId`) is unique per
  `ctx.execute`.
- **Dedup on the client for side effects (grain B).** Effects are at-least-once,
  so a retry / crash-recovery may re-issue the same `callId`; a mutating client
  function must dedup on it. A pure read (grain A `getLocale`) needs no dedup.

## Files

- `src/flow.ts` — the checkout flow: grain-A suspend-gate + grain-B `ctx.execute`.
- `src/client.ts` — an in-process A2UI client (offline stand-in for a browser) and
  the grain-B transport; the plugin stays transport-agnostic.
- `src/catalog.ts` — the A2UI catalog `functions` vocabulary (`defineFunction`).
- `src/app.ts` — `defineConfig` wiring the grain-B effect via `registerEffects`;
  `storage` is a parameter so the test can share stores across two app instances.
- `src/main.ts` — the headless driver.
- `test/a2ui-callfunction.test.ts` — the assertions above.

Egress + inbound actions are covered by the sibling `a2ui-egress` example; this
one adds the bidirectional `callFunction` leg. Continuous two-way *binding sync*
remains out of scope.
