import { defineConfig } from "vitest/config";

// Headless: plain Node, a real HTTP server on an ephemeral port. Waits are bounded at 4 s (client.ts), under vitest's default 5 s.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
