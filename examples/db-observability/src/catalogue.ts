import { DataTable, MetricCard, ProgressBar, Timeline } from "@loom/blueprint-runtime";
import type { Widget } from "@loom/blueprint-runtime";

// ── The available widget catalogue ────────────────────────────────────────────
// The palette the dashboard is generated from. Each entry knows what telemetry it
// visualizes and how to build its bound Widget. The composer selects from this list
// at runtime based on the user's intent — the UI is assembled, not hand-authored.
//
// Every builder is given an EXPLICIT `id`, and Phase 3 is why. The derived id is a hash
// of kind + props, so it changes whenever any prop does — which is fine for a view
// authored once and wrong for a node that has to be THE SAME NODE across separately
// generated trees. A floor is exactly that: the set of nodes every cohort's blueprint
// must contain. Leave the ids derived and two cohorts whose generators differ by a title
// quietly stop agreeing about what a node is, and the floor stops being a floor without
// anything failing.

export type Topic = "cpu" | "connections" | "replication" | "queries";

export interface CatalogueEntry {
  id: string;
  topic: Topic;
  summary: string; // human description of what this widget shows
  build: () => Widget;
}

export const WIDGET_CATALOGUE: CatalogueEntry[] = [
  {
    id: "cpu.metric",
    topic: "cpu",
    summary: "Current CPU utilization %",
    build: () =>
      MetricCard({
        id: "cpu.metric",
        title: "CPU utilization",
        binding: { projectionId: "cpu", path: "current" },
        unit: "%",
        format: "percent",
      }),
  },
  {
    id: "cpu.trend",
    topic: "cpu",
    summary: "CPU utilization over recent samples",
    build: () =>
      Timeline({
        id: "cpu.trend",
        title: "CPU trend",
        binding: { projectionId: "cpu", path: "history" },
      }),
  },
  {
    id: "connections.saturation",
    topic: "connections",
    summary: "Active connections against the pool limit",
    build: () =>
      ProgressBar({
        id: "connections.saturation",
        title: "Connection pool",
        binding: { projectionId: "connections", path: "active" },
        max: 100,
      }),
  },
  {
    id: "connections.waiting",
    topic: "connections",
    summary: "Clients queued waiting for a connection",
    build: () =>
      MetricCard({
        id: "connections.waiting",
        title: "Waiting clients",
        binding: { projectionId: "connections", path: "waiting" },
      }),
  },
  {
    id: "replication.lag",
    topic: "replication",
    summary: "Replica apply lag in milliseconds",
    build: () =>
      MetricCard({
        id: "replication.lag",
        title: "Replica lag",
        binding: { projectionId: "replication", path: "lagMs" },
        unit: "ms",
      }),
  },
  {
    id: "queries.slow",
    topic: "queries",
    summary: "Top CPU-consuming queries",
    build: () =>
      DataTable({
        id: "queries.slow",
        title: "Slow queries",
        binding: { projectionId: "queries", path: "slow" },
        columns: ["statement", "cpuPct", "calls"],
      }),
  },
];

export const PLAN_DETAIL: CatalogueEntry = {
  id: "queries.plan",
  topic: "queries",
  summary: "Per-statement plan detail — the deeper view, above every topic's floor",
  build: () =>
    DataTable({
      id: "queries.plan",
      title: "Plan detail",
      binding: { projectionId: "queries", path: "slow" },
      columns: ["statement", "calls", "cpuPct"],
    }),
};

// Above the floor on purpose: no topic model lists it, so it appears only when a cohort
// adds it. That is what makes it a capability a cohort can GRANT rather than a widget the
// floor already guarantees — and a cohort rule whose additions are all already in the
// floor adds nothing at all, which is a rule that reads as adaptation while doing none.
WIDGET_CATALOGUE.push(PLAN_DETAIL);

export function catalogueEntry(id: string): CatalogueEntry {
  const entry = WIDGET_CATALOGUE.find((w) => w.id === id);
  if (!entry) throw new Error(`no widget "${id}" in the catalogue`);
  return entry;
}
