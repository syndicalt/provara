import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { feedback, requests } from "@provara/db";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
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

async function seedRequest(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const id = nanoid();
  await db.insert(requests).values({
    id,
    provider: "openai",
    model: "gpt-4.1-nano",
    prompt: "test",
    response: "ok",
    taskType: "general",
    complexity: "medium",
  }).run();
  return id;
}

describe("POST /v1/feedback (#95 upsert)", () => {
  it("second rating for the same request updates the existing row in place", async () => {
    const { db, app } = await buildTestApp();
    const requestId = await seedRequest(db);

    // First rating — inserts
    const first = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, score: 4 }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; score: number; updated: boolean };
    expect(firstBody.score).toBe(4);
    expect(firstBody.updated).toBe(false);

    // Second rating — updates
    const second = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, score: 2 }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id: string; score: number; updated: boolean };
    expect(secondBody.score).toBe(2);
    expect(secondBody.updated).toBe(true);
    expect(secondBody.id).toBe(firstBody.id); // same row

    // DB-level assertion: exactly one user-source row for this request, with the latest score
    const rows = await db.select().from(feedback).where(eq(feedback.requestId, requestId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0].score).toBe(2);
  });

  it("rejects invalid scores and leaves the existing rating untouched", async () => {
    const { db, app } = await buildTestApp();
    const requestId = await seedRequest(db);

    await app.request("/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, score: 3 }),
    });

    const bad = await app.request("/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, score: 7 }),
    });
    expect(bad.status).toBe(400);

    const rows = await db.select().from(feedback).where(eq(feedback.requestId, requestId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0].score).toBe(3);
  });
});
