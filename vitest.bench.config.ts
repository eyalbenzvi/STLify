import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Separate config for the performance-budget suite (`npm run bench`).
 *
 * Kept OUT of `npm test` on purpose: wall-clock assertions are machine-
 * sensitive, and the correctness gate must never flake because a laptop
 * throttled. The budgets in bench/perf.bench.ts are set an order of
 * magnitude above healthy numbers, so what they catch is the class of
 * regression that ships silently — a pick that went back to a linear scan,
 * a rebuild that stopped being incremental — not a 10% wobble.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["bench/**/*.bench.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
