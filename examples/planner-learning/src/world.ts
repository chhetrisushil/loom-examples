import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";

// ── The simulated world ─────────────────────────────────────────────────────────────────────
// Everything here is DETERMINISTIC: a learning demo that leans on Math.random or a live model
// teaches nothing reproducible, and a loom flow must replay. The model is scripted, the viewers
// are a seeded function of the (surface, viewer) pair, and "the world changes" is an explicit epoch.

export const TENANT = "acme";

/** The two layouts the planner can draw the SAME dashboard in. These are the policy's actions. */
export const LAYOUTS = ["flat", "tabs"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** The one thing a policy may know about a viewer: how they use the product. */
export const SEGMENTS = ["power", "casual"] as const;
export type Segment = (typeof SEGMENTS)[number];

/**
 * Who prefers what. This is ground truth the policy is never told; it only ever sees votes.
 *
 * Epoch 1: power users like grouped tabs, casual users like one flat page.
 * Epoch 2: the world DRIFTED - casual users now overwhelmingly prefer tabs (say, a redesign of the
 * product around them). A policy trained on epoch 1 is now confidently wrong for half its traffic.
 */
export type Epoch = 1 | 2;
export function appeal(layout: Layout, segment: Segment, epoch: Epoch): number {
  if (segment === "power") return layout === "tabs" ? 0.85 : 0.35;
  if (epoch === 1) return layout === "flat" ? 0.75 : 0.35;
  return layout === "tabs" ? 0.9 : 0.05;
}

/** Mulberry32: a tiny seeded PRNG (the only randomness in this example). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A viewer's star rating (1..5) of a surface: its appeal plus a little seeded noise. */
export function stars(appealValue: number, rng: () => number): number {
  const noisy = appealValue + (rng() - 0.5) * 0.2;
  return Math.max(1, Math.min(5, Math.round(1 + 4 * noisy)));
}

// ── The vocabulary the planner composes from ───────────────────────────────────────────────

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.planner-learning.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
  ],
});

const cap = (handle: string, toolName: string, sampleOutput: unknown): CapabilityRef => ({
  handle,
  toolName,
  toolVersion: "1.0.0",
  toolSchemaHash: `sha256:${toolName.replace(".", "-")}-1-0`,
  sensitivity: "internal",
  sampleOutput,
});
export const capabilities: CapabilityRef[] = [
  cap("orders_summary", "orders.summary", { totals: { count: 42 } }),
  cap("backlog_stats", "orders.backlog", { open: 7 }),
];

/** The node ids both layouts contain: what a viewer can be shown, engage with and vote on. */
export const NODES = ["orders", "backlog"] as const;

// ── The scripted model ──────────────────────────────────────────────────────────────────────
// A reply is the flat entry list the planner contract takes. The two layouts hold the SAME two
// cards; `tabs` groups them under one `tabs` container, `flat` leaves them in a row.

type Entry = Record<string, unknown>;
const metric = (id: string, label: string, cap: string, path: string, parent?: string): Entry => ({
  id,
  type: "Metric",
  label,
  span: 6,
  ...(parent !== undefined && { parent }),
  props: { unit: "orders" },
  binding: { capability: cap, arguments: {}, path, priority: "P0" },
});
const box = (id: string, container: string, title: string, parent?: string): Entry => ({
  id,
  container,
  title,
  span: 12,
  ...(parent !== undefined && { parent }),
});

export const replies: Record<Layout, string> = {
  flat: JSON.stringify({
    summary: "Orders at a glance",
    nodes: [
      metric("orders", "Orders", "orders_summary", "totals.count"),
      metric("backlog", "Backlog", "backlog_stats", "open"),
    ],
  }),
  tabs: JSON.stringify({
    summary: "Orders at a glance",
    nodes: [
      box("views", "tabs", "Orders"),
      box("overview", "section", "Overview", "views"),
      metric("orders", "Orders", "orders_summary", "totals.count", "overview"),
      box("queue", "section", "Queue", "views"),
      metric("backlog", "Backlog", "backlog_stats", "open", "queue"),
    ],
  }),
};

/** A planner model that always gives `reply` and counts its calls. */
export function scriptedModel(reply: string): {
  calls: number;
  complete(): Promise<{ content: string }>;
} {
  const m = {
    calls: 0,
    async complete() {
      m.calls += 1;
      return { content: reply };
    },
  };
  return m;
}
