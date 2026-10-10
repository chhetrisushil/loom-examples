import { defineConfig } from "vitest/config";

// Headless: plain Node, a real HTTP server on an ephemeral port. A hang fails at the (generous) timeout.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
