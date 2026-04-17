import { Hono } from "hono";
import type { Db } from "@provara/db";
import { feedback, requests } from "@provara/db";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTokenInfo } from "../auth/middleware.js";
import { getTenantId } from "../auth/tenant.js";
import { getJudgeConfig, setJudgeConfig } from "../routing/judge.js";
import type { AdaptiveRouter } from "../routing/adaptive/index.js";

export function createFeedbackRoutes(db: Db, adaptive: AdaptiveRouter) {
  const app = new Hono();

  // Submit feedback for a request
  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      requestId: string;
      score: number;
      comment?: string;
    }>();

    if (!body.requestId || !body.score) {
      return c.json(
        { error: { message: "requestId and score (1-5) are required", type: "validation_error" } },
        400
      );
    }

    if (body.score < 1 || body.score > 5 || !Number.isInteger(body.score)) {
      return c.json(
        { error: { message: "score must be an integer between 1 and 5", type: "validation_error" } },
        400
      );
    }

    // Verify request exists (scoped to tenant)
    const request = await db.select().from(requests).where(tenantId ? and(eq(requests.id, body.requestId), eq(requests.tenantId, tenantId)) : eq(requests.id, body.requestId)).get();
    if (!request) {
      return c.json(
        { error: { message: "Request not found", type: "not_found" } },
        404
      );
    }

    const tokenInfo = getTokenInfo(c.req.raw);
    const resolvedTenant = tenantId || tokenInfo?.tenant || null;

    // Upsert: one user-feedback row per (requestId, tenant). If the caller is
    // updating their rating, patch the existing row in place so we don't flood
    // the table with duplicates. Adaptive updates only fire on first insert —
    // rating changes don't re-push the EMA (avoids double-counting the same
    // signal from the same user).
    const existing = await db
      .select()
      .from(feedback)
      .where(
        and(
          eq(feedback.requestId, body.requestId),
          eq(feedback.source, "user"),
          resolvedTenant ? eq(feedback.tenantId, resolvedTenant) : sql`${feedback.tenantId} IS NULL`,
        ),
      )
      .get();

    if (existing) {
      await db
        .update(feedback)
        .set({ score: body.score, comment: body.comment ?? existing.comment })
        .where(eq(feedback.id, existing.id))
        .run();
      return c.json({ id: existing.id, requestId: body.requestId, score: body.score, updated: true });
    }

    const id = nanoid();
    await db.insert(feedback)
      .values({
        id,
        requestId: body.requestId,
        tenantId: resolvedTenant,
        score: body.score,
        comment: body.comment || null,
        source: "user",
      })
      .run();

    if (request.taskType && request.complexity) {
      await adaptive.updateScore(
        request.taskType,
        request.complexity,
        request.provider,
        request.model,
        body.score,
        "user",
      );
    }

    return c.json({ id, requestId: body.requestId, score: body.score, updated: false }, 201);
  });

  // List recent feedback
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
    const rows = await db
      .select({
        id: feedback.id,
        requestId: feedback.requestId,
        tenantId: feedback.tenantId,
        score: feedback.score,
        comment: feedback.comment,
        source: feedback.source,
        createdAt: feedback.createdAt,
        model: requests.model,
        provider: requests.provider,
        taskType: requests.taskType,
        complexity: requests.complexity,
      })
      .from(feedback)
      .leftJoin(requests, eq(feedback.requestId, requests.id))
      .where(tenantId ? eq(feedback.tenantId, tenantId) : undefined)
      .orderBy(desc(feedback.createdAt))
      .limit(limit)
      .all();

    return c.json({ feedback: rows });
  });

  // Quality scores per model per routing cell
  app.get("/quality/by-cell", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rows = await db
      .select({
        provider: requests.provider,
        model: requests.model,
        taskType: requests.taskType,
        complexity: requests.complexity,
        avgScore: sql<number>`avg(${feedback.score})`,
        count: sql<number>`count(*)`,
      })
      .from(feedback)
      .innerJoin(requests, eq(feedback.requestId, requests.id))
      .where(tenantId ? eq(feedback.tenantId, tenantId) : undefined)
      .groupBy(requests.provider, requests.model, requests.taskType, requests.complexity)
      .all();

    return c.json({ quality: rows });
  });

  // Quality summary per model
  app.get("/quality/by-model", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rows = await db
      .select({
        provider: requests.provider,
        model: requests.model,
        avgScore: sql<number>`avg(${feedback.score})`,
        count: sql<number>`count(*)`,
        userCount: sql<number>`sum(case when ${feedback.source} = 'user' then 1 else 0 end)`,
        judgeCount: sql<number>`sum(case when ${feedback.source} = 'judge' then 1 else 0 end)`,
      })
      .from(feedback)
      .innerJoin(requests, eq(feedback.requestId, requests.id))
      .where(tenantId ? eq(feedback.tenantId, tenantId) : undefined)
      .groupBy(requests.provider, requests.model)
      .all();

    return c.json({ quality: rows });
  });

  // Quality trend over time
  app.get("/quality/trend", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const range = c.req.query("range") || "7d";
    const rangeMs = range === "24h" ? 86400_000 : range === "30d" ? 30 * 86400_000 : 7 * 86400_000;
    const since = new Date(Date.now() - rangeMs);
    const fmt = range === "24h" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";

    const conditions = [gte(feedback.createdAt, since)];
    if (tenantId) conditions.push(eq(feedback.tenantId, tenantId));

    const rows = await db
      .select({
        bucket: sql<string>`strftime(${fmt}, datetime(${feedback.createdAt}, 'unixepoch'))`,
        avgScore: sql<number>`avg(${feedback.score})`,
        count: sql<number>`count(*)`,
        userCount: sql<number>`sum(case when ${feedback.source} = 'user' then 1 else 0 end)`,
        judgeCount: sql<number>`sum(case when ${feedback.source} = 'judge' then 1 else 0 end)`,
      })
      .from(feedback)
      .where(and(...conditions))
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .all();

    return c.json({ series: rows, range });
  });

  // Judge configuration
  app.get("/judge/config", (c) => {
    return c.json(getJudgeConfig());
  });

  app.put("/judge/config", async (c) => {
    const body = await c.req.json<{
      sampleRate?: number;
      enabled?: boolean;
    }>();
    await setJudgeConfig(db, body);
    return c.json(getJudgeConfig());
  });

  return app;
}
