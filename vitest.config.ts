import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ledger tests hit a real Postgres and share tables, so run serially
    // to keep truncation between tests deterministic.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
