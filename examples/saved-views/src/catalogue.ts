import { defineWidgetCatalog } from "@loom/blueprint-runtime";

// ── The vocabulary a composer may assemble from ──────────────────────────────
//
// Closed, and the app's own: loom checks the catalogue it is given and does not define one
// (ADR 0088 D2). Both fields of an entry are required — an entry that declined to say which
// props it accepts would pass the payload check vacuously, and a check that cannot fail
// reads as coverage while verifying nothing.
//
// `binding: "required"` is the exfiltration boundary in disguise. A blueprint declares what
// to FETCH, never what was fetched, which is what lets one artifact be shared and hydrated
// separately against each viewer. A composer that inlines a fetched row into `props` gets an
// `undeclared-prop` error rather than a shareable copy of one viewer's data.

export const CATALOG_ID = "saved-views.v1";

export const catalogue = defineWidgetCatalog({
  id: CATALOG_ID,
  entries: [
    { kind: "MetricCard", props: ["unit", "format"], binding: "required" },
    { kind: "StatusBadge", props: [], binding: "required" },
    { kind: "DataTable", props: ["columns"], binding: "required" },
  ],
});
