import { badge, bind, button, column, list, text } from "@loom/plugin-a2ui";
import type { ComponentInstance } from "@loom/plugin-a2ui";

// ── The view: data, not code ─────────────────────────────────────────────────
//
// MCP Apps ships HTML, which is exactly the property A2UI deliberately lacks.
// `@loom/plugin-mcp-app` neutralises it by never generating markup per flow: ONE
// static template renders whatever declarative tree arrives as `structuredContent`.
//
// So this file — an ordinary A2UI component tree, the same vocabulary the
// `a2ui-egress` example uses — IS the UI. Nothing here is compiled, bundled, or
// shipped as script. The template is a catalog renderer; this is its input.
//
//   • Exactly one node has `id: "root"`.
//   • The tree is an adjacency list — parents reference children by id.
//   • `bind("/a/b")` binds a prop to a JSON Pointer into the data model.
//   • The Button names the tool a click invokes on the server.
export const RELEASE_VIEW: ComponentInstance[] = [
  column("root", ["title", "status", "notice", "checksHeading", "checks", "approve"]),
  text("title", bind("/title")),
  badge("status", bind("/status")),
  text("notice", bind("/notice")),
  text("checksHeading", "Checks"),
  list("checks", "/checks", "checkItem"),
  text("checkItem", bind("")),
  button("approve", "Approve", "approve"),
];
