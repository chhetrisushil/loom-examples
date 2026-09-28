import {
  type Blueprint,
  type DataBinding,
  DataTable,
  MetricCard,
  ProgressBar,
  StatusBadge,
  type Widget,
  blueprint$,
  cell,
  grid,
} from "@loom/blueprint-runtime";
import { HEALTH_PROJECTION_ID } from "./health";

// ── The Blueprint says everything the renderer needs (IR 2 — ADR 0097) ───────────────
// • spans are grid CELLS (`cell(span, widget)`), never a prop the catalogue would refuse;
// • a bound widget names its value path AND its status path in the same projection state;
// • a widget that stands for something the surface cannot draw says so in `source`.
// A renderer reads the Blueprint alone — there is no side channel back into the app.

/** Value + status channel for one key of the health projection. */
export const channelled = (key: string): DataBinding => ({
  projectionId: HEALTH_PROJECTION_ID,
  path: `values.${key}`,
  status: { path: `status.${key}` },
});

/** Value only — the status channel is OPT-IN; this widget renders as it did under IR 1.0.0. */
export const valueOnly = (key: string): DataBinding => ({
  projectionId: HEALTH_PROJECTION_ID,
  path: `values.${key}`,
});

export interface HealthBoardOptions {
  readonly projectionVersions?: Readonly<Record<string, string>>;
}

export function healthBoard(opts: HealthBoardOptions = {}): Blueprint {
  // The error table stands for a semantic "Trend" this text surface cannot chart; it was
  // degraded through "Collection" to a DataTable. The Blueprint carries that provenance so a
  // renderer can say "(degraded from …)" instead of presenting the table as the intent.
  const errors: Widget = {
    ...DataTable({
      id: "errors",
      title: "Top errors",
      binding: channelled("errors"),
      columns: ["code", "count"],
    }),
    source: {
      type: "Trend",
      version: "1.0.0",
      degradedFrom: [{ type: "Collection", version: "1.0.0" }],
    },
  };
  return blueprint$({
    id: "health-board",
    title: "Service health",
    projections: [HEALTH_PROJECTION_ID],
    ...(opts.projectionVersions !== undefined && { projectionVersions: opts.projectionVersions }),
    layout: grid({
      columns: 12,
      children: [
        cell(
          4,
          MetricCard({
            id: "latency",
            title: "Latency p99",
            binding: channelled("latency"),
            unit: "ms",
          })
        ),
        cell(4, StatusBadge({ id: "ingest", title: "Ingest", binding: channelled("ingest") })),
        cell(4, ProgressBar({ id: "disk", title: "Disk", binding: channelled("disk"), max: 100 })),
        cell(8, errors),
        cell(4, MetricCard({ id: "queue", title: "Queue depth", binding: valueOnly("queue") })),
      ],
    }),
  });
}
