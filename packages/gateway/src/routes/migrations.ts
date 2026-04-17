import { Hono } from "hono";
import type { Db } from "@provara/db";
import { getTenantId } from "../auth/tenant.js";
import {
  isCostMigrationEnabled,
  listMigrations,
  rollbackMigration,
  runCostMigrationCycle,
  setCostMigrationOptIn,
  totalSavingsThisMonth,
} from "../routing/adaptive/migrations.js";
import type { BoostTable } from "../routing/adaptive/migrations.js";

export function createMigrationRoutes(db: Db, boostTable: BoostTable) {
  const app = new Hono();

  app.get("/status", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const enabled = await isCostMigrationEnabled(db, tenantId);
    const savingsThisMonth = await totalSavingsThisMonth(db, tenantId);
    return c.json({ enabled, savingsThisMonth });
  });

  app.post("/opt-in", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{ enabled: boolean }>();
    await setCostMigrationOptIn(db, tenantId, Boolean(body.enabled));
    return c.json({ enabled: Boolean(body.enabled) });
  });

  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const migrations = await listMigrations(db, tenantId);
    return c.json({ migrations });
  });

  app.post("/run", async (c) => {
    const stats = await runCostMigrationCycle(db);
    if (stats.executed.length > 0) {
      await boostTable.refresh();
    }
    return c.json(stats);
  });

  app.post("/:id/rollback", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    const ok = await rollbackMigration(db, id, body.reason ?? "manual rollback");
    if (!ok) return c.json({ error: { message: "migration not found or already rolled back", type: "not_found" } }, 404);
    await boostTable.refresh();
    return c.json({ rolledBack: true });
  });

  return app;
}
