import type { KpiValue, TableValue, TimeSeriesValue } from "@loom-ui/core";
import { defineReshapers } from "@loom-ui/hydration";

// The host's own reshapers (`reshaping.engine: "Named"`): plain functions from a tool's raw
// output to a widget's value, run in-process on the server — no sandbox hop. What they return is
// then checked against the widget kind's value contract (`outputCheck: "contract"`).
//
// `current-kpi` and `frost-kpi` both read the SAME raw `stations.current` reading (see
// experience.ts) — two widgets, one upstream call — but each reads a DIFFERENT field of it:
// `current-kpi` the air temperature (`tempC`), `frost-kpi` the dew point (`dewPointC`). A garbled
// `tempC` therefore fails only CurrentReading's contract, and a garbled `dewPointC` only
// FrostRisk's — sharing a call is not sharing a fate. Neither reshaper ever COERCES a bad
// reading into a confident answer: a non-number is passed straight through as `value`, so it
// fails the Kpi contract exactly like a garbled `tempC` does, rather than quietly defaulting to
// "no risk".

export const reshapers = defineReshapers({
  "current-kpi": (raw): KpiValue => {
    const r = raw as { tempC: number };
    return { value: r.tempC, unit: "°C", label: "Now" };
  },
  "frost-kpi": (raw): KpiValue => {
    const r = raw as { dewPointC: unknown };
    // Frost risk when the dew point is at or below ~2°C. A non-number dew point is never
    // bucketed into a risk flag (that would silently answer "no risk" for bad data) — it is
    // forwarded as-is, so the Kpi contract below catches it.
    const value = typeof r.dewPointC === "number" ? (r.dewPointC <= 2 ? 1 : 0) : r.dewPointC;
    return { value: value as number, unit: "risk", label: "Frost risk" };
  },
  "series-trend": (raw): TimeSeriesValue => {
    const r = raw as { samples: Array<{ at: string; tempC: number }> };
    return {
      series: [
        {
          label: "Temperature",
          unit: "°C",
          points: r.samples.map((s) => ({ timestamp: s.at, value: s.tempC })),
        },
      ],
    };
  },
  "alerts-table": (raw): TableValue => {
    const r = raw as { alerts: Array<{ at: string; level: string }> };
    return { columns: ["At", "Level"], rows: r.alerts.map((a) => [a.at, a.level]) };
  },
});
