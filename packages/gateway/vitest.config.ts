import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    pool: "forks", // each test file gets its own process — isolates the judge-config module-level state
    reporters: process.env.CI ? ["dot"] : ["default"],
    // 30s per test. Some tests in usage-metering.test.ts seed 100k+
    // request rows via batched inserts; on slower CI runners the 5s
    // default timed out during the seeding phase even though the test
    // logic itself was fine. Bumping the default is simpler (and
    // consistent) than decorating each heavy test with a per-call override.
    testTimeout: 30_000,
  },
});
