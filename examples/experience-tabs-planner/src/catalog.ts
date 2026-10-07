import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// A support-ticket triage vocabulary: a headline number, a list, and a free-text memo. All three
// resolve to loom-ui's generic kinds (`MetricCard`, `DataTable`, `Note`) on both surfaces.
export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.ticket-triage.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      // The model MAY propose a class, but a node bound to a capability is classed at least
      // `capability.sensitivity` by the planner (and again at read time by `declaredToolClasses`).
      sensitivity: "model-may-set",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
    {
      name: "Collection",
      version: "1.0.0",
      props: ["columns"],
      binding: "required",
      surfaces: { web: { kind: "DataTable" }, terminal: { kind: "DataTable" } },
    },
    {
      name: "Memo",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"],
      binding: "none",
      surfaces: {
        web: { kind: "Note", props: ["text"], binding: "none" },
        terminal: { kind: "Note", props: ["text"], binding: "none" },
      },
    },
  ],
});
