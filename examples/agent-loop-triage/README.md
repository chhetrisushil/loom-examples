# agent-loop-triage

A support-ticket triage agent on the **canonical `agentLoop$`** ([loom ADR 0121](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0121-one-canonical-agent-loop.md), R10).
Offline and headless: a scripted model that reads the transcript with `textOf`, in-memory stores, no keys.
It does not use the deprecated `AgentRunner` / `agentStep$`.

```
pnpm --filter @loom/agent-loop-triage start   # narrated trace
pnpm --filter @loom/agent-loop-triage test    # the tests ARE the proof
```

| What it shows | Where |
|---|---|
| **The capability ring picks the model.** A `ReasoningRuntime` with two routes and a `Router`; `registerReasoningRoutes` registers one effect per route (`model:<route>`), the router's choice is a *recorded decision* (`reason:<loop>#turn:<i>:route`), and the flow must be granted each model. Cheap-first; the deep model once a tool has failed. A flow not granted `model:triage-deep` fails with `CapabilityDeniedError` before the provider is touched | `src/model.ts` `triageRouter`, `src/world.ts` |
| **Parallel tools, failure as feedback.** `parallelTools: true`: three lookups run in one scope; the flaky carrier API throws and the model is shown an `isError` tool result, not a dead run | test "tool failure is feedback" |
| **The terminal denylist still holds.** A `QuotaExceededError` (and an authority denial) is *not* fed back: the run fails, the model is never asked again | tests "a terminal error class still propagates", "so does an authority denial" |
| **Per-call outcome decisions.** Each call records `<loop>#turn:<i>:tool:<j>:outcome` (`source: "agent-outcome"`); a failure the model consumed is served on replay, never re-run (the carrier API would succeed now, yet ran once) | test "a consumed failure is not re-run on replay" |
| **Approval across a restart.** `requireApproval` parks the refund; a *fresh* runtime over the same store resumes with `answerApproval`; no completed tool re-runs, one new model call | `src/scenario.ts` `runActs`, test "approval across a process restart" |
| **`writeBack` recall.** `writeBack: { toolId, unless }` (the ring, plus a fork guard): ticket 1002 for the same customer recalls ticket 1001 and calls no tool. Bare `writeBack: true` (or `{}`) throws `AgentLoopConfigError`; so does a response cache without `cacheScope` | test "config errors" |

Things worth knowing:

- `requireApproval` is an **auto-approve policy**: it answers "may this call proceed on its own?", and `false` *parks*. `requireApproval: (c) => c.name !== "issue_refund"` parks only the refund.
- Ticket 1001 saw a tool error, so its answer is written to memory **tainted** (ADR 0085) and recalled fenced as data, never in an instruction position.
- The ring path bypasses the response cache; the `cacheScope` requirement bites only on the direct path (`reasoning` without `reasoningToolId`, which also logs the `LOOM_AGENT_RING` warning you see in the tests).
- The one place a failed tool runs twice is the documented crash window: the process dies between the step's `STEP_FAILED` and the outcome record. Deleting the outcome decisions from the log before the restart reproduces it (the carrier runs twice), which is how the replay test was revert-checked.

Layout: `model.ts` (router, scripted model), `world.ts` (tools, ring wiring, `boot()` = one process over a shared `Backend`), `scenario.ts` (the acts), `main.ts` (narration).
