import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["**/__tests__/**/*.test.ts"],
    environment: "node",
    // These are geometry tests: a single case can drive a full Manifold
    // level-set or lattice fill. The 5 s default made the suite pass or fail
    // by machine speed, which is not a signal about the code.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
