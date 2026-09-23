# experience-kinds

loom-ui's framework kinds, used by an app that has nothing to do with any other: a small
**warehouse-operations board**. One `Experience` is authored as operations over a `genesis`,
compiled once for `web` and once for `terminal`, and hydrated from a `HydrationStore` seeded
with sample values that are each checked against their kind's value contract.

| Semantic type (the app's word) | Framework kind | What it shows |
|---|---|---|
| `StockLevel` | `Kpi` | Pallets on hand as an `integer`, the caption "vs. last count" beside the title, and a ▲ change badge (`deltaPct` is a fraction: `0.042` → ▲ 4.2%) |
| `PickList` | `Table` | Columnar rows; each column declares its own semantics — `integer` quantity, EUR `currency` unit price, whole-number `percentage` fill rate; a `null` cell is "—" |
| `DockStatus` | `StatusCard` | `level` / `headline` / `detail`; a change is announced in a `role="status" aria-live="polite"` region |
| `ShiftNote` | `Note` | Unbound static text from its `text` prop, declared in `textProps`, so it can be a `LocalizedText {key, fallback}` that `compile` resolves (the Blueprint carries text, never the key) |
| `Throughput` | `TimeSeries` | Orders per hour on the left axis and pick latency (seconds, `decimal`) on its own right-hand axis (`axis: "right"`); the terminal marks it "(R)", cutting a long label rather than the marker ("Pick lat (R)") |

The catalogue (`src/catalog.ts`) resolves every type to the same kind on both surfaces and
declares each kind's loom contract; the test pins those to `frameworkKindContracts` so they
cannot drift, and compiles the web Blueprint against `litRegistry` to prove every kind has a Lit renderer (no `renderer-coverage` finding). The web surface renders through `litRegistry` (`lu-kpi`, `lu-table`,
`lu-status-card`, `lu-note`, `lu-timeseries`), numbers in the viewer's locale (the test runs as
`de-DE`: "1.234,50 €"); the terminal renders through `terminalRegistry()` at a fixed en-US
("€1,234.50").

There is **no consumer-specific code** here: no names, value shapes or wording from any other
app — only the domain's own vocabulary mapped onto loom-ui's generic kinds.

```bash
pnpm --filter @loom/experience-kinds test
pnpm --filter @loom/experience-kinds build
```
