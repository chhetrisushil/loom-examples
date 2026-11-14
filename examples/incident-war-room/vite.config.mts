import { defineConfig } from "vite";

// Client-only Vite config. The durable runtime lives in a separate Node process
// (src/server/main.ts on :8787); the dev client proxies /api to it (SSE included).
//
// @loomwork/* ship CommonJS; transformMixedEsModules lets Rollup trace their named
// exports during `vite build`. Only browser-safe @loomwork/* reach the client bundle
// (the server-only packages are imported solely by src/server/*, which Vite never
// bundles). @loomwork/plugin-a2a is used for its types only (import type …).
export default defineConfig({
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: ["@loomwork/a2ui", "@loomwork/blueprint-runtime", "@loomwork/core", "@loomwork/projection-runtime"],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/],
    },
  },
});
