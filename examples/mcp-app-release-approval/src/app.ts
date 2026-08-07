import { type LoomApp, defineConfig } from "@loom/app";
import { RegisteredReleaseFlow } from "./flow";

// ── Composition root ─────────────────────────────────────────────────────────
//
// In-memory stores, the WorkflowRuntime, and the native "ui" agent surface the
// flow drives via `ctx.ui.*`.
//
// Nothing MCP-specific is wired here. `@loom/plugin-mcp-app` folds the raw event
// stream itself, so it works against any Loom app that emits surface patches —
// the same property that let the A2UI adapter stay a pure read-side projection.
// Serving is composed separately, in src/server.ts.
export function buildApp(): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
    flows: [RegisteredReleaseFlow],
    surfaces: ["ui"],
  });
}
