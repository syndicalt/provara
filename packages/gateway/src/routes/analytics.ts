import { Hono } from "hono";
import type { Db } from "@provara/db";
import { requests, costLogs } from "@provara/db";
import { desc, sql, eq } from "drizzle-orm";

export function createAnalyticsRoutes(db: Db) {
  const app = new Hono();

  // List recent requests with pagination
  app.get("/requests", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
    const offset = parseInt(c.req.query("offset") || "0");
    const provider = c.req.query("provider");
    const model = c.req.query("model");
    const taskType = c.req.query("taskType");

    const rows = db
      .select({
        id: requests.id,
        provider: requests.provider,
        model: requests.model,
        prompt: requests.prompt,
        response: requests.response,
        inputTokens: requests.inputTokens,
        outputTokens: requests.outputTokens,
        latencyMs: requests.latencyMs,
        taskType: requests.taskType,
        complexity: requests.complexity,
        routedBy: requests.routedBy,
        tenantId: requests.tenantId,
        abTestId: requests.abTestId,
        createdAt: requests.createdAt,
        cost: costLogs.cost,
      })
      .from(requests)
      .leftJoin(costLogs, eq(requests.id, costLogs.requestId))
      .orderBy(desc(requests.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .filter((r) => {
        if (provider && r.provider !== provider) return false;
        if (model && r.model !== model) return false;
        if (taskType && r.taskType !== taskType) return false;
        return true;
      });

    const total = db.select({ count: sql<number>`count(*)` }).from(requests).get();

    return c.json({ requests: rows, total: total?.count || 0, limit, offset });
  });

  // Cost summary by provider
  app.get("/costs/by-provider", (c) => {
    const rows = db
      .select({
        provider: costLogs.provider,
        totalCost: sql<number>`sum(${costLogs.cost})`,
        totalInputTokens: sql<number>`sum(${costLogs.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${costLogs.outputTokens})`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costLogs)
      .groupBy(costLogs.provider)
      .all();

    return c.json({ costs: rows });
  });

  // Cost summary by model
  app.get("/costs/by-model", (c) => {
    const rows = db
      .select({
        provider: costLogs.provider,
        model: costLogs.model,
        totalCost: sql<number>`sum(${costLogs.cost})`,
        totalInputTokens: sql<number>`sum(${costLogs.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${costLogs.outputTokens})`,
        requestCount: sql<number>`count(*)`,
        avgCost: sql<number>`avg(${costLogs.cost})`,
      })
      .from(costLogs)
      .groupBy(costLogs.provider, costLogs.model)
      .all();

    return c.json({ costs: rows });
  });

  // Routing stats — traffic by task type × complexity
  app.get("/routing/stats", (c) => {
    const rows = db
      .select({
        taskType: requests.taskType,
        complexity: requests.complexity,
        routedBy: requests.routedBy,
        provider: requests.provider,
        model: requests.model,
        count: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
      })
      .from(requests)
      .groupBy(requests.taskType, requests.complexity, requests.routedBy, requests.provider, requests.model)
      .all();

    return c.json({ stats: rows });
  });

  // Routing distribution — how many requests per task type
  app.get("/routing/distribution", (c) => {
    const byTaskType = db
      .select({
        taskType: requests.taskType,
        count: sql<number>`count(*)`,
      })
      .from(requests)
      .groupBy(requests.taskType)
      .all();

    const byComplexity = db
      .select({
        complexity: requests.complexity,
        count: sql<number>`count(*)`,
      })
      .from(requests)
      .groupBy(requests.complexity)
      .all();

    return c.json({ byTaskType, byComplexity });
  });

  // Overview stats
  app.get("/overview", (c) => {
    const totalRequests = db.select({ count: sql<number>`count(*)` }).from(requests).get();
    const totalCost = db.select({ total: sql<number>`sum(${costLogs.cost})` }).from(costLogs).get();
    const avgLatency = db.select({ avg: sql<number>`avg(${requests.latencyMs})` }).from(requests).get();

    const providerCount = db
      .select({ count: sql<number>`count(distinct ${requests.provider})` })
      .from(requests)
      .get();

    return c.json({
      totalRequests: totalRequests?.count || 0,
      totalCost: totalCost?.total || 0,
      avgLatency: avgLatency?.avg || 0,
      providerCount: providerCount?.count || 0,
    });
  });

  return app;
}
