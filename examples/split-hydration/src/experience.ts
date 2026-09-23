import {
  type ContainerNode,
  type Experience,
  type MCPToolNode,
  type ProviderSpec,
  type SemanticNode,
  genesis,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { TOOL_PINS, type ToolName } from "./tools";

// One station, four widgets: the current reading and a frost-risk flag (both P0, both reading
// `stations.current` for the SAME station with the SAME arguments — one upstream step, bound
// twice), a temperature trend over a time range (P1), and the alert log (P2, loaded when scrolled
// into view). Every provider reshapes with a Named reshaper and is checked by its widget's value
// contract. `overridable` says what a load may change: the station everywhere, the window of the
// trend — but not the alert log's own seven-day `since`.

const step = (
  tool: ToolName,
  args: Record<string, unknown>,
  overridable: string[]
): MCPToolNode => ({
  stepId: "read",
  toolName: tool,
  toolVersion: "1.0.0",
  toolSchemaHash: TOOL_PINS[tool],
  arguments: args,
  dependsOn: [],
  idempotent: true,
  overridable,
});

const provider = (
  handle: string,
  s: MCPToolNode,
  reshaper: string,
  ttlSeconds: number
): ProviderSpec => ({
  handle,
  executionGraph: [s],
  reshaping: { engine: "Named", scriptRef: reshaper },
  outputShapeHash: "",
  outputCheck: "contract",
  cachePolicy: { ttlSeconds, scope: "global" },
});

const widget = (
  id: string,
  type: string,
  handle: string,
  priority: "P0" | "P1" | "P2",
  span: number
): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span,
  props: {},
  binding: { handle, priority },
});

export function stationBoard(): Experience {
  const g = genesis({
    experienceId: "station-board",
    intent: { objective: "Watch one weather station", source: "user" },
    meta: { author: "example", createdAt: "2026-09-23T00:00:00Z", sourceKind: "example" },
  });
  // `current` and `frost` read the identical upstream step (same tool, same arguments, same
  // schema pin): the split server's batch pass shares that ONE call between them (memoInvoker,
  // shared by `serveHandles`) — two widgets, one upstream call, whenever they load together.
  const currentReading = step("stations.current", { station: "ridge" }, ["station"]);
  return seal({
    ...g,
    root: {
      ...(g.root as ContainerNode),
      children: [
        widget("a", "CurrentReading", "current", "P0", 4),
        widget("b", "FrostRisk", "frost", "P0", 4),
        widget("c", "TemperatureTrend", "series", "P1", 8),
        widget("d", "AlertLog", "alerts", "P2", 12),
      ],
    },
    providers: {
      current: provider("current", currentReading, "current-kpi", 30),
      frost: provider("frost", { ...currentReading }, "frost-kpi", 30),
      series: provider(
        "series",
        step("stations.series", { station: "ridge", from: "$now-24h", to: "$now" }, [
          "station",
          "from",
          "to",
        ]),
        "series-trend",
        300
      ),
      alerts: provider(
        "alerts",
        step("stations.alerts", { station: "ridge", since: "$now-7d" }, ["station"]),
        "alerts-table",
        60
      ),
    },
  });
}
