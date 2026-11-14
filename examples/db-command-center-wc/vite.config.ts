import { defineConfig } from "vite";

// No framework plugin — this app is plain Web Components (Custom Elements) over
// the framework-agnostic Loom render primitives (traverseBlueprint /
// resolveWidgetValue / ProjectionRuntime).
//
// The @loomwork/* workspace packages ship CommonJS; transformMixedEsModules lets
// Rollup trace their named exports through the re-export getter chain during
// `vite build`. @loomwork/plugin-a2a supplies types plus one runtime value (`toAgentCard`
// in src/agents/definitions.ts), so it must be pre-bundled by optimizeDeps like
// the other CJS packages; its Node http server is only reached via `import type`
// and never enters the bundle.
export default defineConfig({
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loomwork/app",
      "@loomwork/plugin-a2a/cards",
      "@loomwork/agent-surface",
      "@loomwork/agent",
      "@loomwork/blueprint-runtime",
      "@loomwork/capability",
      "@loomwork/core",
      "@loomwork/effect-runtime",
      // Browser-safe subpaths only — the package barrels eagerly re-export the
      // SQLite stores (better-sqlite3 / node:fs), which must never enter a browser
      // bundle. The in-memory storage + pure sequence helpers are all this app uses.
      "@loomwork/event-runtime/memory",
      "@loomwork/event-runtime/sequence",
      "@loomwork/intent",
      "@loomwork/llm",
      "@loomwork/planner",
      "@loomwork/projection-runtime",
      "@loomwork/registry",
      "@loomwork/snapshot-runtime/memory",
      "@loomwork/workflow-runtime",
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/],
    },
  },
});
