import { Hono } from "hono";
import type { Db } from "@provara/db";
import { requests, costLogs, abTests, feedback } from "@provara/db";
import { desc, asc, sql, eq, and, gte } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { getTenantId } from "../auth/tenant.js";

// Whitelist of columns exposed to client-driven sort on /requests. Never map
// raw user input into a SQL expression — anything not in this table silently
// falls back to the default (createdAt desc).
const REQUESTS_SORT_COLUMNS: Record<string, SQLWrapper> = {
  createdAt: requests.createdAt,
  latencyMs: requests.latencyMs,
  inputTokens: requests.inputTokens,
  outputTokens: requests.outputTokens,
  provider: requests.provider,
  model: requests.model,
  taskType: requests.taskType,
  complexity: requests.complexity,
  routedBy: requests.routedBy,
  cost: costLogs.cost,
};

export function createAnalyticsRoutes(db: Db) {
  const app = new Hono();

  // List recent requests with pagination
  app.get("/requests", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
    const offset = parseInt(c.req.query("offset") || "0");
    const provider = c.req.query("provider");
    const model = c.req.query("model");
    const taskType = c.req.query("taskType");
    const orderByParam = c.req.query("orderBy");
    const orderParam = c.req.query("order") === "asc" ? "asc" : "desc";

    const sortCol = orderByParam ? REQUESTS_SORT_COLUMNS[orderByParam] : undefined;
    const orderExpr = sortCol
      ? (orderParam === "asc" ? asc(sortCol) : desc(sortCol))
      : desc(requests.createdAt);

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
        usedFallback: requests.usedFallback,
        cached: requests.cached,
        tenantId: requests.tenantId,
        abTestId: requests.abTestId,
        createdAt: requests.createdAt,
        cost: costLogs.cost,
      })
      .from(requests)
      .leftJoin(costLogs, eq(requests.id, costLogs.requestId))
      .where(tenantId ? eq(requests.tenantId, tenantId) : undefined)
      .orderBy(orderExpr)
      .limit(limit)
      .offset(offset)
      .all())
      .filter((r) => {
        if (provider && r.provider !== provider) return false;
        if (model && r.model !== model) return false;
        if (taskType && r.taskType !== taskType) return false;
        return true;
      });

    const total = await db.select({ count: sql<number>`count(*)` }).from(requests).where(tenantId ? eq(requests.tenantId, tenantId) : undefined).get();

    return c.json({ requests: rows, total: total?.count || 0, limit, offset });
  });

  // Get single request by ID
  app.get("/requests/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();

    const row = await db
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
        usedFallback: requests.usedFallback,
        cached: requests.cached,
        fallbackErrors: requests.fallbackErrors,
        tenantId: requests.tenantId,
        abTestId: requests.abTestId,
        createdAt: requests.createdAt,
        cost: costLogs.cost,
      })
      .from(requests)
      .leftJoin(costLogs, eq(requests.id, costLogs.requestId))
      .where(tenantId ? and(eq(requests.id, id), eq(requests.tenantId, tenantId)) : eq(requests.id, id))
      .get();

    if (!row) {
      return c.json({ error: { message: "Request not found", type: "not_found" } }, 404);
    }

    // Get feedback for this request
    const feedbackRows = await db
      .select()
      .from(feedback)
      .where(eq(feedback.requestId, id))
      .all();

    return c.json({ request: row, feedback: feedbackRows });
  });

  // Cost summary by provider
  app.get("/costs/by-provider", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rows = await db
      .select({
        provider: costLogs.provider,
        totalCost: sql<number>`sum(${costLogs.cost})`,
        totalInputTokens: sql<number>`sum(${costLogs.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${costLogs.outputTokens})`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costLogs)
      .where(tenantId ? eq(costLogs.tenantId, tenantId) : undefined)
      .groupBy(costLogs.provider)
      .all();

    return c.json({ costs: rows });
  });

  // Cost summary by model
  app.get("/costs/by-model", async (c) => {
    const tenantId = getTenantId(c.req.raw);
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
      .where(tenantId ? eq(costLogs.tenantId, tenantId) : undefined)
      .groupBy(costLogs.provider, costLogs.model)
      .all();

    return c.json({ costs: rows });
  });

  // Routing stats — traffic by task type × complexity
  app.get("/routing/stats", async (c) => {
    const tenantId = getTenantId(c.req.raw);
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
      .where(tenantId ? eq(requests.tenantId, tenantId) : undefined)
      .groupBy(requests.taskType, requests.complexity, requests.routedBy, requests.provider, requests.model)
      .all();

    return c.json({ stats: rows });
  });

  // Routing distribution — how many requests per task type
  app.get("/routing/distribution", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const byTaskType = await db
      .select({
        taskType: requests.taskType,
        count: sql<number>`count(*)`,
      })
      .from(requests)
      .where(tenantId ? eq(requests.tenantId, tenantId) : undefined)
      .groupBy(requests.taskType)
      .all();

    const byComplexity = await db
      .select({
        complexity: requests.complexity,
        count: sql<number>`count(*)`,
      })
      .from(requests)
      .where(tenantId ? eq(requests.tenantId, tenantId) : undefined)
      .groupBy(requests.complexity)
      .all();

    return c.json({ byTaskType, byComplexity });
  });

  // Overview stats
  app.get("/overview", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const totalRequests = await db.select({ count: sql<number>`count(*)` }).from(requests).where(tenantId ? eq(requests.tenantId, tenantId) : undefined).get();
    const totalCost = await db.select({ total: sql<number>`sum(${costLogs.cost})` }).from(costLogs).where(tenantId ? eq(costLogs.tenantId, tenantId) : undefined).get();
    const avgLatency = await db.select({ avg: sql<number>`avg(${requests.latencyMs})` }).from(requests).where(tenantId ? eq(requests.tenantId, tenantId) : undefined).get();

    const providerCount = await db
      .select({ count: sql<number>`count(distinct ${requests.provider})` })
      .from(requests)
      .where(tenantId ? eq(requests.tenantId, tenantId) : undefined)
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
    const tenantId = getTenantId(c.req.raw);
    const tenantFilter = tenantId ? eq(requests.tenantId, tenantId) : undefined;

    // Requests by routing method
    const byRoutedBy = await db
      .select({
        routedBy: requests.routedBy,
        count: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
      })
      .from(requests)
      .where(tenantFilter)
      .groupBy(requests.routedBy)
      .all();

    // Real fallback events — provider A errored, we retried on B
    const fallbackStats = await db
      .select({
        count: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
      })
      .from(requests)
      .where(
        tenantFilter
          ? and(tenantFilter, eq(requests.usedFallback, true))
          : eq(requests.usedFallback, true)
      )
      .get();

    // Active A/B tests
    const activeAbTests = await db
      .select({ count: sql<number>`count(*)` })
      .from(abTests)
      .where(tenantId ? and(eq(abTests.status, "active"), eq(abTests.tenantId, tenantId)) : eq(abTests.status, "active"))
      .get();

    // Total feedback count
    const feedbackCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(feedback)
      .where(tenantId ? eq(feedback.tenantId, tenantId) : undefined)
      .get();

    // Provider count
    const providerCount = await db
      .select({ count: sql<number>`count(distinct ${requests.provider})` })
      .from(requests)
      .where(tenantFilter)
      .get();

    // Total requests
    const totalRequests = await db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(tenantFilter)
      .get();

    const routedByMap: Record<string, { count: number; avgLatency: number }> = {};
    for (const row of byRoutedBy) {
      if (row.routedBy) {
        routedByMap[row.routedBy] = { count: row.count, avgLatency: Math.round(row.avgLatency || 0) };
      }
    }

    const classifierCount =
      (routedByMap["classification"]?.count || 0) + (routedByMap["routing-hint"]?.count || 0);
    const classifierLatencyWeighted =
      (routedByMap["classification"]?.count || 0) * (routedByMap["classification"]?.avgLatency || 0) +
      (routedByMap["routing-hint"]?.count || 0) * (routedByMap["routing-hint"]?.avgLatency || 0);
    const classifierAvgLatency = classifierCount > 0 ? Math.round(classifierLatencyWeighted / classifierCount) : 0;

    return c.json({
      totalRequests: totalRequests?.count || 0,
      stages: {
        classifier: {
          count: classifierCount,
          avgLatency: classifierAvgLatency,
          active: true,
        },
        userOverride: {
          count: routedByMap["user-override"]?.count || 0,
          avgLatency: routedByMap["user-override"]?.avgLatency || 0,
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
        exploration: {
          count: routedByMap["exploration"]?.count || 0,
          avgLatency: routedByMap["exploration"]?.avgLatency || 0,
          active: parseFloat(process.env.PROVARA_EXPLORATION_RATE || "0.1") > 0,
          rate: parseFloat(process.env.PROVARA_EXPLORATION_RATE || "0.1"),
        },
        fallback: {
          count: fallbackStats?.count || 0,
          avgLatency: Math.round(fallbackStats?.avgLatency || 0),
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

  // ---- Time-series endpoints ----

  function parseRange(range: string | undefined): Date {
    const now = new Date();
    switch (range) {
      case "1h": return new Date(now.getTime() - 3600_000);
      case "6h": return new Date(now.getTime() - 6 * 3600_000);
      case "24h": return new Date(now.getTime() - 24 * 3600_000);
      case "7d": return new Date(now.getTime() - 7 * 86400_000);
      case "30d": return new Date(now.getTime() - 30 * 86400_000);
      default: return new Date(now.getTime() - 7 * 86400_000);
    }
  }

  function bucketFormat(range: string | undefined): string {
    // Hourly for ≤24h, daily for longer
    switch (range) {
      case "1h": case "6h": case "24h": return "%Y-%m-%d %H:00";
      default: return "%Y-%m-%d";
    }
  }

  // Time-series: request volume, cost, avg latency
  app.get("/timeseries", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const range = c.req.query("range") || "7d";
    const provider = c.req.query("provider");
    const model = c.req.query("model");
    const since = parseRange(range);
    const fmt = bucketFormat(range);

    const conditions = [gte(requests.createdAt, since)];
    if (tenantId) conditions.push(eq(requests.tenantId, tenantId));

    const rows = await db
      .select({
        bucket: sql<string>`strftime(${fmt}, datetime(${requests.createdAt}, 'unixepoch'))`,
        requestCount: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
        minLatency: sql<number>`min(${requests.latencyMs})`,
        maxLatency: sql<number>`max(${requests.latencyMs})`,
      })
      .from(requests)
      .where(and(...conditions))
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .all();

    // Cost time-series (separate table)
    const costConditions = [gte(costLogs.createdAt, since)];
    if (tenantId) costConditions.push(eq(costLogs.tenantId, tenantId));

    const costRows = await db
      .select({
        bucket: sql<string>`strftime(${fmt}, datetime(${costLogs.createdAt}, 'unixepoch'))`,
        totalCost: sql<number>`sum(${costLogs.cost})`,
      })
      .from(costLogs)
      .where(and(...costConditions))
      .groupBy(sql`1`)
      .orderBy(sql`1`)
      .all();

    const costMap = new Map(costRows.map((r) => [r.bucket, r.totalCost]));

    // Approximate percentiles: p50 ≈ avg, p95 ≈ avg + 0.8*(max-avg), p99 ≈ max
    const series = rows.map((r) => {
      const avg = r.avgLatency || 0;
      const max = r.maxLatency || avg;
      return {
        bucket: r.bucket,
        requestCount: r.requestCount,
        avgLatency: Math.round(avg),
        p50Latency: Math.round(avg),
        p95Latency: Math.round(avg + 0.8 * (max - avg)),
        p99Latency: Math.round(max),
        totalCost: costMap.get(r.bucket) || 0,
      };
    });

    return c.json({ series, range });
  });

  // Cost breakdown by provider over time
  app.get("/timeseries/cost-by-provider", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const range = c.req.query("range") || "7d";
    const since = parseRange(range);
    const fmt = bucketFormat(range);

    const conditions = [gte(costLogs.createdAt, since)];
    if (tenantId) conditions.push(eq(costLogs.tenantId, tenantId));

    const rows = await db
      .select({
        bucket: sql<string>`strftime(${fmt}, datetime(${costLogs.createdAt}, 'unixepoch'))`,
        provider: costLogs.provider,
        totalCost: sql<number>`sum(${costLogs.cost})`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costLogs)
      .where(and(...conditions))
      .groupBy(sql`1`, costLogs.provider)
      .orderBy(sql`1`)
      .all();

    return c.json({ series: rows, range });
  });

  // Model comparison for a time range
  app.get("/models/compare", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const range = c.req.query("range") || "7d";
    const since = parseRange(range);

    const conditions = [gte(requests.createdAt, since)];
    if (tenantId) conditions.push(eq(requests.tenantId, tenantId));

    const rows = await db
      .select({
        provider: requests.provider,
        model: requests.model,
        requestCount: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
        avgInputTokens: sql<number>`avg(${requests.inputTokens})`,
        avgOutputTokens: sql<number>`avg(${requests.outputTokens})`,
      })
      .from(requests)
      .where(and(...conditions))
      .groupBy(requests.provider, requests.model)
      .all();

    // Join with cost data
    const costConditions = [gte(costLogs.createdAt, since)];
    if (tenantId) costConditions.push(eq(costLogs.tenantId, tenantId));

    const costRows = await db
      .select({
        model: costLogs.model,
        totalCost: sql<number>`sum(${costLogs.cost})`,
      })
      .from(costLogs)
      .where(and(...costConditions))
      .groupBy(costLogs.model)
      .all();

    // Join with quality data
    const qualityRows = await db
      .select({
        provider: requests.provider,
        model: requests.model,
        avgScore: sql<number>`avg(${feedback.score})`,
        feedbackCount: sql<number>`count(${feedback.id})`,
      })
      .from(feedback)
      .innerJoin(requests, eq(feedback.requestId, requests.id))
      .where(and(...[gte(feedback.createdAt, since), ...(tenantId ? [eq(feedback.tenantId, tenantId)] : [])]))
      .groupBy(requests.provider, requests.model)
      .all();

    const costMap = new Map(costRows.map((r) => [r.model, r.totalCost]));
    const qualityMap = new Map(qualityRows.map((r) => [`${r.provider}/${r.model}`, r]));

    const models = rows.map((r) => {
      const key = `${r.provider}/${r.model}`;
      const quality = qualityMap.get(key);
      return {
        provider: r.provider,
        model: r.model,
        requestCount: r.requestCount,
        avgLatency: Math.round(r.avgLatency || 0),
        totalCost: costMap.get(r.model) || 0,
        avgScore: quality?.avgScore || null,
        feedbackCount: quality?.feedbackCount || 0,
      };
    });

    return c.json({ models, range });
  });

  return app;
}
