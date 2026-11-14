import { loomPlugin } from "@loomwork/compiler";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The @loomwork/* workspace packages ship CommonJS. Vite pre-bundles them in dev via
// optimizeDeps, but `vite build` (build:ui) hands them to Rollup, whose CommonJS
// interop cannot statically trace named exports through the transitive re-export
// getter chain (e.g. "LlmEffect is not exported by dist/index.js").
// transformMixedEsModules lets the CommonJS plugin resolve those named exports.
export default defineConfig({
  plugins: [loomPlugin(), react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loomwork/app",
      "@loomwork/agent-surface",
      "@loomwork/agent",
      "@loomwork/blueprint-runtime",
      "@loomwork/capability",
      "@loomwork/core",
      "@loomwork/effect-runtime",
      "@loomwork/event-runtime",
      "@loomwork/intent",
      "@loomwork/llm",
      "@loomwork/projection-runtime",
      "@loomwork/plugin-renderer-react",
      "@loomwork/snapshot-runtime",
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
