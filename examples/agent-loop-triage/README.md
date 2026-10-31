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
| **Approval across a restart.** `needsApproval` parks the refund; a *fresh* runtime over the same store resumes with `answerApproval`; no completed tool re-runs, one new model call | `src/scenario.ts` `runActs`, test "approval across a process restart" |
| **`writeBack` recall.** `writeBack: { toolId, unless }` (the ring, plus a fork guard): ticket 1002 for the same customer recalls ticket 1001 and calls no tool. Bare `writeBack: true` (or `{}`) throws `AgentLoopConfigError`; so does a response cache without `cacheScope` | tests "config errors", "the fork guard" (`unless` true: nothing written, `#writeback:skip` recorded) |

Things worth knowing:

- `needsApproval` answers "does this call need a human?": `true` *parks*, so `needsApproval: (c) => c.name === "issue_refund"` parks only the refund. (It replaced the deprecated `requireApproval`, whose polarity was inverted.)
- Ticket 1001 saw a tool error, so its answer is written to memory **tainted** (ADR 0085) and recalled fenced as data, never in an instruction position (test "ticket 1001's answer is stored TAINTED": the memory entry `isTainted`, and ticket 1002's request carries it only inside `<untrusted-input>` in a `user` message). Because ticket 1002 recalled that tainted answer, its own answer is written back tainted too: taint follows recall, so a poisoned memory can't launder itself in one hop.
- The ring path bypasses the response cache; the `cacheScope` requirement bites only on the direct path (`reasoning` without `reasoningToolId`, which also logs the `LOOM_AGENT_RING` warning you see in the tests).
- The one place a failed tool runs twice is the documented crash window: the process dies between the step's `STEP_FAILED` and the outcome record. The NEGATIVE test "without the outcome decisions the consumed failure DOES re-run" reproduces it: it strips the outcome decisions from the log before the restart and asserts the carrier runs twice, which proves the decisions are what prevent the re-run.
- **State growth.** This demo's runs are a few turns long. A long-running `agentLoop$` without `compaction` re-journals its whole transcript every turn, so its folded state (which a resume reads) grows quadratically: about 3.5 MB at 50 turns and 55 MB at 200 (loom `docs/scaling.md` §5). Past 256 KiB of transcript the loop warns once (`LOOM_AGENT_STATE_GROWTH`; `warnTranscriptBytes` to tune or `false` to silence it). Compaction is opt-in: `effects.register("summarize", createSummarizerEffect(provider))` and `compaction: { toolId: "summarize", afterBytes: 64_000 }` (loom ADR 0137). The summarizer is an in-loop transcript summary, not the event-log `lifecycle.compact`, which is separate and (ADR 0138) needs an archive. Two further opt-ins shrink the journal for tool-heavy loops: `toolCallLog: "lean"` returns `LeanAgentStep`s (status, bytes, digest and stepId instead of `toolOutput`, ADR 0142), and `execution.claimCheck` moves large tool outputs into a content store (ADR 0140); this demo uses neither. Tool outputs are normalised through one JSON round trip (an unstable output fails the run), and taint is scanned on the serialized result, so a tainted value nested anywhere in an output still taints the step (ADR 0085 amendment).

Layout: `model.ts` (router, scripted model), `world.ts` (tools, ring wiring, `boot()` = one process over a shared `Backend`), `scenario.ts` (the acts), `main.ts` (narration).
