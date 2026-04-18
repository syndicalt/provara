import type { Db } from "@provara/db";
import { auditLogs, subscriptions } from "@provara/db";
import { and, eq, lt, sql } from "drizzle-orm";

/**
 * Audit-log retention purge (#210/T5). Daily sweep that deletes rows
 * older than the per-tier retention window.
 *
 * Tier → window:
 *   free         →  90 days (ceiling; Free tenants have no access to
 *                   the /v1/audit-logs endpoint, but the emitter may
 *                   still write rows before tier gating lands every-
 *                   where. 90d is the same minimum Team starts at.)
 *   pro          →  90 days
 *   team         → 365 days
 *   enterprise   → 730 days
 *   selfhost_enterprise → 730 days
 *
 * Implementation: iterate distinct tenant_ids present in audit_logs,
 * resolve each to a tier (fallback "free"), and DELETE with a cutoff.
 * Uses a chunked delete loop so libSQL transactions don't get
 * unbounded. Logs a per-tenant summary at info when anything is
 * deleted.
 */

const RETENTION_DAYS_BY_TIER: Record<string, number> = {
  free: 90,
  pro: 90,
  team: 365,
  enterprise: 730,
  selfhost_enterprise: 730,
};

const FALLBACK_DAYS = 90;
const DEFAULT_BATCH = 10_000;

export interface RetentionStats {
  tenantsScanned: number;
  tenantsDeleted: number;
  rowsDeleted: number;
}

export async function runAuditRetentionCycle(
  db: Db,
  opts: { batchSize?: number } = {},
): Promise<RetentionStats> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  // Pull distinct tenant_ids with any audit row. Small result set
  // compared to the full table — fine to pull into memory.
  const tenantRows = await db
    .selectDistinct({ tenantId: auditLogs.tenantId })
    .from(auditLogs)
    .all();

  let tenantsDeleted = 0;
  let rowsDeleted = 0;

  for (const { tenantId } of tenantRows) {
    const tier = await resolveTier(db, tenantId);
    const windowDays = RETENTION_DAYS_BY_TIER[tier] ?? FALLBACK_DAYS;
    const cutoff = new Date(Date.now() - windowDays * 86_400_000);

    const deletedForTenant = await deleteOlderThan(db, tenantId, cutoff, batchSize);
    if (deletedForTenant > 0) {
      tenantsDeleted += 1;
      rowsDeleted += deletedForTenant;
      console.log(
        `[audit-retention] tenant=${tenantId} tier=${tier} cutoff=${cutoff.toISOString()} deleted=${deletedForTenant}`,
      );
    }
  }

  return { tenantsScanned: tenantRows.length, tenantsDeleted, rowsDeleted };
}

async function resolveTier(db: Db, tenantId: string): Promise<string> {
  const sub = await db
    .select({ tier: subscriptions.tier })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .get();
  return sub?.tier ?? "free";
}

/**
 * Chunked DELETE loop. libSQL has no streaming DELETE + LIMIT syntax
 * that works across clients, so the portable approach is: select a
 * batch of IDs older than cutoff, DELETE WHERE id IN (...), repeat
 * until no rows qualify. Keeps transactions bounded and gives us a
 * predictable per-tick ceiling in the unlikely event retention moves.
 */
async function deleteOlderThan(
  db: Db,
  tenantId: string,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const batch = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantId), lt(auditLogs.createdAt, cutoff)))
      .limit(batchSize)
      .all();
    if (batch.length === 0) break;
    const ids = batch.map((r) => r.id);
    await db
      .delete(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          sql`${auditLogs.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
        ),
      )
      .run();
    total += batch.length;
    if (batch.length < batchSize) break;
  }
  return total;
}
