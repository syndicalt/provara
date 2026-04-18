import { Hono } from "hono";
import type { Db } from "@provara/db";
import { abTests, abTestVariants, requests, feedback, costLogs } from "@provara/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId, tenantFilter } from "../auth/tenant.js";

export function createAbTestRoutes(db: Db) {
  const app = new Hono();

  // List all A/B tests
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const tests = await db.select().from(abTests).where(tenantFilter(abTests.tenantId, tenantId)).all();
    return c.json({ tests });
  });

  // Get a single A/B test with variants and results
  app.get("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();

    const test = await db.select().from(abTests).where((() => { const tc = tenantFilter(abTests.tenantId, tenantId); return tc ? and(eq(abTests.id, id), tc) : eq(abTests.id, id); })()).get();
    if (!test) {
      return c.json({ error: { message: "A/B test not found", type: "not_found" } }, 404);
    }

    const variants = await db
      .select()
      .from(abTestVariants)
      .where(eq(abTestVariants.abTestId, id))
      .all();

    // Get aggregate results per variant model
    const results = await db
      .select({
        model: requests.model,
        provider: requests.provider,
        count: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
        avgInputTokens: sql<number>`avg(${requests.inputTokens})`,
        avgOutputTokens: sql<number>`avg(${requests.outputTokens})`,
        totalCost: sql<number>`sum(${requests.cost})`,
      })
      .from(requests)
      .where(eq(requests.abTestId, id))
      .groupBy(requests.model, requests.provider)
      .all();

    // Get quality scores per variant from feedback
    const qualityResults = await db
      .select({
        provider: requests.provider,
        model: requests.model,
        avgScore: sql<number>`avg(${feedback.score})`,
        feedbackCount: sql<number>`count(${feedback.id})`,
      })
      .from(feedback)
      .innerJoin(requests, eq(feedback.requestId, requests.id))
      .where(eq(requests.abTestId, id))
      .groupBy(requests.provider, requests.model)
      .all();

    // Merge quality into results
    const qualityMap = new Map(qualityResults.map((q) => [`${q.provider}/${q.model}`, q]));
    const enrichedResults = results.map((r) => {
      const q = qualityMap.get(`${r.provider}/${r.model}`);
      return {
        ...r,
        avgScore: q?.avgScore || null,
        feedbackCount: q?.feedbackCount || 0,
      };
    });

    return c.json({ test, variants, results: enrichedResults });
  });

  // List individual requests for an A/B test (with prompt, response, feedback)
  app.get("/:id/requests", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
    const offset = parseInt(c.req.query("offset") || "0");

    const abTestWhere = tenantId
      ? and(eq(requests.abTestId, id), eq(requests.tenantId, tenantId))
      : eq(requests.abTestId, id);

    const rows = await db
      .select({
        id: requests.id,
        provider: requests.provider,
        model: requests.model,
        prompt: requests.prompt,
        response: requests.response,
        inputTokens: requests.inputTokens,
        outputTokens: requests.outputTokens,
        latencyMs: requests.latencyMs,
        cost: costLogs.cost,
        createdAt: requests.createdAt,
        feedbackScore: feedback.score,
        feedbackComment: feedback.comment,
        feedbackSource: feedback.source,
      })
      .from(requests)
      .leftJoin(costLogs, eq(requests.id, costLogs.requestId))
      .leftJoin(feedback, eq(requests.id, feedback.requestId))
      .where(abTestWhere)
      .orderBy(desc(requests.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(abTestWhere)
      .get();

    return c.json({ requests: rows, total: total?.count || 0, limit, offset });
  });

  // Create a new A/B test
  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      name: string;
      description?: string;
      taskType?: string;
      complexity?: string;
      variants: { provider: string; model: string; weight?: number }[];
    }>();

    if (!body.name || !body.variants || body.variants.length < 2) {
      return c.json(
        { error: { message: "Name and at least 2 variants required", type: "validation_error" } },
        400
      );
    }

    const testId = nanoid();
    await db.insert(abTests)
      .values({
        id: testId,
        name: body.name,
        description: body.description || null,
        tenantId,
      })
      .run();

    for (const variant of body.variants) {
      await db.insert(abTestVariants)
        .values({
          id: nanoid(),
          abTestId: testId,
          provider: variant.provider,
          model: variant.model,
          weight: variant.weight ?? 1,
          taskType: body.taskType || null,
          complexity: body.complexity || null,
        })
        .run();
    }

    const test = await db.select().from(abTests).where(eq(abTests.id, testId)).get();
    const variants = await db
      .select()
      .from(abTestVariants)
      .where(eq(abTestVariants.abTestId, testId))
      .all();

    return c.json({ test, variants }, 201);
  });

  // Update A/B test status
  app.patch("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{
      status?: "active" | "paused" | "completed";
      name?: string;
      description?: string;
    }>();

    const test = await db.select().from(abTests).where((() => { const tc = tenantFilter(abTests.tenantId, tenantId); return tc ? and(eq(abTests.id, id), tc) : eq(abTests.id, id); })()).get();
    if (!test) {
      return c.json({ error: { message: "A/B test not found", type: "not_found" } }, 404);
    }

    const updates: Record<string, unknown> = {};
    if (body.status) updates.status = body.status;
    if (body.name) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    if (Object.keys(updates).length > 0) {
      await db.update(abTests).set(updates).where((() => { const tc = tenantFilter(abTests.tenantId, tenantId); return tc ? and(eq(abTests.id, id), tc) : eq(abTests.id, id); })()).run();
    }

    const updated = await db.select().from(abTests).where((() => { const tc = tenantFilter(abTests.tenantId, tenantId); return tc ? and(eq(abTests.id, id), tc) : eq(abTests.id, id); })()).get();
    return c.json({ test: updated });
  });

  // Delete an A/B test
  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();

    const test = await db.select().from(abTests).where((() => { const tc = tenantFilter(abTests.tenantId, tenantId); return tc ? and(eq(abTests.id, id), tc) : eq(abTests.id, id); })()).get();
    if (!test) {
      return c.json({ error: { message: "A/B test not found", type: "not_found" } }, 404);
    }

    await db.delete(abTestVariants).where(eq(abTestVariants.abTestId, id)).run();
    await db.delete(abTests).where((() => { const tc = tenantFilter(abTests.tenantId, tenantId); return tc ? and(eq(abTests.id, id), tc) : eq(abTests.id, id); })()).run();

    return c.json({ deleted: true });
  });

  return app;
}
