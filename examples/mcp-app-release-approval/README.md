# mcp-app-release-approval — serve a Loom surface as an MCP App (`@loom/plugin-mcp-app`)

A Loom flow drives an **agent surface** with durable delta patches. `@loom/plugin-mcp-app`
projects it onto the **MCP Apps** extension ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp),
`io.modelcontextprotocol/ui`), so any MCP host renders a Loom-driven UI.

The gate in this example is one that stays open, and the surface behind it does not stand
still — CI keeps reporting while a human deliberates. So the interesting question is not "can
we render a UI" but **"is the thing they approved still the thing they looked at?"**

Everything here is real: a real MCP server over HTTP, a real `McpClient`, and the **real
published template** — fetched from `ui://loom/surface-host` and executed in a DOM.

```
⧖  MCP App — a Loom surface rendered by an MCP host
   server   http://localhost:55277
   template ui://loom/surface-host  pin=fnv1a64:611425d25d6534cd

── 1. Flow suspended at the approval gate ───────────────────────
── 2. Audience-scoped tool lists ────────────────────────────────
   model sees: approve
   app   sees: loom.surface.since, approve

── 3. Host fetched the app ──────────────────────────────────────
   ui://loom/surface-host  text/html;profile=mcp-app
   pin matches plan time: true

── 4. View rendered (real template, in a DOM) ───────────────────
   Checkout v4.2 awaiting-approval Checks build ✓ unit ✓ lint ✓ Approve

── 5. CI reports a failure while the gate is open ───────────────
   surface advanced — anyone holding a rendered view is now behind

── 6. Approve clicked from a stale view ─────────────────────────
   status  = re-review
   notice  = Approval ignored — it was based on revision 10, but the checks
             changed (now at 23). Please re-review.

── 7. View polls the cursor and catches up ──────────────────────
   Checkout v4.2 re-review … Checks build ✓ unit ✓ lint ✓ e2e ✗ Approve

── 8. Approve clicked from the refreshed view ───────────────────
   status = shipped
   result = {"shipped":true,"approvedBy":"mcp-app-view","reviewRounds":2}
```

## Run it

```bash
pnpm start     # the narrated walkthrough above
pnpm test      # the same path, asserted
```

## What it demonstrates

### One static template, not generated HTML

MCP Apps ships **code**, which is exactly the property A2UI deliberately lacks. The plugin
neutralises it by never generating markup per flow: one static template renders whatever
declarative tree arrives as `structuredContent`. So [`src/view.ts`](src/view.ts) — an ordinary
A2UI component tree, the same vocabulary [`a2ui-egress`](../a2ui-egress) uses — **is** the UI.
Nothing in this example is bundled or shipped as script.

The consequence: the rendered UI is a pure function of *(pinned template hash, logged
`structuredContent`)*, and both halves are in the log.

### The pin round-trips

`surfaceHostPin()` is captured at "plan time" and verified before the app is ever served; the
host then recomputes it from the bytes it fetched and gets the same value. That equality is the
entire value of the pin — and it only holds because egress and ingress hash the **same way**.

### There is no server push

The extension has no server→View channel after `ui/notifications/tool-result`. The View
therefore polls `loom.surface.since`, an **`ambient`** (never journaled) **app-only** (never
shown to the model) cursor tool. Step 7 is that poll: the stale View recovers by itself.

This is polling, and it is worse than SSE. That is the extension's limitation, contained behind
one tool.

### Decision provenance across a long gate

`resume()` already refuses stale flow *code* (K11), stale *input* (K11.5), and forged
*approvals* (K12.2). What it cannot know is which version of the data a human was looking at —
the execution knows when *it* suspended, not what was on screen.

So the View echoes `seenSequence`, and the **server** — which owns the log — turns that into a
verdict:

```ts
// src/server.ts — at the trust boundary
const head = await headSequence(store, executionId);   // BEFORE resuming
const stale = isStale(input, head);
await runtime.resume(executionId, { eventType: RELEASE_SIGNAL, payload: { ...signal, stale, headSequence: head } });
```

```ts
// src/flow.ts — the policy stays in the domain
if (signal.stale) { surface(ctx).set("status", "re-review"); continue; }
```

**Evidence at the boundary, policy in the flow.** Whether a lag invalidates a decision is
domain-specific — this release gate refuses; another flow could legitimately accept. An approval
carrying *no* `seenSequence` counts as stale, because unknown provenance is indistinguishable
from arbitrarily old data.

### Two boundaries the server owns

- **Audience.** The extension puts visibility enforcement on the *host*, so a server cannot tell
  a model call from a View call. `audienceOf` is deployment-supplied (here, a header; a real
  deployment would use a distinct port or credential) and defaults to `"model"` — absent an
  explicit boundary, app-only tools stay unreachable rather than silently open.
- **Seam.** A View can call any tool the host proxies for it. Enrichment reads are harmless, but
  `approve` appends to the log — a state transition requested by the *user's UI* — so
  app-originated journaled calls are **denied by default** and admitted only against a grant.

## Files

| File | What it shows |
|---|---|
| [`src/flow.ts`](src/flow.ts) | The gate loop: CI signals and approvals arrive through one suspend; staleness is a domain decision |
| [`src/view.ts`](src/view.ts) | The A2UI component tree — data, not code |
| [`src/server.ts`](src/server.ts) | `createMcpServer`: pinned resource, ambient cursor, journaled `approve`, both boundaries |
| [`src/host.ts`](src/host.ts) | A minimal MCP Apps **host** — runs the real template in jsdom and bridges `postMessage` ↔ MCP |
| [`src/main.ts`](src/main.ts) | The narrated walkthrough |

## What the host does *not* do

[`src/host.ts`](src/host.ts) stands in for the **iframe**, not for the template. It does not
enforce CSP, apply a sandbox attribute, or isolate origins. A real host must — and those are
precisely the reasons Loom rejects the host role rather than shipping one
(ADR 0072 D2): they are browser-application concerns where a mistake is an XSS or exfiltration
hole, and the kernel has no browser.

It exists because an example that drives only the *server* proves half a protocol — and the half
it skips is where this binding had already been wrong twice. Writing this example found both:
the template never called the cursor tool it was documented to poll, and its `List` branch read
a prop the A2UI `list()` helper never emits, so every list rendered empty.


## The log is tamper-evident — and checkable by someone outside

This app's entire output is a record of **who approved a production release**, so two questions
have to stay separate. The K12 `ResumeAuthenticator` decides whether an approval is *accepted* —
only the trust boundary may approve. `@loom/plugin-audit-chain` answers the other one: whether
the accepted approval is still the one **recorded**. It hash-chains every event into `metadata`,
which the fold ignores, so replay is byte-identical whether or not it is wired, and
`app.auditLog.verifyChain(executionId)` recomputes the chain out of band.

The evidence is the negative case: a test rewrites the approver on the durable event after the
fact and gets `ok: false` with `brokenAt` at that sequence. The positive test asserts the
approval actually landed first — a chain verified over a log with no approval in it passes while
proving nothing about the thing this app exists to record.

**Signed, not HMAC'd** ([loom#382](https://github.com/chhetrisushil/loom/issues/382)). Hashes alone
establish that a log was not edited; they say nothing about *who wrote it*, and an HMAC would not
fix that for an outside reader — verification needs the same secret, so the auditor you hand it to
could re-chain and re-sign the whole thing. For a record of who approved a production release,
"the only people who can check it are the people who could have faked it" is the wrong guarantee.

Entries are Ed25519-signed, and `auditorView(app)` is what an external party gets: the same durable
rows plus the **public key**, and nothing else. It can prove every entry and author none —
`verifyChain` returns `signaturesChecked: true`, so a passing result means authorship was actually
checked rather than merely not contradicted.

The evidence here is again a negative: a test takes everything an auditor holds, re-chains the log
with the approver rewritten, and re-signs it with a key of its own. That forgery is *internally
consistent* — and fails immediately against the published key.
