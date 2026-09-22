import type { WidgetValueCheck } from "@loom/plugin-renderer-terminal";

// ── The app's value contract, in loom's `check` seam ──────────────────────────
// loom's matrix runs this between `error` and `stale`, and ONLY for a widget that declares a
// status channel (ADR 0097 §5). An absent value is "not arrived", never a contract violation.

const expects: Record<string, { test: (v: unknown) => boolean; name: string }> = {
  MetricCard: { test: (v) => typeof v === "number" && !Number.isNaN(v), name: "a number" },
  ProgressBar: { test: (v) => typeof v === "number" && !Number.isNaN(v), name: "a number" },
  DataTable: { test: (v) => Array.isArray(v), name: "an array of rows" },
};

export const valueContract: WidgetValueCheck = (widget, value) => {
  if (value === undefined) return undefined;
  const rule = expects[widget.kind];
  if (rule === undefined || rule.test(value)) return undefined;
  const title = widget.title ?? widget.kind;
  return {
    code: "value-contract",
    message: `${title} expects ${rule.name}, got ${Array.isArray(value) ? "array" : typeof value}`,
  };
};
