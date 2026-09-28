# blueprint-status

A plain loom app on **Blueprint IR 2** (the status channel, grid cells and `source` provenance
all arrived in 2.0.0) — no loom-ui, no LLM, headless. A service health
board whose Blueprint says everything a renderer needs, so loom's terminal renderer reads status,
spans and provenance from the Blueprint alone (ADR 0097).

```bash
pnpm --filter @loom/blueprint-status start   # prints the board after every provider event
pnpm --filter @loom/blueprint-status test
```

## What it proves

**loom alone gains the status channel.** The app's own projection (`health`, `src/health.ts`)
folds provider events into `{ values: { <key> }, status: { <key> } }`. Each widget's binding names
both paths in that one projection state:

```ts
{ projectionId: "health", path: "values.latency", status: { path: "status.latency" } }
```

Nothing tells the renderer how the fold works; the Blueprint says where to look. The channel is
**opt-in**: the "Queue depth" widget binds a value only and renders exactly as it did under IR
1.0.0.

**Spans are grid cells, never props.** `grid({ columns: 12, children: [cell(4, …), cell(8, …)] })`.
`validateBlueprint(blueprint, builtinCatalog)` accepts the board — under IR 1.0.0 a `span` prop was
an `undeclared-prop` error.

**A degraded widget says what it stands for.** The error table carries
`source: { type: "Trend", version: "1.0.0", degradedFrom: [{ type: "Collection", … }] }`; the
terminal prints `Top errors: (degraded from Collection@1.0.0)`.

**The app's value contract sits in loom's `check` seam** (`src/check.ts`): between `error` and
`stale` in the matrix, only for a widget with a declared channel, never for an absent value.

## The canonical status matrix, on the latency row

`src/health.ts`'s `scenario()` walks every row from real projection state; the test pins each
frame:

| after event | row |
|---|---|
| nothing delivered | `⋯ Latency p99` (declared channel, no value = loading) |
| `health.delivered` 412 | `Latency p99: 412 ms` |
| `health.failed` | `✗ Latency p99: latency probe timed out` (last value retained, not shown) |
| `health.drifted` | `~ Latency p99: 412 ms` (stale, last value shown) |
| `health.requested` | `⋯ Latency p99: 412 ms` (pending, last value shown) |
| `health.delivered` `"oops"` | `✗ Latency p99: Latency p99 expects a number, got string` (check seam) |
| `health.failed` | `✗ Latency p99: latency probe timed out` (error outranks the contract) |
| `health.delivered` 398 | `Latency p99: 398 ms` |

The same rows render identically on loom's React renderer (`data-binding-state` on the widget
frame) and on loom-ui's Lit widgets — the matrix is a property of the IR, not of one surface.

## Files

- `src/health.ts` — the projection (values + status per key), the event builder, the scenario
- `src/blueprint.ts` — the Blueprint: cells with spans, channelled bindings, `source`
- `src/check.ts` — the app's per-kind value contract for loom's `check` seam
- `src/app.ts` — `createBoard()`: projection runtime + `TerminalRenderer` with the default registry
- `test/blueprint-status.test.ts` — IR shape + `validateBlueprint`; the matrix walk; the channel
  is the app's projection
