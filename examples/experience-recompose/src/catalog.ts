import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// The app's semantic vocabulary. `Note` and `Alert` resolve to kinds OUTSIDE loom's built-in
// catalogue (an app-registered NoteInput with a real <textarea>; an unbound Alert), so each
// declares its own contract on the surface (ADR 0088 D2) — the same way a real app grows the
// vocabulary before slice 9 decides what becomes framework-owned.
export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.recompose.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
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
      name: "Status",
      version: "1.0.0",
      props: [],
      binding: "optional",
      surfaces: { web: { kind: "StatusBadge" }, terminal: { kind: "StatusBadge" } },
    },
    {
      name: "Note",
      version: "1.0.0",
      props: ["label"],
      binding: "none",
      surfaces: {
        web: { kind: "NoteInput", props: ["label"], binding: "none" },
        terminal: { kind: "NoteInput", props: ["label"], binding: "none" },
      },
    },
    {
      name: "Alert",
      version: "1.0.0",
      props: ["tone"],
      binding: "none",
      surfaces: {
        web: { kind: "Alert", props: ["tone"], binding: "none" },
        terminal: { kind: "Alert", props: ["tone"], binding: "none" },
      },
    },
  ],
});
