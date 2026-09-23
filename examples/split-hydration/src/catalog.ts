import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// A weather station's vocabulary. Each type resolves to one of loom-ui's framework kinds on the
// web, declaring the kind's loom contract (ADR 0088 D2: props AND binding). The kind is also what
// a `"contract"` provider's value is checked against when this board is hydrated for the web.
const KPI: KindContract = { kind: "Kpi", props: ["unit", "format"], binding: "required" };
const TIME_SERIES: KindContract = {
  kind: "TimeSeries",
  props: ["unit", "format"],
  binding: "required",
};
const TABLE: KindContract = { kind: "Table", props: [], binding: "required" };

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.weather.v1",
  entries: [
    {
      name: "CurrentReading",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: KPI },
    },
    // Shares the SAME upstream reading as CurrentReading (see experience.ts): a second widget
    // reading the temperature a different way, not a second call to the station.
    { name: "FrostRisk", version: "1.0.0", props: [], binding: "required", surfaces: { web: KPI } },
    {
      name: "TemperatureTrend",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: TIME_SERIES },
    },
    {
      name: "AlertLog",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: TABLE },
    },
  ],
});
