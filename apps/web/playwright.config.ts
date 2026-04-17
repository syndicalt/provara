import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests hit a real Next.js dev server on port 3001. They run serially
 * by default to keep ordering predictable on the shared dev server. CI
 * installs the Chromium browser; locally, you must run `npx playwright
 * install chromium` once before `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
    // Gateway calls from the browser hit a mock server via route interception
    // in tests that need it — we don't stand up the real gateway for e2e.
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    port: 3001,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
