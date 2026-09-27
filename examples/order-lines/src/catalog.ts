import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// One widget, one loom built-in kind: the "top order's lines" is a plain records table, so no
// framework kind is needed here — this example is about the STATUS channel (ADR 0100's `empty`),
// not the value's shape.
export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.order-lines.v1",
  entries: [
    {
      name: "Collection",
      version: "1.0.0",
      props: ["columns"],
      binding: "required",
      surfaces: { web: { kind: "DataTable" }, terminal: { kind: "DataTable" } },
    },
  ],
});
