import { test, expect } from "@playwright/test";

/**
 * Guards the /docs/api regressions we fought through #110 and #118:
 * - No empty viewport-height gap above content
 * - No horizontal scroll
 */
test("/docs/api mounts Scalar without a full-viewport empty block above", async ({ page }) => {
  // Serve the OpenAPI spec locally so Scalar can render it.
  await page.route("**/openapi.yaml", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-yaml",
      body: "openapi: 3.0.3\ninfo:\n  title: Test\n  version: 0.0.0\npaths: {}\n",
    }),
  );
  await page.goto("/docs/api");

  // Scalar's React component mounts inside our wrapper div. Even before full
  // content loads, there should not be a 100vh blank region at the top of
  // the document. Check that *some* Scalar content is within the first
  // viewport.
  await page.waitForTimeout(2000); // give Scalar time to render
  const firstVisibleText = await page.evaluate(() => {
    const vh = window.innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const text = node.textContent?.trim() || "";
      if (rect.top >= 0 && rect.top < vh && text.length > 0) {
        return { top: rect.top, text: text.slice(0, 40) };
      }
    }
    return null;
  });
  // If the only visible text is far below the fold, we've regressed.
  expect(firstVisibleText, "no visible text in first viewport").not.toBeNull();
  expect(firstVisibleText!.top).toBeLessThan(400);
});

test("/docs/api has no horizontal scroll", async ({ page }) => {
  await page.route("**/openapi.yaml", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-yaml",
      body: "openapi: 3.0.3\ninfo:\n  title: Test\n  version: 0.0.0\npaths: {}\n",
    }),
  );

  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/docs/api");
    await page.waitForTimeout(1500);
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll, `horizontal scroll at ${width}px`).toBe(false);
  }
});
