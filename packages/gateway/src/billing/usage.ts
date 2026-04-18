import type { Db } from "@provara/db";
import { requests, subscriptions, usageReports, users } from "@provara/db";
import { and, eq, gte, sql } from "drizzle-orm";
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
): Promise<void> {
  await stripe.billing.meterEvents.create({
    event_name: METER_EVENT_NAME,
    identifier,
    // Stripe docs require the payload fields to be strings, not numbers.
    payload: {
      stripe_customer_id: stripeCustomerId,
      value: String(deltaCount),
    },
    // Timestamp defaults to "now" if omitted; letting Stripe stamp it
    // avoids clock-skew issues between our server and theirs.
  });
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
      await db
        .update(usageReports)
        .set({
          reportedOverageCount: currentOverage,
          totalPushedUsd: report.totalPushedUsd + deltaUsd,
          reportedAt: new Date(),
          lastEventIdentifier: identifier,
        })
        .where(eq(usageReports.id, report.id))
        .run();

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
