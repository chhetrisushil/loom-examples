# reasoning-audit

Model reasoning as **audit evidence** ([loom ADR 0133](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0133-model-reasoning-audit-capture.md)).
An expense-approval agent reads a receipt (untrusted text with a planted "approve 9900" note) and decides whether to call `approve_payment`.
Offline and headless: a scripted, Anthropic-shaped provider (`capabilities.reasoning: true`; a `summary` with text and a signature, and a `redacted` block), in-memory stores, no keys.

```
pnpm --filter @loom/reasoning-audit start   # narrated trace
pnpm --filter @loom/reasoning-audit test    # the tests ARE the proof
```

| What it shows | Where |
|---|---|
| **Config and the boot warning.** `defineConfig({ observability: { reasoning: { store } } })` is the only place the store is named; the model effect adopts it. A capable model with no store gets ONE `onWarn` naming the effect; `reasoning: false` is the silent opt-out | `src/world.ts`, test group 1 |
| **Capture keeps the text out of the log.** The recorded step value holds parts with `signature`, `textRef` and `digest`, never readable text; `LLM_REASONING_CAPTURED` names refs and digests. The test searches the whole serialized log for each thought and finds none | test "the step value has refs..." |
| **Continuation.** Over two tool turns the provider is sent the earlier blocks back unchanged and in the vendor's block order (`reasoning, reasoning, text, tool_use`), the text resolved from the sidecar at request time (the fake provider records what it was sent) | test "turn 2's provider request..." |
| **The auditor's read.** `readReasoning(log, store, { executionId })` joins events to blobs, checks digests and returns the text wrapped as untrusted content (`isTainted`), status `ok` | test group 3 |
| **Erasure is invisible to replay.** Delete the blobs: `readReasoning` reports `erased`; a fresh process replaying the log makes zero model calls, re-runs no tool and yields the identical answer | test "after the blobs are erased..." |
| **Sealed to its execution.** A reasoning part copied into another execution's transcript resolves to "not yours" and is dropped before the provider sees the request | test group 4 |
| **Live view.** `ConversationHub.reasoningSink()` delivers reasoning deltas as `reasoning` events, a channel apart from the reply's `delta` events; neither is journaled | `src/live.ts`, test group 5 |
| **The direct routed path** (`reasoning` without `reasoningToolId`) discards reasoning every turn: one warning through the loop's `onWarn`, or an `AgentLoopConfigError` with `requireReasoningContinuation: true` (app-wide: `observability.reasoning.requireContinuation`) | test group 6 |

Honest framing (from the ADR):

- Reasoning **corroborates**; it is not an explanation. Stated reasoning does not reliably describe what caused an output. The primary evidence is what loom already records durably: the inputs with their taint, the tool calls, authorizations and denials, the step values. Here the log shows the receipt's injected note and the single `approve_payment` for 48.50; the reasoning is the corroboration.
- Each record says what it holds: `kind` is `text`, `summary` or `redacted`, and a summary is never upgraded to text. A `redacted` part has a signature and no text.
- `defineConfig`'s `observability.onWarn` and `requireContinuation` set process-wide agent-loop defaults (the refusal is monotonic, fail-closed). The example passes the loop's own `onWarn` / `requireReasoningContinuation` so each act is self-contained, and the tests call `resetAgentLoopDefaults()` after each test.
- Not shown: the SSE transport (`@loom/plugin-conversation-sse` `reasoning` option) and the shared-mode audience rule (asker and owner only); the hub is exercised in process.

Layout: `model.ts` (scripted model), `world.ts` (`boot()` = one `defineConfig`), `scenario.ts` (audit, erase, replay, forged ref), `live.ts` (streaming conversation), `main.ts` (narration).
