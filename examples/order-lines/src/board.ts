import {
  type Experience,
  type Intent,
  type Operation,
  type ProviderSpec,
  type Surface,
  compile,
  genesis,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  outputShapeHashOf,
} from "@loom-ui/hydration";
import type { Blueprint } from "@loom/blueprint-runtime";
import { catalog } from "./catalog";
import type { OrderLine } from "./tools";

// ── An order-detail board: "top order" → its lines (loom ADR 0100, gap G5) ────────────────────
// One widget, one DEPENDENT provider: an inlined upstream step reads the top orders, and the
// node's own (terminal) step reads that top order's line items — its argument templates the
// FIRST row's id straight off the upstream's own output. When there IS no top order, the
// template indexes past the end of a real (empty) array: the upstream answered, just with no
// such row (`upstream-empty`), and the handle publishes `empty` — never `error`, never repaired.
// A path with a genuinely wrong KEY (not an index) still errors, on a non-empty upstream, so the
// two can never be confused for one another.

export const TOP_ORDERS_STEP = "top-orders";
export const ORDER_LINES_STEP = "order-lines";
export const HANDLE = "order_lines";

const SAMPLE_LINES: readonly OrderLine[] = [{ sku: "SKU-1", qty: 2 }];

/**
 * The dependent provider. `topOrderPath` names where, in the upstream's OWN output, the order id
 * a real tool would read lives — `"rows[0].orderId"` by default (a real path); the "bad path"
 * scenario passes a path with a wrong key instead, which is a different failure than an empty
 * upstream even though both are "a path that resolved to nothing".
 */
export function orderLinesSpec(topOrderPath = "rows[0].orderId"): ProviderSpec {
  return {
    handle: HANDLE,
    executionGraph: [
      {
        stepId: TOP_ORDERS_STEP,
        toolName: "orders.top",
        toolVersion: "1.0.0",
        toolSchemaHash: "sha256:orders-top-1-0",
        arguments: {},
        dependsOn: [],
        idempotent: true,
      },
      {
        stepId: ORDER_LINES_STEP,
        toolName: "orders.lines",
        toolVersion: "1.0.0",
        toolSchemaHash: "sha256:orders-lines-1-0",
        arguments: { orderId: `{{steps.${TOP_ORDERS_STEP}.output.${topOrderPath}}}` },
        dependsOn: [TOP_ORDERS_STEP],
        idempotent: true,
      },
    ],
    reshaping: { engine: "JSONPath", scriptRef: "$" },
    outputShapeHash: outputShapeHashOf(SAMPLE_LINES),
    cachePolicy: { ttlSeconds: 60, scope: "principal" },
  };
}

export const intent: Intent = { objective: "See the top order's lines", source: "user" };
export const meta: Experience["meta"] = {
  author: "example",
  createdAt: "2026-09-23T00:00:00Z",
  sourceKind: "example",
};

/** One Collection widget ("Order lines"), bound to the dependent provider above. */
export function buildBoard(topOrderPath?: string): Experience {
  const g = genesis({ experienceId: "order-detail", intent, meta });
  const ops: Operation[] = [
    { type: "remapProvider", handle: HANDLE, spec: orderLinesSpec(topOrderPath) },
    {
      type: "insertNode",
      parentId: g.root.id,
      node: {
        id: "lines",
        order: "a",
        kind: "semantic",
        type: "Collection",
        typeVersion: "1.0.0",
        span: 12,
        label: { key: "board.lines.label", fallback: "Order lines" },
        props: { columns: ["sku", "qty"] },
        binding: { handle: HANDLE, priority: "P0" },
      },
    },
  ];
  const r = replay(g, ops);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
}

export function compileFor(experience: Experience, surface: Surface): Blueprint {
  const r = compile(experience, {
    surface,
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
  });
  if (r.findings.length > 0)
    throw new Error(`compile (${surface}): ${r.findings.map((f) => f.message).join("; ")}`);
  return r.blueprint;
}

export { catalog };
