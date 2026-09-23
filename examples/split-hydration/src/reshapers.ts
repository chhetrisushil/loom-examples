import type { KpiValue, TableValue, TimeSeriesValue } from "@loom-ui/core";
import { defineReshapers } from "@loom-ui/hydration";

// The host's own reshapers (`reshaping.engine: "Named"`): plain functions from a tool's raw
// output to a widget's value, run in-process on the server — no sandbox hop. What they return is
// then checked against the widget kind's value contract (`outputCheck: "contract"`).
//
// `current-kpi` and `frost-kpi` both read the SAME raw `stations.current` reading (see
// experience.ts): two widgets, one upstream call. They needn't even agree on how strict they are
// about it — `current-kpi` reports the reading as-is (and so drifts if it cannot be drawn),
// `frost-kpi` only asks whether it is a number below freezing risk, so a garbled reading fails one
// widget's contract without necessarily failing the other's.

export const reshapers = defineReshapers({
  "current-kpi": (raw): KpiValue => {
    const r = raw as { tempC: number };
    return { value: r.tempC, unit: "°C", label: "Now" };
  },
  "frost-kpi": (raw): KpiValue => {
    const r = raw as { tempC: unknown };
    const risk = typeof r.tempC === "number" && r.tempC < 10 ? 1 : 0;
    return { value: risk, unit: "risk", label: "Frost risk" };
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
