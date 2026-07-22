import { badge, bind, button, column, list, text } from "@loom/plugin-a2ui";
import type { ComponentInstance } from "@loom/plugin-a2ui";

// ── The A2UI view (the "component tree") ──────────────────────────────────────
//
// A2UI is a component-tree + data-model protocol: the agent describes the UI
// declaratively (components drawn from a catalog, bound to a data model by JSON
// Pointer) and any compliant client renders it — no code is ever shipped. The
// bridge sends this tree once in `createSurface`, then streams the surface data
// separately as `updateDataModel`.
//
// Rules worth noting:
//   • Exactly one node has `id: "root"`.
//   • The tree is an adjacency list — parents reference children by id, never nest.
//   • `bind("/a/b")` binds a prop to a JSON Pointer into the data model; a bare
//     value is a literal. Inside a `list`, a relative `bind("")` resolves to the
//     current element (A2UI collection scope).
//   • The Button declares the inbound `action` a client raises back — the only
//     inbound leg this egress adapter supports.
export const EXPENSE_VIEW: ComponentInstance[] = [
  column("root", ["title", "status", "amountLabel", "amount", "logHeading", "log", "approve"]),
  text("title", bind("/title")),
  badge("status", bind("/status")),
  text("amountLabel", "Total"),
  text("amount", bind("/stats/amount")),
  text("logHeading", "Activity"),
  list("log", "/progressLog", "logItem"),
  text("logItem", bind("")),
  button("approve", "Approve", "approve"),
];
