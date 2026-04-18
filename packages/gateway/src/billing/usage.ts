import type { Db } from "@provara/db";
import { requests, subscriptions, usageReports, users } from "@provara/db";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type Stripe from "stripe";
import { getOperatorEmails } from "../config.js";

/**
 * Per-tier request quotas. Requests beyond the quota are billed as
 * overage on Pro and Team via Stripe's metered billing; Free hard-cuts
 * at the quota with a 429. Enterprise and operator tenants have no
 * quota enforcement.
 *
 * Keep in sync with `packages/gateway/src/routes/billing.ts::TIER_QUOTAS`
 * and the marketing copy in `apps/web/src/lib/pricing.ts`. If they
 * drift, customers will see different numbers on billing and pricing.
 */
export const TIER_QUOTAS: Record<string, number> = {
  free: 10_000,
  pro: 100_000,
  team: 500_000,
  enterprise: Number.MAX_SAFE_INTEGER,
  selfhost_enterprise: Number.MAX_SAFE_INTEGER,
  operator: Number.MAX_SAFE_INTEGER,
};

/** Stripe meter event name — must match what was configured in the portal (#166). */
export const METER_EVENT_NAME = "provara_api_requests";

/**
 * Dollars billed per 1,000 overage requests. Informational only — the
 * real price lives on the `Request Overage` Stripe product. We multiply
 * here purely to populate `usage_reports.total_pushed_usd` for audit.
 */
const OVERAGE_RATE_PER_1K = 0.5;

export interface UsageCycleStats {
  subscriptionsEvaluated: number;
  reportsWritten: number;
  deltaRequestsReported: number;
  errors: number;
}

/**
 * Count the tenant's requests since the given period start. Used by
 * both the reporting cycle (for billing) and the free-tier quota gate
 * (for enforcement). Same source of truth — `requests` table — so
 * they can't drift.
 */
export async function countRequestsInPeriod(
  db: Db,
  tenantId: string,
  periodStart: Date,
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(requests)
    .where(
      and(
        eq(requests.tenantId, tenantId),
        gte(requests.createdAt, periodStart),
      ),
    )
    .get();
  return row?.count ?? 0;
}

/**
 * Count requests for a tenant strictly within a bounded window. Used
 * by the rollover-flush path where we need the OLD period's final
 * count (not "everything since period start").
 */
export async function countRequestsInPeriodRange(
  db: Db,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(requests)
    .where(
      and(
        eq(requests.tenantId, tenantId),
        gte(requests.createdAt, periodStart),
        sql`${requests.createdAt} < ${Math.floor(periodEnd.getTime() / 1000)}`,
      ),
    )
    .get();
  return row?.count ?? 0;
}

/** How many of `usage` requests are over the quota for `tier`. Floors at zero. */
export function calculateOverage(usage: number, tier: string): number {
  const quota = TIER_QUOTAS[tier] ?? TIER_QUOTAS.free;
  return Math.max(0, usage - quota);
}

async function getOrCreateReportRow(
  db: Db,
  sub: typeof subscriptions.$inferSelect,
): Promise<typeof usageReports.$inferSelect> {
  const existing = await db
    .select()
    .from(usageReports)
    .where(
      and(
        eq(usageReports.stripeSubscriptionId, sub.stripeSubscriptionId),
        eq(usageReports.periodStart, sub.currentPeriodStart),
      ),
    )
    .get();
  if (existing) return existing;

  const id = nanoid();
  await db
    .insert(usageReports)
    .values({
      id,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      tenantId: sub.tenantId,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      reportedOverageCount: 0,
      totalPushedUsd: 0,
    })
    .run();
  const fresh = await db.select().from(usageReports).where(eq(usageReports.id, id)).get();
  if (!fresh) throw new Error(`failed to create usage_report row for ${sub.stripeSubscriptionId}`);
  return fresh;
}

/**
 * Push a meter event to Stripe representing new overage since the last
 * report. Uses a deterministic identifier so Stripe dedupes retries
 * internally even if we crash between "push to Stripe" and "write our
 * high-water mark row."
 */
async function pushMeterEvent(
  stripe: Stripe,
  stripeCustomerId: string,
  deltaCount: number,
  identifier: string,
  timestamp?: Date,
): Promise<void> {
  const payload: Record<string, string> = {
    stripe_customer_id: stripeCustomerId,
    value: String(deltaCount),
  };
  await stripe.billing.meterEvents.create({
    event_name: METER_EVENT_NAME,
    identifier,
    // Stripe docs require payload fields to be strings, not numbers.
    payload,
    // Timestamp pins the event to a specific billing period. Omit for
    // in-period pushes (Stripe stamps "now"). Set explicitly for rollover
    // flushes so late-arriving events still land in the correct closed
    // period rather than the next one.
    ...(timestamp ? { timestamp: Math.floor(timestamp.getTime() / 1000) } : {}),
  });
}

/**
 * Optimistic UPDATE — only succeeds if the high-water mark hasn't
 * moved since we read it. Prevents stale writes in the (currently
 * prevented via PROVARA_SCHEDULER_ROLE=leader, but still worth
 * defending against) multi-replica case where two schedulers could
 * read the same value and race each other's updates.
 *
 * Returns true when the update succeeded, false when another writer
 * beat us to it (caller should back off and retry).
 */
async function updateReportOptimistically(
  db: Db,
  reportId: string,
  expectedPrevCount: number,
  next: {
    reportedOverageCount: number;
    totalPushedUsd: number;
    reportedAt: Date;
    lastEventIdentifier: string;
    finalizedAt?: Date | null;
  },
): Promise<boolean> {
  const result = await db
    .update(usageReports)
    .set(next)
    .where(
      and(
        eq(usageReports.id, reportId),
        eq(usageReports.reportedOverageCount, expectedPrevCount),
      ),
    )
    .run();
  // libSQL returns rowsAffected in `.changes`
  const affected = (result as unknown as { rowsAffected?: number; changes?: number }).rowsAffected
    ?? (result as unknown as { changes?: number }).changes
    ?? 0;
  return affected > 0;
}

/**
 * Nightly reporting cycle. For each active subscription with
 * Intelligence, counts current-period requests, computes the billable
 * overage delta since last report, pushes a Stripe meter event for
 * the delta, and updates the high-water mark row.
 *
 * Idempotent — safe to run multiple times per day. The high-water
 * mark guards us against double-reporting; Stripe's identifier dedupes
 * its own side.
 *
 * Scoped to Pro + Team only. Free has no overage pricing (hard cutoff
 * enforced elsewhere). Enterprise is custom-invoiced. Operators bypass
 * all of this since they don't have subscription rows.
 */
export async function runUsageReportCycle(
  db: Db,
  stripe: Stripe,
): Promise<UsageCycleStats> {
  const activeSubs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.includesIntelligence, true),
        // Report while in a billable state; canceled/unpaid subs don't bill
        sql`${subscriptions.status} IN ('active', 'trialing', 'past_due')`,
      ),
    )
    .all();

  const stats: UsageCycleStats = {
    subscriptionsEvaluated: 0,
    reportsWritten: 0,
    deltaRequestsReported: 0,
    errors: 0,
  };

  for (const sub of activeSubs) {
    stats.subscriptionsEvaluated++;
    try {
      if (!["pro", "team"].includes(sub.tier)) {
        // Only Pro and Team use metered overage; Enterprise is custom
        // invoiced outside this pipeline.
        continue;
      }

      // --- Rollover self-heal pass ---
      // If the most-recent unfinalized report row on this subscription
      // covers an OLD period (period_start != sub.currentPeriodStart),
      // the subscription rolled over since our last cycle. Flush any
      // remaining delta for that old period with a timestamp pinned
      // inside the period so Stripe puts it on the correct invoice
      // even if the push arrives late. Then mark the row finalized.
      const stalePrev = await db
        .select()
        .from(usageReports)
        .where(
          and(
            eq(usageReports.stripeSubscriptionId, sub.stripeSubscriptionId),
            ne(usageReports.periodStart, sub.currentPeriodStart),
            isNull(usageReports.finalizedAt),
          ),
        )
        .orderBy(sql`${usageReports.periodStart} DESC`)
        .limit(1)
        .get();

      if (stalePrev) {
        const prevCount = await countRequestsInPeriodRange(
          db,
          sub.tenantId,
          stalePrev.periodStart,
          stalePrev.periodEnd,
        );
        const prevOverage = calculateOverage(prevCount, sub.tier);
        const prevDelta = prevOverage - stalePrev.reportedOverageCount;
        if (prevDelta > 0) {
          const flushIdentifier = `usage:${sub.stripeSubscriptionId}:${Math.floor(
            stalePrev.periodStart.getTime() / 1000,
          )}:${prevOverage}:final`;
          // Timestamp = 1s before period end so the event lands in the
          // closed period regardless of how late this push arrives.
          const flushTs = new Date(stalePrev.periodEnd.getTime() - 1000);
          await pushMeterEvent(
            stripe,
            sub.stripeCustomerId,
            prevDelta,
            flushIdentifier,
            flushTs,
          );
          const flushUsd = (prevDelta / 1000) * OVERAGE_RATE_PER_1K;
          const updated = await updateReportOptimistically(db, stalePrev.id, stalePrev.reportedOverageCount, {
            reportedOverageCount: prevOverage,
            totalPushedUsd: stalePrev.totalPushedUsd + flushUsd,
            reportedAt: new Date(),
            lastEventIdentifier: flushIdentifier,
            finalizedAt: new Date(),
          });
          if (!updated) {
            console.warn(
              `[usage] optimistic update lost race for rollover flush on ${sub.stripeSubscriptionId}; skipping this cycle`,
            );
            continue;
          }
          stats.reportsWritten++;
          stats.deltaRequestsReported += prevDelta;
          console.log(
            `[usage] flushed +${prevDelta} final-period overage for ${sub.tier} sub ${sub.stripeSubscriptionId} (prior period)`,
          );
        } else {
          // No new overage on the old period; just mark it finalized
          // so we don't re-check on every cycle.
          await db
            .update(usageReports)
            .set({ finalizedAt: new Date() })
            .where(eq(usageReports.id, stalePrev.id))
            .run();
        }
      }

      // --- Current-period pass ---
      const currentUsage = await countRequestsInPeriod(db, sub.tenantId, sub.currentPeriodStart);
      const currentOverage = calculateOverage(currentUsage, sub.tier);

      const report = await getOrCreateReportRow(db, sub);
      const alreadyReported = report.reportedOverageCount;
      const delta = currentOverage - alreadyReported;

      if (delta <= 0) {
        // No new overage since last report; skip. This is the common
        // case for tenants staying under quota.
        continue;
      }

      // Deterministic identifier so retries dedupe at Stripe. Includes
      // the high-water mark so sequential pushes don't collide.
      const identifier = `usage:${sub.stripeSubscriptionId}:${Math.floor(
        sub.currentPeriodStart.getTime() / 1000,
      )}:${currentOverage}`;

      await pushMeterEvent(stripe, sub.stripeCustomerId, delta, identifier);

      const deltaUsd = (delta / 1000) * OVERAGE_RATE_PER_1K;
      const updated = await updateReportOptimistically(db, report.id, alreadyReported, {
        reportedOverageCount: currentOverage,
        totalPushedUsd: report.totalPushedUsd + deltaUsd,
        reportedAt: new Date(),
        lastEventIdentifier: identifier,
      });
      if (!updated) {
        // Another cycle beat us to it — that's fine, Stripe's identifier
        // dedupe protects against double-bill. Next cycle will resume.
        console.warn(
          `[usage] optimistic update lost race on ${sub.stripeSubscriptionId} (current period); skipping`,
        );
        continue;
      }

      stats.reportsWritten++;
      stats.deltaRequestsReported += delta;
      console.log(
        `[usage] reported +${delta} overage requests (total ${currentOverage}) for ${sub.tier} sub ${sub.stripeSubscriptionId}`,
      );
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[usage] report failed for subscription ${sub.stripeSubscriptionId}:`, msg);
    }
  }

  return stats;
}

/**
 * List recent usage reports for admin audit — "prove my overage charge"
 * support workflow. Tenant-scoped.
 */
export async function listRecentUsageReports(
  db: Db,
  tenantId: string,
  limit = 50,
) {
  return db
    .select()
    .from(usageReports)
    .where(eq(usageReports.tenantId, tenantId))
    .orderBy(sql`${usageReports.periodStart} DESC`)
    .limit(limit)
    .all();
}

/**
 * Is the given tenant on an operator allowlist (free pass on quota)?
 * Used by the quota-enforcement middleware and the reporting cycle.
 */
export async function isOperatorTenantForQuota(db: Db, tenantId: string): Promise<boolean> {
  const allowlist = getOperatorEmails();
  if (allowlist.length === 0) return false;
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        sql`LOWER(${users.email}) IN (${sql.join(
          allowlist.map((e) => sql`${e}`),
          sql`, `,
        )})`,
      ),
    )
    .get();
  return Boolean(row);
}
