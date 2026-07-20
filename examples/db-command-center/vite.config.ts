import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// React MUST be a singleton. @loom/plugin-renderer-react is consumed via a link:
// to the sibling ../loom checkout, whose built hooks import React from ../loom's
// own node_modules — while this app's react-dom would resolve React here. Two
// copies ⇒ a null hooks dispatcher ("Cannot read properties of null (reading
// 'useState')") the moment a renderer-react hook mounts under react-dom.
//
// Converge EVERYTHING on the copy the linked package already uses: resolve each
// react/react-dom specifier FROM renderer-react's location and alias to it, so
// the app's react-dom and the linked hooks share one React. Portable — derived
// from the linked package, no hardcoded paths.
const require = createRequire(import.meta.url);
const fromRenderer = createRequire(require.resolve("@loom/plugin-renderer-react"));
// Most-specific specifiers FIRST — vite matches a bare `react` alias against
// `react/jsx-runtime` by prefix and would clobber it otherwise.
const reactSingleton = [
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
  "react-dom/client",
  "react-dom/test-utils",
  "react-dom",
  "react",
].map((id) => ({ find: id, replacement: fromRenderer.resolve(id) }));

// The @loom/* workspace packages ship CommonJS. Vite pre-bundles them in dev via
// optimizeDeps, but `vite build` (build:ui) hands them to Rollup, whose CommonJS
// interop cannot statically trace named exports through the transitive re-export
// getter chain. transformMixedEsModules lets the CommonJS plugin resolve them.
//
// NB: this example does NOT enable @loom/compiler's loomPlugin(). Its build-time
// handler$ extraction hoists each handler body into a virtual chunk, which can't
// re-resolve the shared modules our handlers import (the diagnostics ReAct
// runner, the mock tools, the LLM provider). handler$ works fine at runtime
// without it — LazyEffect resolves the HandlerRef directly. See
// examples/cloud-command-center for the loomPlugin() compiler demo.
//
// @loom/plugin-a2a supplies types (import type …, fully elided) AND one runtime value —
// `toAgentCard` in src/agents/definitions.ts. Because the @loom/* packages ship
// CommonJS, that value import must be pre-bundled by optimizeDeps too, or Vite
// serves the raw CJS dist as ESM and the named export can't be traced. Its Node
// http server is only reached via `import type`, so it never enters the bundle.
export default defineConfig({
  plugins: [react()],
  // React must be a singleton. The @loom/plugin-renderer-react hooks are consumed
  // via a link: to the sibling ../loom checkout, which has its OWN node_modules —
  // so without dedupe the linked hook resolves React from ../loom while the app's
  // react-dom resolves it here, giving two copies and a null hooks dispatcher.
  resolve: { conditions: ["require", "default"], alias: reactSingleton },
  optimizeDeps: {
    include: [
      "@loom/app",
      "@loom/plugin-a2a/cards",
      "@loom/a2ui",
      "@loom/agent",
      "@loom/blueprint-runtime",
      "@loom/capability",
      "@loom/core",
      "@loom/effect-runtime",
      // Browser-safe subpaths only — the package barrels eagerly re-export the
      // SQLite stores (better-sqlite3 / node:fs), which must never enter a browser
      // bundle. The in-memory storage + pure sequence helpers are all this app uses.
      "@loom/event-runtime/memory",
      "@loom/event-runtime/sequence",
      "@loom/intent",
      "@loom/llm",
      "@loom/orchestrator",
      "@loom/planner",
      "@loom/projection-runtime",
      "@loom/registry",
      "@loom/plugin-renderer-react",
      "@loom/snapshot-runtime/memory",
      "@loom/workflow-runtime",
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/],
    },
  },
});
