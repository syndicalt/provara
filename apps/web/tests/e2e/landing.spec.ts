import { test, expect } from "@playwright/test";

test("landing page renders hero", async ({ page }) => {
  await page.goto("/");
  // Hero copy locked in PR #231 as part of the "Adaptive LLM Gateway"
  // repositioning. The H1 is split into two `<span class="block">`
  // elements so Playwright's `toContainText` sees "The AdaptiveLLM Gateway"
  // (no space between spans in the accessible name). Match the two halves
  // independently so the assertion is robust to styling that adds or
  // removes visual whitespace between the lines.
  const hero = page.getByRole("heading", { level: 1 });
  await expect(hero).toBeVisible();
  await expect(hero).toContainText(/Adaptive/i);
  await expect(hero).toContainText(/LLM Gateway/i);
  // Subhead is a paragraph under the H1 — assert against the page.
  await expect(page.getByText(/Routes every request\. Learns from every response\./i)).toBeVisible();
});

test("landing page has no horizontal scroll at common widths", async ({ page }) => {
  // #118: /docs/api regressed with horizontal scroll; guard against the
  // whole-site version of the same bug regressing.
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll, `horizontal scroll detected at ${width}px`).toBe(false);
  }
});
