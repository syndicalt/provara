import { Hono } from "hono";
import type { Db } from "@provara/db";
import { requests, costLogs, abTests, feedback } from "@provara/db";
import { desc, sql, eq } from "drizzle-orm";

export function createAnalyticsRoutes(db: Db) {
  const app = new Hono();

  // List recent requests with pagination
  app.get("/requests", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
    const offset = parseInt(c.req.query("offset") || "0");
    const provider = c.req.query("provider");
    const model = c.req.query("model");
    const taskType = c.req.query("taskType");

    const rows = (await db
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
      .all())
      .filter((r) => {
        if (provider && r.provider !== provider) return false;
        if (model && r.model !== model) return false;
        if (taskType && r.taskType !== taskType) return false;
        return true;
      });

    const total = await db.select({ count: sql<number>`count(*)` }).from(requests).get();

    return c.json({ requests: rows, total: total?.count || 0, limit, offset });
  });

  // Cost summary by provider
  app.get("/costs/by-provider", async (c) => {
    const rows = await db
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
  app.get("/costs/by-model", async (c) => {
    const rows = await db
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
  app.get("/routing/stats", async (c) => {
    const rows = await db
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
  app.get("/routing/distribution", async (c) => {
    const byTaskType = await db
      .select({
        taskType: requests.taskType,
        count: sql<number>`count(*)`,
      })
      .from(requests)
      .groupBy(requests.taskType)
      .all();

    const byComplexity = await db
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
  app.get("/overview", async (c) => {
    const totalRequests = await db.select({ count: sql<number>`count(*)` }).from(requests).get();
    const totalCost = await db.select({ total: sql<number>`sum(${costLogs.cost})` }).from(costLogs).get();
    const avgLatency = await db.select({ avg: sql<number>`avg(${requests.latencyMs})` }).from(requests).get();

    const providerCount = await db
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

  // Pipeline stage stats — per-stage request counts and latency
  app.get("/pipeline", async (c) => {
    // Requests by routing method
    const byRoutedBy = await db
      .select({
        routedBy: requests.routedBy,
        count: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
      })
      .from(requests)
      .groupBy(requests.routedBy)
      .all();

    // Active A/B tests
    const activeAbTests = await db
      .select({ count: sql<number>`count(*)` })
      .from(abTests)
      .where(eq(abTests.status, "active"))
      .get();

    // Total feedback count
    const feedbackCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(feedback)
      .get();

    // Provider count
    const providerCount = await db
      .select({ count: sql<number>`count(distinct ${requests.provider})` })
      .from(requests)
      .get();

    // Total requests
    const totalRequests = await db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .get();

    const routedByMap: Record<string, { count: number; avgLatency: number }> = {};
    for (const row of byRoutedBy) {
      if (row.routedBy) {
        routedByMap[row.routedBy] = { count: row.count, avgLatency: Math.round(row.avgLatency || 0) };
      }
    }

    return c.json({
      totalRequests: totalRequests?.count || 0,
      stages: {
        classifier: {
          count: (routedByMap["classification"]?.count || 0) + (routedByMap["routing-hint"]?.count || 0),
          avgLatency: routedByMap["classification"]?.avgLatency || 0,
          active: true,
        },
        abTest: {
          count: routedByMap["ab-test"]?.count || 0,
          avgLatency: routedByMap["ab-test"]?.avgLatency || 0,
          active: (activeAbTests?.count || 0) > 0,
          activeTests: activeAbTests?.count || 0,
        },
        adaptive: {
          count: routedByMap["adaptive"]?.count || 0,
          avgLatency: routedByMap["adaptive"]?.avgLatency || 0,
          active: (feedbackCount?.count || 0) > 0,
          feedbackCount: feedbackCount?.count || 0,
        },
        fallback: {
          count: (routedByMap["classification"]?.count || 0),
          avgLatency: routedByMap["classification"]?.avgLatency || 0,
          active: true,
        },
        providers: {
          count: totalRequests?.count || 0,
          active: true,
          providerCount: providerCount?.count || 0,
        },
      },
    });
  });

  return app;
}
