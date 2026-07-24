import { bind, column, text } from "@loom/plugin-a2ui";
import type { ComponentInstance } from "@loom/plugin-a2ui";

// ── The A2UI view (the "component tree") ──────────────────────────────────────
//
// The bridge sends this once in `createSurface`, then streams the surface data
// separately as `updateDataModel`. The `callFunction` requests this example
// demonstrates are a separate, agent-initiated RPC (see flow.ts / main.ts), not
// something a component emits — so this view is pure display.
export const CHECKOUT_VIEW: ComponentInstance[] = [
  column("root", [
    "cartId",
    "status",
    "totalLabel",
    "total",
    "localeLabel",
    "locale",
    "confirmation",
  ]),
  text("cartId", bind("/cartId")),
  text("status", bind("/status")),
  text("totalLabel", "Total"),
  text("total", bind("/summary/total")),
  text("localeLabel", "Locale"),
  text("locale", bind("/summary/locale")),
  text("confirmation", bind("/summary/confirmationId")),
];
