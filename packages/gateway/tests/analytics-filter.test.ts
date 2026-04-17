import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requests } from "@provara/db";
import { nanoid } from "nanoid";
import { createAnalyticsRoutes } from "../src/routes/analytics.js";
import { makeTestDb } from "./_setup/db.js";

async function buildApp() {
  const db = await makeTestDb();
  const app = new Hono();
  app.route("/v1/analytics", createAnalyticsRoutes(db));
  return { db, app };
}

async function seed(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  rows: Array<{ provider: string; model: string; taskType?: string }>,
) {
  for (const r of rows) {
    await db.insert(requests).values({
      id: nanoid(),
      provider: r.provider,
      model: r.model,
      prompt: "x",
      response: "y",
      taskType: r.taskType ?? null,
      complexity: "simple",
      routedBy: "classification",
      usedFallback: false,
    }).run();
  }
}

describe("/v1/analytics/requests pagination + filter semantics (#140)", () => {
  it("filter is applied in SQL, not post-pagination — total matches filtered count", async () => {
    const { db, app } = await buildApp();
    // 10 openai + 5 anthropic rows, 15 total
    await seed(db, [
      ...Array.from({ length: 10 }, () => ({ provider: "openai", model: "gpt-4o" })),
      ...Array.from({ length: 5 }, () => ({ provider: "anthropic", model: "claude-sonnet-4-6" })),
    ]);

    const res = await app.request("/v1/analytics/requests?provider=anthropic&limit=50");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.requests).toHaveLength(5);
    for (const r of body.requests) {
      expect(r.provider).toBe("anthropic");
    }
  });

  it("combined filters narrow correctly", async () => {
    const { db, app } = await buildApp();
    await seed(db, [
      { provider: "openai", model: "gpt-4o", taskType: "coding" },
      { provider: "openai", model: "gpt-4o", taskType: "creative" },
      { provider: "openai", model: "gpt-4.1-nano", taskType: "coding" },
      { provider: "anthropic", model: "claude-sonnet-4-6", taskType: "coding" },
    ]);

    const res = await app.request("/v1/analytics/requests?provider=openai&taskType=coding");
    const body = await res.json();
    expect(body.total).toBe(2);
    for (const r of body.requests) {
      expect(r.provider).toBe("openai");
      expect(r.taskType).toBe("coding");
    }
  });

  it("pagination across filtered results works — no silent empty pages", async () => {
    const { db, app } = await buildApp();
    await seed(db, [
      ...Array.from({ length: 30 }, () => ({ provider: "openai", model: "gpt-4o" })),
      ...Array.from({ length: 3 }, () => ({ provider: "anthropic", model: "claude-sonnet-4-6" })),
    ]);

    // Anthropic has 3 rows; asking for page size 10 should return 3.
    const page1 = await (await app.request("/v1/analytics/requests?provider=anthropic&limit=10&offset=0")).json();
    expect(page1.total).toBe(3);
    expect(page1.requests).toHaveLength(3);

    // Offset past the end returns empty but total is still correct.
    const page2 = await (await app.request("/v1/analytics/requests?provider=anthropic&limit=10&offset=10")).json();
    expect(page2.total).toBe(3);
    expect(page2.requests).toHaveLength(0);
  });

  it("no filter returns all rows (regression — whereClause undefined branch)", async () => {
    const { db, app } = await buildApp();
    await seed(db, [
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude-sonnet-4-6" },
    ]);

    const body = await (await app.request("/v1/analytics/requests")).json();
    expect(body.total).toBe(2);
    expect(body.requests).toHaveLength(2);
  });
});
