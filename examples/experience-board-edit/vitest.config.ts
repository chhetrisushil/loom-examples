import { defineConfig } from "vitest/config";

// Headless: no renderer, so plain Node.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
