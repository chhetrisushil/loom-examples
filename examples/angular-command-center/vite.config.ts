import angular from "@analogjs/vite-plugin-angular";
import { defineConfig } from "vite";

// The @loomwork/* workspace packages ship CommonJS (dist/index.js). Vite pre-bundles
// them in dev via optimizeDeps, but the production `vite build` hands them to
// Rollup, whose CommonJS interop cannot statically trace named exports through
// the transitive re-export getter chain (index → builders → flow …), failing
// with "step$ is not exported by dist/index.js". transformMixedEsModules lets
// the CommonJS plugin resolve those named exports.
const loomPackages = [
  "@loomwork/app",
  "@loomwork/core",
  "@loomwork/effect-runtime",
  // Browser-safe subpaths only — the package barrels eagerly re-export the SQLite
  // stores (better-sqlite3 / node:fs), which must never enter a browser bundle.
  // The in-memory storage + pure sequence helpers are all this app uses.
  "@loomwork/event-runtime/memory",
  "@loomwork/event-runtime/sequence",
  "@loomwork/projection-runtime",
  "@loomwork/snapshot-runtime/memory",
  "@loomwork/telemetry",
  "@loomwork/workflow-runtime",
];

export default defineConfig({
  plugins: [angular()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: loomPackages,
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/],
    },
  },
});
