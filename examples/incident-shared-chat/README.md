# incident-shared-chat

loom **R17 shared mode** (ADR 0122 D10) on an incident war room: several responders share ONE conversation
with an AI assistant, and the same conversation is shown differently to each of them. Offline: a scripted model,
the real `@loom/plugin-conversation-sse` transport on an ephemeral port (closed in teardown), in-memory stores.

```bash
pnpm --filter @loom/incident-shared-chat start   # a narrated run (~1 s)
pnpm --filter @loom/incident-shared-chat test    # the tests ARE the proof
```

## The cast

| who | role | cleared for `customer-pii` | may call `customer-export` |
|---|---|---|---|
| ada | incident commander, the room's OWNER | yes | yes |
| ben | database responder, invited | yes | yes |
| cleo | comms responder, invited | **no** | **no** |
| mallory | authenticated, never invited | n/a | n/a |
| `incident-service` | SERVICE principal that owns the coordinating execution | n/a | `conversation.turn` only |

## What it teaches (each is a test)

- **Per-viewer filtering of the history, the stream and the model context.** Ada asks for the customer export.
  Ben's history and SSE stream carry the answer; Cleo's carry a bare `restricted` placeholder (no text, no tool
  name, no class label, no turn execution id), and the prompt Cleo's own later turns send to the model leaves the
  restricted turn out whole (question and answer). The class is computed from the tools the turn touched
  (`classOf`) and cleared by the host (`cleared`, fail closed).
- **Each turn runs AS THE ASKER.** The coordinator (owned by the service principal) only dequeues and records;
  the turn is a separate execution under the asker's principal. The same "export the customer list" is answered
  for Ben and `failed / denied` for Cleo, whose grant table has no `customer-export`.
- **Signed envelopes.** Every inbox message is an HMAC-signed, conversation-bound, single-use, fresh envelope.
  The example writes to the inbox behind the client's back (the worst case, a policy slip): a tampered copy is
  `unauthenticated`, a captured valid copy under a new kernel `messageId` is `replayed`, and one older than
  `maxEnvelopeAgeMs` is `stale`. None runs the model. (The replay set is bounded; a high-water-mark floor keeps an
  evicted envelope dead. Exercising the floor needs more than 1 024 envelopes, so loom's own tests own that.)
- **A service-principal coordinator under an owner-scoped runtime policy**, asserted at construction:
  `createConversations({ policy })` refuses a runtime that lets a tenant peer `query`/`send`/`cancel`/`resume`,
  and with it not even the room's owner can read the coordinator's unfiltered log. No end user can be the service.
- **A non-participant is refused**, uniformly: the same 404 as an unknown room on every route and the stream,
  and nothing is written. A participant who is not the owner cannot invite.
- **Turns queue.** Served FIFO and attributed; another asker never interrupts a running turn.
- **The conversation surface.** Each viewer's history (and, separately, their own SSE stream) is folded by
  loom-ui's `ChatFeed` and printed with `chatTranscriptLines`: three viewers, three transcripts, the same
  log. The R17b wire is visible too: a rejected message sits on turn 0 with no text, and an edit
  (`editOf` = the `ord` of your earlier turn) is drawn "edit of turn N" from `editOfTurn`.

## Layout

- `src/room.ts`: every host decision (participants, classes, clearance, grants, service principal, policy, key)
  and the scripted model.
- `src/client.ts`: a responder's `fetch` + SSE client and the `ChatFeed` folding.
- `src/attack.ts`: ATTACK DEMONSTRATION, never copy into a host (hosts never write to the inbox): raw inbox writes (capture a signed envelope, re-inject it).
- `test/sharedChat.test.ts` uses `signInboxEnvelope` (`@loom/conversation`) for the one body that SHOULD be accepted: a control next to the impersonation test, signed with the envelope key, proving the forgeries are refused for the missing signature alone. The attack demo stays keyless.
- `src/main.ts`: the narrated run. `test/sharedChat.test.ts`: one test per claim.

Message content is read through `@loom/llm`'s `textOf`. Waits are on conditions (`until`), never fixed sleeps.
