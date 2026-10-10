# chat-agent

The R17 conversation layer (ADR 0122), owner-only and single user: a chat is **one chained execution**
that is answered turn by turn, interrupted, rotated and resumed after a restart. Offline: the model is
scripted, the SSE server is the real `@loom/plugin-conversation-sse` over HTTP on port 0.

```
pnpm --filter @loom/chat-agent start
pnpm --filter @loom/chat-agent test
```

| Act | What it shows | Where |
|---|---|---|
| 1. Multi-turn | `POST /conversations`, `POST .../turns`, `GET .../history`; later turns see earlier ones | `src/session.ts` |
| 2. Barge-in | a new turn aborts the in-flight generation (`inboxBargeIn`); the partial is kept as `status: "interrupted"` and is part of the next prompt | `src/chat.ts`, `src/model.ts` |
| 3. Tiny window | `budget: { contextWindow: 400, summarizerToolId }` + `rotateEveryTurns`: the prompt plateaus, evicted turns fold into a summary, history keeps everything | `src/chat.ts` |
| 4. Restart | a new process over the same stores; the client reconnects with `Last-Event-ID` and gets the rest of the log, ids continuing across generations, with no model call for the replayed turns | `src/main.ts` |
| 5. Other tenant | someone else's conversation answers the same `404` as one that does not exist, on every route | `src/chat.ts` (`authenticate`) |

Things worth copying:

- The runtime policy is **owner-scoped** (`executionAccessPolicy({ rules: { query/send/cancel/resume: "owner" } })`);
  `createConversations` refuses anything looser.
- Message content is `string | parts` (R5): read it with `textOf` from `@loom/llm`, never `as string`.
- The summarizer receives the user's words **tainted** (`{ __loomTainted, value }`): `unwrapTainted` from
  `@loom/classify` first, then `textOf`. `textOf` on the raw content throws.
- A "restart" here is a second `startChat({ stores })`: only the event and snapshot stores are durable, so
  that is all the new process gets. The new server has a new port; ids are `<generation>.<sequence>`.
- Live deltas are transient and per process. Only the durable `message` events are resumable.
