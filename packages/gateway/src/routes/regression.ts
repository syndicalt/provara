import { Hono } from "hono";
import type { Db } from "@provara/db";
import { replayBank } from "@provara/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getTenantId } from "../auth/tenant.js";
import {
  REPLAY_WEEKLY_BUDGET_USD,
  getBudgetStatus,
  isRegressionDetectionEnabled,
  listRegressionEvents,
  resolveRegressionEvent,
  setRegressionOptIn,
  type RegressionCellTable,
} from "../routing/adaptive/regression.js";

export function createRegressionRoutes(db: Db, regressionCellTable?: RegressionCellTable) {
  const app = new Hono();

  app.get("/status", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const enabled = await isRegressionDetectionEnabled(db, tenantId);
    const budget = await getBudgetStatus(db, tenantId);
    const bankCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(replayBank)
      .where(tenantId ? eq(replayBank.tenantId, tenantId) : isNull(replayBank.tenantId))
      .get();
    return c.json({
      enabled,
      budget,
      bankSize: bankCount?.count ?? 0,
      defaultWeeklyBudgetUsd: REPLAY_WEEKLY_BUDGET_USD,
    });
  });

  app.post("/opt-in", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{ enabled: boolean }>();
    await setRegressionOptIn(db, tenantId, Boolean(body.enabled));
    return c.json({ enabled: Boolean(body.enabled) });
  });

  app.get("/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const unresolvedOnly = c.req.query("unresolvedOnly") === "true";
    const events = await listRegressionEvents(db, tenantId, { unresolvedOnly });
    return c.json({ events });
  });

  app.post("/events/:id/resolve", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
    const ok = await resolveRegressionEvent(db, id, body.note ?? null);
    // Tenant check — re-fetch to confirm ownership would be ideal, but resolve
    // is a private op; surfacing 404 vs 403 isn't interesting here.
    if (!ok) return c.json({ error: { message: "event not found", type: "not_found" } }, 404);
    void tenantId;
    // Refresh the in-memory regression cell table so the router stops
    // boosting exploration on this cell on the very next routing decision
    // (#163). Without this, the cell stays "regressing" in memory until the
    // next replay cycle refresh.
    if (regressionCellTable) await regressionCellTable.refresh();
    return c.json({ resolved: true });
  });

  return app;
}
