import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    pool: "forks", // each test file gets its own process — isolates the judge-config module-level state
    reporters: process.env.CI ? ["dot"] : ["default"],
  },
});
