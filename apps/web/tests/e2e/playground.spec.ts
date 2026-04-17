import { test, expect } from "@playwright/test";

/**
 * Stubs all gateway calls the playground needs before the SSE stream. We
 * don't stub the streaming /v1/chat/completions endpoint itself because
 * Playwright's route interception doesn't cleanly replay SSE chunks — we
 * cover send-and-receive behavior in component tests, and use e2e to
 * catch layout/focus regressions instead.
 */
async function stubGateway(page: import("@playwright/test").Page) {
  await page.route("**/v1/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          { name: "openai", models: ["gpt-4.1-nano", "gpt-4o"] },
          { name: "anthropic", models: ["claude-sonnet-4-6"] },
        ],
      }),
    }),
  );
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null }),
    }),
  );
}

test("playground mounts with input focused (regression guard for #99)", async ({ page }) => {
  await stubGateway(page);
  await page.goto("/dashboard/playground");

  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible();
  // The focus refocus effect fires on mount (streaming starts false).
  await expect(textarea).toBeFocused();
});

test("playground model selector shows stubbed providers", async ({ page }) => {
  await stubGateway(page);
  await page.goto("/dashboard/playground");

  const modelSelect = page.locator("select").first();
  await expect(modelSelect).toBeVisible();
  // Auto-routing option is always present
  await expect(page.getByRole("option", { name: /Auto-routing/ })).toBeAttached();
  // Stubbed models should appear
  await expect(page.getByRole("option", { name: "gpt-4o" })).toBeAttached();
  await expect(page.getByRole("option", { name: "claude-sonnet-4-6" })).toBeAttached();
});

test("send button is disabled when input is empty", async ({ page }) => {
  await stubGateway(page);
  await page.goto("/dashboard/playground");

  const sendButton = page.getByRole("button", { name: /Send/i });
  await expect(sendButton).toBeDisabled();

  await page.locator("textarea").first().fill("hello");
  await expect(sendButton).toBeEnabled();
});
