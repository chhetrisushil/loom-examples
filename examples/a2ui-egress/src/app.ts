import { type LoomApp, defineConfig } from "@loom/app";
import { RegisteredExpenseFlow } from "./flow";

// ── Composition root ──────────────────────────────────────────────────────────
//
// A single `defineConfig` assembles the in-memory stores, the WorkflowRuntime,
// and the projection runtime. `surfaces: ["ui"]` registers the native agent
// surface the flow drives via `ctx.ui.*` — the same "ui" surface the
// A2UISurfaceBridge bridges by default. The A2UI projection is NOT wired here:
// the bridge folds the raw event stream itself, so it works against any Loom app
// that emits surface patches, with zero kernel involvement.
export function buildApp(): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
    flows: [RegisteredExpenseFlow],
    surfaces: ["ui"],
  });
}
