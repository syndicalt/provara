import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { feedback, requests } from "@provara/db";
import { nanoid } from "nanoid";
import { createFeedbackRoutes } from "../src/routes/feedback.js";
import { createAdaptiveRouter } from "../src/routing/adaptive.js";
import { makeTestDb } from "./_setup/db.js";

async function buildTestApp() {
  const db = await makeTestDb();
  const adaptive = await createAdaptiveRouter(db);
  const app = new Hono();
  app.route("/v1/feedback", createFeedbackRoutes(db, adaptive));
  return { db, app };
}

describe("GET /v1/feedback/quality/trend", () => {
  it("buckets feedback across distinct days (regression: #89)", async () => {
    const { db, app } = await buildTestApp();

    // Seed a parent request so the feedback rows can reference a real request_id
    const requestId = nanoid();
    await db.insert(requests).values({
      id: requestId,
      provider: "openai",
      model: "gpt-4.1-nano",
      prompt: "test",
      response: "ok",
    }).run();

    // Three feedback rows on three different days (5 days ago, 3 days ago, today)
    const dayMs = 86_400_000;
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * dayMs);

    for (const [offset, score] of [[5, 3], [3, 4], [0, 5]] as const) {
      await db.insert(feedback).values({
        id: nanoid(),
        requestId,
        score,
        source: "user",
        createdAt: daysAgo(offset),
      }).run();
    }

    const res = await app.request("/v1/feedback/quality/trend?range=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series: { bucket: string; avgScore: number; count: number }[];
      range: string;
    };

    // Three rows on three distinct days must yield three buckets — this would have been
    // 1 bucket before the fix because every row collapsed to 1970-01-21.
    expect(body.series.length).toBe(3);

    // Buckets should be YYYY-MM-DD strings, all within the current decade (rules out the
    // 1970 collapse).
    for (const row of body.series) {
      expect(row.bucket).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
    }
  });

  it("accepts range=24h and returns hourly buckets", async () => {
    const { db, app } = await buildTestApp();
    const requestId = nanoid();
    await db.insert(requests).values({
      id: requestId,
      provider: "openai",
      model: "gpt-4.1-nano",
      prompt: "test",
      response: "ok",
    }).run();

    // Two rows an hour apart in the last 24h
    await db.insert(feedback).values({
      id: nanoid(),
      requestId,
      score: 4,
      source: "user",
      createdAt: new Date(Date.now() - 2 * 3600_000),
    }).run();
    await db.insert(feedback).values({
      id: nanoid(),
      requestId,
      score: 5,
      source: "user",
      createdAt: new Date(Date.now() - 1 * 3600_000),
    }).run();

    const res = await app.request("/v1/feedback/quality/trend?range=24h");
    const body = (await res.json()) as { series: { bucket: string }[] };
    expect(body.series.length).toBeGreaterThanOrEqual(2);
    for (const row of body.series) {
      expect(row.bucket).toMatch(/^20\d{2}-\d{2}-\d{2} \d{2}:00$/);
    }
  });
});
