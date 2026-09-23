import {
  type Experience,
  type Finding,
  type KpiValue,
  type LocalizedText,
  type Operation,
  type ProviderSpec,
  type StatusCardValue,
  type Surface,
  type TableValue,
  type TimeSeriesValue,
  checkKindValue,
  compile,
  genesis,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "@loom-ui/hydration";
import type { Blueprint } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { type KIND_CONTRACTS, catalog } from "./catalog";

// ── A small warehouse-operations board ────────────────────────────────────────
// One Experience, authored as operations over a `genesis`, compiled once per surface. The five
// widgets are loom-ui's framework kinds; nothing here is specific to any other app.

/** Widget titles, by node id. They are `LocalizedText` fallbacks on the nodes. */
export const TITLES = {
  stock: "Stock on hand",
  dock: "Loading dock",
  note: "Shift note",
  throughput: "Orders vs. pick latency",
  picks: "Pick list",
} as const;
type NodeId = keyof typeof TITLES;

/** The shift note's text: a message key plus the fallback shown when no catalogue resolves it. */
const NOTE_TEXT: LocalizedText = {
  key: "warehouse.shift.note",
  fallback: "Keep aisle 7 clear: forklift charging until 15:00.",
};

// ── Sample values, one per bound kind ─────────────────────────────────────────
// Each is typed by its kind's contract AND checked against it when `createApp` seeds the store, so a
// sample that drifts from what the renderers draw is a thrown error here, not a blank widget.

export const STOCK: KpiValue = {
  value: 1284,
  unit: "pallets",
  format: { semanticType: "integer" },
  label: "vs. last count",
  deltaPct: 0.042, // a FRACTION: +4.2%
};

export const PICK_LIST: TableValue = {
  columns: [
    "SKU",
    "Bin",
    { label: "Qty", format: { semanticType: "integer" } },
    { label: "Unit price", format: { semanticType: "currency", currency: "EUR" } },
    { label: "Fill rate", format: { semanticType: "percentage", maximumFractionDigits: 0 } },
  ],
  rows: [
    ["SKU-1042", "A-07-3", 24, 1234.5, 0.96],
    ["SKU-2210", "C-12-1", 6, 89.9, 1],
    ["SKU-0387", "B-02-4", 120, 4.75, null], // no fill rate yet → "—"
  ],
};

export const DOCK: StatusCardValue = {
  level: "warning",
  headline: "Door 3 waiting on a carrier",
  detail: "Trailer 2 of 4 loaded; carrier ETA 14:20.",
};

const hours = ["08", "09", "10", "11", "12", "13"];
export const THROUGHPUT: TimeSeriesValue = {
  series: [
    {
      label: "Orders",
      format: { semanticType: "integer" },
      points: [42, 58, 71, 66, 49, 63].map((value, i) => ({
        timestamp: `2026-09-23T${hours[i]}:00:00Z`,
        value,
      })),
    },
    {
      // A different unit on a different scale: its own axis, on the right.
      label: "Pick latency",
      unit: "s",
      format: { semanticType: "decimal", maximumFractionDigits: 1 },
      axis: "right",
      points: [3.1, 3.8, 4.6, 4.2, 3.4, 3.9].map((value, i) => ({
        timestamp: `2026-09-23T${hours[i]}:00:00Z`,
        value,
      })),
    },
  ],
};

/** handle → [the kind it is drawn as, its sample value]. */
const SAMPLES = {
  stock: ["Kpi", STOCK],
  picks: ["Table", PICK_LIST],
  dock: ["StatusCard", DOCK],
  throughput: ["TimeSeries", THROUGHPUT],
} as const satisfies Record<string, readonly [keyof typeof KIND_CONTRACTS, unknown]>;
type Handle = keyof typeof SAMPLES;

/**
 * Where each handle's value would come from: the app's own inventory tools. The example seeds
 * the store directly with {@link SAMPLES} (no controller runs these), but the Experience still
 * declares them — a binding to a handle with no provider is an `unknown-handle` finding.
 */
const provider = (handle: Handle, toolName: string): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: `${handle}-1`,
      toolName,
      toolVersion: "1.0.0",
      toolSchemaHash: `sha256:${toolName}-1-0`,
      arguments: { site: "north" },
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: `shape:${handle}`,
  cachePolicy: { ttlSeconds: 60, scope: "principal" },
});

const intent: Experience["intent"] = {
  objective: "Run the north warehouse shift",
  source: "application",
};
const meta: Experience["meta"] = {
  author: "example",
  createdAt: "2026-09-23T00:00:00Z",
  sourceKind: "example",
};

/** The board, as operations: five nodes on the 12-column root grid, four of them bound. */
function operations(): Operation[] {
  const layout: Array<{ id: NodeId; type: string; span: number; props?: Record<string, unknown> }> =
    [
      { id: "stock", type: "StockLevel", span: 4 },
      { id: "dock", type: "DockStatus", span: 4 },
      { id: "note", type: "ShiftNote", span: 4, props: { text: NOTE_TEXT } },
      { id: "throughput", type: "Throughput", span: 12 },
      { id: "picks", type: "PickList", span: 12 },
    ];
  const ops: Operation[] = [
    { type: "remapProvider", handle: "stock", spec: provider("stock", "inventory.stock_level") },
    { type: "remapProvider", handle: "picks", spec: provider("picks", "inventory.pick_list") },
    { type: "remapProvider", handle: "dock", spec: provider("dock", "dock.status") },
    {
      type: "remapProvider",
      handle: "throughput",
      spec: provider("throughput", "orders.throughput"),
    },
  ];
  let order: string | null = null;
  for (const n of layout) {
    order = orderKeyBetween(order, null);
    ops.push({
      type: "insertNode",
      parentId: "root",
      node: {
        id: n.id,
        order,
        kind: "semantic",
        type: n.type,
        typeVersion: "1.0.0",
        span: n.span,
        label: { key: `warehouse.${n.id}.title`, fallback: TITLES[n.id] },
        props: n.props ?? {},
      },
    });
    if (n.id in SAMPLES) ops.push({ type: "bindProvider", nodeId: n.id, handle: n.id });
  }
  return ops;
}

export interface App {
  readonly experience: Experience;
  /** The same Experience, compiled once per surface. */
  readonly web: Blueprint;
  readonly terminal: Blueprint;
  readonly findings: Readonly<Record<"web" | "terminal", readonly Finding[]>>;
  readonly runtime: InMemoryProjectionRuntime;
  readonly store: HydrationStore;
  readonly noteText: LocalizedText;
}

export function createApp(): App {
  const g = genesis({ experienceId: "warehouse-board", intent, meta });
  const built = replay(g, operations());
  if (!built.ok) throw new Error(built.finding.message);
  const experience = seal(built.value);

  const compileFor = (surface: Surface) =>
    compile(experience, {
      surface,
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
  const web = compileFor("web");
  const terminal = compileFor("terminal");
  if (!web.ok || !terminal.ok)
    throw new Error(
      `compile failed: ${[...web.findings, ...terminal.findings].map((f) => f.message).join("; ")}`
    );

  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: experience.experienceId });
  for (const [handle, [kind, value]] of Object.entries(SAMPLES)) {
    const check = checkKindValue(kind, value);
    if (!check.ok) throw new Error(`sample "${handle}": ${check.finding.message}`);
    store.setValue(handle, value, { state: "ready" });
  }

  return {
    experience,
    web: web.blueprint,
    terminal: terminal.blueprint,
    findings: { web: web.findings, terminal: terminal.findings },
    runtime,
    store,
    noteText: NOTE_TEXT,
  };
}
