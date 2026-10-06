# a2ui-egress — project a Loom surface onto the Google A2UI wire protocol (`@loom/plugin-a2ui`)

A Loom flow drives an **agent surface** with durable delta patches (`surface(ctx).set` /
`merge` / `append` / `increment`). `@loom/plugin-a2ui`'s **`A2UISurfaceBridge`**
projects that same event stream onto the Google **A2UI (Agent-to-UI) wire protocol
v1.0** — `createSurface` / `updateDataModel` / `deleteSurface` — so any A2UI-compliant
client could render a Loom-driven UI. This headless example prints the wire messages
as they stream, then drives the human-approval gate through an **inbound A2UI action**.

```
⧖  A2UI egress — projecting the "ui" surface of exp-4821
   surfaceId=ui:exp-4821

── A2UI wire messages (server → client) ─────────────────────────
  createSurface   surface=ui:exp-4821 catalog=loom.core.v1 components=9
              dataModel={"title":"NYC client visit"}
  updateDataModel  /status = "fetching"
  updateDataModel  /progressLog = ["Fetching exp-4821"]
  updateDataModel  /stats = {"lineItems":3,"category":"travel"}
  updateDataModel  /stepsCompleted = 1
  updateDataModel  /stats = {"lineItems":3,"category":"travel","amount":384}
  updateDataModel  /stepsCompleted = 2
  updateDataModel  /status = "awaiting-approval"

   ⏸  flow suspended — awaiting approval

── Inbound A2UI action (client → server) ────────────────────────
  action "approve" on ui:exp-4821 → resume ExpenseApproved
```

## The whole idea

```ts
// One bridge = one A2UI session for one execution's surface.
const bridge = new A2UISurfaceBridge({ executionId, components: EXPENSE_VIEW });

// Feed it the Loom event stream — each event yields 0+ A2UI wire messages.
eventStore.subscribe(executionId, (event) => {
  for (const msg of bridge.handleEvent(event)) send(msg); // createSurface / updateDataModel
});
```

```ts
// view.ts — the A2UI component tree (built with the plugin's catalog helpers).
// Sent once in createSurface; the data flows separately, bound by JSON Pointer.
column("root", ["title", "status", "amount", "log", "approve"]);
badge("status", bind("/status"));          // bound to the data model
list("log", "/progressLog", "logItem");    // data-bound iteration
button("approve", "Approve", "approve");   // declares the inbound action
```

```ts
// The inbound leg — the app decides how an action becomes a Loom event.
const action = bridge.ingestAction(clientMessage);   // null if not for this surface
if (action) await runtime.resume(executionId, { eventType: "ExpenseApproved", payload });
```

## What it shows

- **Delta → absolute translation.** Loom's surface patches are *deltas*
  (`increment`, `append`); A2UI has no patch framework — `updateDataModel` **replaces**
  the value at a JSON Pointer. The bridge folds locally and emits the concrete
  post-patch value, so `increment("stepsCompleted")` reaches the client as `2`, and
  `append("progressLog", …)` sends the **whole array**. The tests assert exactly this.
- **Dot-path → RFC 6901 JSON Pointer.** Loom's `stats.amount` addresses become A2UI's
  `/stats/amount`. A patch is emitted at the path it touches — `merge("stats", …)` sends
  the whole object at `/stats`; `remove` becomes an upsert to `null`.
- **The inbound action leg.** `ingestAction` normalizes an A2UI client `action`,
  returning it only when it targets this surface (else `null`) — the app maps it onto a
  Loom `resume`. Egress + inbound actions only; bidirectional RPC is out of scope by design.
- **Zero kernel involvement.** The bridge folds the raw event log itself, so it works
  against any Loom app that emits surface patches — `@loom/plugin-a2ui` is a composition-time
  adapter, not a runtime plugin. `surfaces: ["ui"]` in `defineConfig` is only there to
  show Loom's native folded surface as a contrast at the end of the run.
- **Deterministic + offline.** No `Date.now` / `Math.random` — runs and tests are stable.

## Run it

```sh
pnpm start   # run one expense-approval execution, printing the A2UI wire messages
pnpm test    # asserts the delta→absolute translation and the inbound-action gate
```

See `apps/playground` in the `loom` repo for the same bridge wired into a live React
A2UI tab (with a clickable Approve button routed through `ingestAction`).
