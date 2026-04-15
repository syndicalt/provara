import { Hono } from "hono";
import type { Db } from "@provara/db";
import { alertRules, alertLogs, requests, costLogs } from "@provara/db";
import { eq, and, sql, gte, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId } from "../auth/tenant.js";

export function createAlertRoutes(db: Db) {
  const app = new Hono();

  // List alert rules
  app.get("/rules", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rules = await db
      .select()
      .from(alertRules)
      .where(tenantId ? eq(alertRules.tenantId, tenantId) : undefined)
      .all();
    return c.json({ rules });
  });

  // Create alert rule
  app.post("/rules", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      name: string;
      metric: string;
      condition: string;
      threshold: number;
      window: string;
      channel?: string;
      webhookUrl?: string;
    }>();

    if (!body.name || !body.metric || !body.threshold) {
      return c.json({ error: { message: "name, metric, and threshold are required", type: "validation_error" } }, 400);
    }

    const id = nanoid();
    await db.insert(alertRules).values({
      id,
      tenantId,
      name: body.name,
      metric: body.metric as "spend" | "latency_p95" | "latency_avg" | "error_rate" | "request_count",
      condition: (body.condition || "gt") as "gt" | "lt" | "gte" | "lte",
      threshold: body.threshold,
      window: (body.window || "1h") as "1h" | "6h" | "24h" | "7d",
      channel: "webhook",
      webhookUrl: body.webhookUrl || null,
    }).run();

    const rule = await db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    return c.json({ rule }, 201);
  });

  // Update alert rule
  app.patch("/rules/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{
      name?: string;
      threshold?: number;
      window?: string;
      webhookUrl?: string | null;
      enabled?: boolean;
    }>();

    const ruleWhere = tenantId ? and(eq(alertRules.id, id), eq(alertRules.tenantId, tenantId)) : eq(alertRules.id, id);
    const rule = await db.select().from(alertRules).where(ruleWhere).get();
    if (!rule) {
      return c.json({ error: { message: "Rule not found", type: "not_found" } }, 404);
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.threshold !== undefined) updates.threshold = body.threshold;
    if (body.window !== undefined) updates.window = body.window;
    if (body.webhookUrl !== undefined) updates.webhookUrl = body.webhookUrl;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (Object.keys(updates).length > 0) {
      await db.update(alertRules).set(updates).where(ruleWhere).run();
    }

    const updated = await db.select().from(alertRules).where(ruleWhere).get();
    return c.json({ rule: updated });
  });

  // Delete alert rule
  app.delete("/rules/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const ruleWhere = tenantId ? and(eq(alertRules.id, id), eq(alertRules.tenantId, tenantId)) : eq(alertRules.id, id);
    const rule = await db.select().from(alertRules).where(ruleWhere).get();
    if (!rule) {
      return c.json({ error: { message: "Rule not found", type: "not_found" } }, 404);
    }
    await db.delete(alertRules).where(ruleWhere).run();
    return c.json({ deleted: true });
  });

  // List alert history
  app.get("/history", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);

    // Join with rules to get tenant scoping
    const rows = await db
      .select({
        id: alertLogs.id,
        ruleId: alertLogs.ruleId,
        ruleName: alertLogs.ruleName,
        metric: alertLogs.metric,
        value: alertLogs.value,
        threshold: alertLogs.threshold,
        acknowledged: alertLogs.acknowledged,
        createdAt: alertLogs.createdAt,
      })
      .from(alertLogs)
      .leftJoin(alertRules, eq(alertLogs.ruleId, alertRules.id))
      .where(tenantId ? eq(alertRules.tenantId, tenantId) : undefined)
      .orderBy(desc(alertLogs.createdAt))
      .limit(limit)
      .all();

    return c.json({ alerts: rows });
  });

  // Evaluate all rules (called on a schedule or manually)
  app.post("/evaluate", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rules = await db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.enabled, true), tenantId ? eq(alertRules.tenantId, tenantId) : undefined))
      .all();

    const fired: string[] = [];

    for (const rule of rules) {
      // Debounce: skip if triggered within the window period
      if (rule.lastTriggeredAt) {
        const windowMs = parseWindow(rule.window || "1h");
        if (Date.now() - rule.lastTriggeredAt.getTime() < windowMs) continue;
      }

      const value = await evaluateMetric(db, rule.metric, rule.window || "1h", rule.tenantId);
      if (value === null) continue;

      const triggered = checkCondition(value, rule.condition || "gt", rule.threshold);
      if (!triggered) continue;

      // Log the alert
      const logId = nanoid();
      await db.insert(alertLogs).values({
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
      }).run();

      // Update last triggered
      await db.update(alertRules)
        .set({ lastTriggeredAt: new Date() })
        .where(eq(alertRules.id, rule.id))
        .run();

      // Fire webhook
      if (rule.webhookUrl) {
        fetch(rule.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            alert: rule.name,
            metric: rule.metric,
            value,
            threshold: rule.threshold,
            condition: rule.condition,
            window: rule.window,
            timestamp: new Date().toISOString(),
          }),
        }).catch(() => {}); // fire and forget
      }

      fired.push(rule.name);
    }

    return c.json({ evaluated: rules.length, fired });
  });

  return app;
}

function parseWindow(window: string): number {
  switch (window) {
    case "1h": return 3600_000;
    case "6h": return 6 * 3600_000;
    case "24h": return 24 * 3600_000;
    case "7d": return 7 * 86400_000;
    default: return 3600_000;
  }
}

function checkCondition(value: number, condition: string, threshold: number): boolean {
  switch (condition) {
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    default: return false;
  }
}

async function evaluateMetric(db: Db, metric: string, window: string, tenantId: string | null): Promise<number | null> {
  const since = new Date(Date.now() - parseWindow(window));
  const tenantCondition = tenantId ? eq(requests.tenantId, tenantId) : undefined;
  const costTenantCondition = tenantId ? eq(costLogs.tenantId, tenantId) : undefined;

  switch (metric) {
    case "spend": {
      const conditions = [gte(costLogs.createdAt, since)];
      if (costTenantCondition) conditions.push(costTenantCondition);
      const row = await db.select({ total: sql<number>`coalesce(sum(${costLogs.cost}), 0)` })
        .from(costLogs).where(and(...conditions)).get();
      return row?.total ?? null;
    }
    case "latency_avg": {
      const conditions = [gte(requests.createdAt, since)];
      if (tenantCondition) conditions.push(tenantCondition);
      const row = await db.select({ avg: sql<number>`avg(${requests.latencyMs})` })
        .from(requests).where(and(...conditions)).get();
      return row?.avg ?? null;
    }
    case "latency_p95": {
      const conditions = [gte(requests.createdAt, since)];
      if (tenantCondition) conditions.push(tenantCondition);
      const row = await db.select({ p95: sql<number>`percentile(95, ${requests.latencyMs})` })
        .from(requests).where(and(...conditions)).get();
      return row?.p95 ?? null;
    }
    case "request_count": {
      const conditions = [gte(requests.createdAt, since)];
      if (tenantCondition) conditions.push(tenantCondition);
      const row = await db.select({ count: sql<number>`count(*)` })
        .from(requests).where(and(...conditions)).get();
      return row?.count ?? null;
    }
    default:
      return null;
  }
}
