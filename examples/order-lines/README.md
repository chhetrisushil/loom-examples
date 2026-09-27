# order-lines

loom-ui's empty binding state (loom ADR 0100, gap G5): an order-detail board where "the top
order's lines" is a genuinely DEPENDENT widget, not a widget over a directly-empty result.

- **The provider** (`src/board.ts`) is two steps: an inlined upstream `top-orders` read, then the
  node's OWN (terminal) `order-lines` step, whose argument templates the first row's id straight
  off the upstream's own output (`{{steps.top-orders.output.rows[0].orderId}}`). When there is no
  top order, that index is past the end of a REAL (empty) array — the upstream answered, just with
  no such row — and hydration's own producer publishes the handle `empty`, never `error`: no value,
  never cached, never drift, never repaired, and the dependent step's own tool is never called.
- **A genuinely bad path** (`topOrderPath: "rows[0].orderIdTypo"`) is a different failure even on a
  NON-empty upstream: a wrong key, not an out-of-range index, is `unresolved-step-reference` — the
  handle goes `error`, never `empty`. The two are easy to conflate ("a path that led to nothing")
  and hydration keeps them apart on purpose (loom's `walkPath`, `out-of-range` vs `absent`).
- **What the tests show** (`test/order-lines.test.ts`): a real top order executes both steps and
  renders; an empty upstream renders "No data" on both surfaces — the web widget as a polite
  `role="status"` region (`data-state="empty"`, the full hydration message in `title`), the
  terminal as loom's `○ <title>: <message>` row — and is never mistaken for the `role="group"`
  `data-state="error"` markup a bad path produces instead; reloading an empty upstream asks the
  same question and gets the same answer, never a cached one.

Run: `pnpm --filter @loom/order-lines test`
