import { test, expect } from "@playwright/test";

/**
 * Minimal-but-realistic OpenAPI with info + at least one path. An empty
 * `paths: {}` doesn't trigger Scalar's hero layout (which is what produces
 * the section-flare that regressed twice). This spec exercises the same
 * code path the real Provara spec does on prod.
 */
const OPENAPI_WITH_PATHS = `openapi: 3.0.3
info:
  title: Test API
  version: 0.1.0
  description: Minimal spec used to exercise Scalar's hero + section-flare rendering.
paths:
  /health:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
  /v1/echo:
    post:
      summary: Echo
      responses:
        "200":
          description: Echoed
`;

function stubSpec(page: import("@playwright/test").Page) {
  return page.route("**/openapi.yaml", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-yaml",
      body: OPENAPI_WITH_PATHS,
    }),
  );
}

/**
 * Guards /docs/api regressions — #110 (CDN→classic), #118 (React component),
 * and #134 (section-flare eating the fold). The earlier version of this
 * test stubbed `paths: {}`, which hid the bug from #134 because Scalar's
 * hero layout doesn't activate without any paths.
 */
test("/docs/api: hero h1 renders within the first viewport", async ({ page }) => {
  await stubSpec(page);
  await page.goto("/docs/api");
  await page.waitForTimeout(2500);

  // The spec's title becomes an h1 with class `section-header-label`.
  // When the section-flare bug is present, this h1 sits at ~1000+ pixels.
  const h1 = await page.evaluate(() => {
    const el = document.querySelector("h1.section-header-label");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { top: Math.round(rect.top), text: el.textContent?.trim() || "" };
  });
  expect(h1, "no h1.section-header-label found — Scalar never rendered the hero").not.toBeNull();
  expect(h1!.text).toContain("Test API");
  // Allow some top margin/padding but reject the ~1000px flare gap.
  expect(h1!.top, `h1 at ${h1!.top}px — likely pushed below the fold by section-flare`).toBeLessThan(400);
});

test("/docs/api: some visible text in the first viewport", async ({ page }) => {
  await stubSpec(page);
  await page.goto("/docs/api");
  await page.waitForTimeout(2000);

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
  expect(firstVisibleText, "no visible text in first viewport").not.toBeNull();
  expect(firstVisibleText!.top).toBeLessThan(400);
});

test("/docs/api: no horizontal scroll at common widths", async ({ page }) => {
  await stubSpec(page);
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
