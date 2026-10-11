import { defineConfig } from "vitest/config";

// renderer-lit is ESM built with moduleResolution "Bundler": its dist has extensionless relative
// imports that plain Node ESM cannot resolve, so vitest must run it through Vite's resolver
// (inline) instead of externalising it. Lit itself is ESM-only and rides along.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: [/@loom-ui\/renderer-lit/, /^lit/, /@lit\//] } },
  },
});
