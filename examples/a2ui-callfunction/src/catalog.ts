import {
  DEFAULT_CATALOG_ID,
  defaultCatalog,
  defineCatalog,
  defineFunction,
} from "@loom/plugin-a2ui";
import type { A2UICatalog } from "@loom/plugin-a2ui";

// ── The A2UI catalog, extended with client-callable `functions` ────────────────
//
// A2UI catalogs declare not just renderable components but the `functions` the
// agent may invoke on the client via `callFunction`. This example declares two:
//
//   • getLocale     — a READ (idempotent): return the client's locale. Safe to
//                     re-issue, so the flow drives it through a suspend/resume
//                     gate (grain A).
//   • confirmSubmit — a SIDE EFFECT (non-idempotent): confirm and submit an
//                     order. The flow drives it through a delegated effect
//                     (grain B) so a crash mid-call parks at EFFECT_INDOUBT.
//
// `defineFunction` is an identity helper that gives the declaration its type;
// the args/returns bodies are JSON-Schema documents (kept loose here).
export const CHECKOUT_CATALOG: A2UICatalog = defineCatalog({
  ...defaultCatalog,
  id: DEFAULT_CATALOG_ID,
  functions: {
    getLocale: defineFunction({
      name: "getLocale",
      args: { type: "object", properties: {} },
      returns: {
        type: "object",
        properties: { locale: { type: "string" } },
        required: ["locale"],
      },
    }),
    confirmSubmit: defineFunction({
      name: "confirmSubmit",
      args: {
        type: "object",
        properties: { total: { type: "number" }, locale: { type: "string" } },
        required: ["total"],
      },
      returns: {
        type: "object",
        properties: { confirmationId: { type: "string" }, submitted: { type: "boolean" } },
        required: ["confirmationId", "submitted"],
      },
      callableFrom: "root",
    }),
  },
});
