import { test, expect } from "@playwright/test";

test("landing page renders hero", async ({ page }) => {
  await page.goto("/");
  // Hero copy was the subject of three separate UAT iterations (#91, #93, #94).
  // Lock it in so future changes don't silently revert the title-cased line break.
  const hero = page.getByRole("heading", { level: 1 });
  await expect(hero).toBeVisible();
  await expect(hero).toContainText(/One Gateway/i);
  await expect(hero).toContainText(/Smarter with Every Request/i);
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
