import { Hono } from "hono";
import type { Db } from "@provara/db";
import { requests as requestsTable } from "@provara/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { getTenantId } from "../auth/tenant.js";
import { getSubscriptionForTenant } from "../stripe/subscriptions.js";
import { getStripe } from "../stripe/index.js";
import { getOperatorEmails } from "../config.js";
import { users } from "@provara/db";
import { listRecentUsageReports, TIER_QUOTAS } from "../billing/usage.js";

/**
 * Billing routes (#169). Dashboard-facing endpoints for reading the
 * current tenant's subscription state, generating Stripe Checkout
 * Sessions for upgrades, and opening Stripe Customer Portal sessions
 * for plan management.
 *
 * Does NOT implement webhooks (that's #167) or feature gating (#168).
 * These routes sit alongside the gate — a gated route returns 402 +
 * structured upgrade info; the dashboard reads that info and calls
 * back into these routes to take action.
 */

/**
 * Tier quotas single-sourced from `src/billing/usage.ts::TIER_QUOTAS`
 * so the displayed quota here cannot drift from what the metering
 * cycle actually enforces. Any future change to quotas is a one-file
 * edit with compile-time safety.
 */
function quotaForTier(tier: string): number {
  return TIER_QUOTAS[tier] ?? Number.MAX_SAFE_INTEGER;
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export function createBillingRoutes(db: Db) {
  const app = new Hono();

  /**
   * Returns the caller's current subscription + computed tier. Used by
   * the dashboard sidebar's tier badge and the /dashboard/billing page.
   * Unlike the gate middleware, this endpoint succeeds with a response
   * body for Free tenants rather than returning 402 — it's descriptive,
   * not enforcing.
   */
  app.get("/me", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }

    // Operator tenants appear as "operator" tier in UI so their badge is
    // distinct from customer tiers — avoids awkward "Enterprise" badges
    // on employee accounts that aren't actually Enterprise customers.
    const allowlist = getOperatorEmails();
    if (allowlist.length > 0) {
      const operatorRow = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.tenantId, tenantId),
          sql`LOWER(${users.email}) IN (${sql.join(allowlist.map((e) => sql`${e}`), sql`, `)})`,
        ))
        .get();
      if (operatorRow) {
        return c.json({
          tier: "operator",
          includesIntelligence: true,
          status: "active",
          quotaPerMonth: null,
        });
      }
    }

    const sub = await getSubscriptionForTenant(db, tenantId);
    if (!sub) {
      return c.json({
        tier: "free",
        includesIntelligence: false,
        status: "active",
        quotaPerMonth: quotaForTier("free"),
      });
    }

    return c.json({
      tier: sub.tier,
      includesIntelligence: sub.includesIntelligence,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      trialEnd: sub.trialEnd,
      quotaPerMonth: quotaForTier(sub.tier),
    });
  });

  /**
   * Current period usage against quota. Dashboard billing page calls
   * this for the usage bar. Quota comes from the tier; current-period
   * count comes from the requests table scoped to the tenant.
   */
  app.get("/usage", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }

    const sub = await getSubscriptionForTenant(db, tenantId);
    const tier = sub?.tier ?? "free";

    // "Current period" is the subscription's billing period for Pro+, or
    // calendar month for Free (no billing period on $0 sub).
    const periodStart = sub?.currentPeriodStart ?? (() => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    })();

    const row = await db
      .select({ count: sql<number>`count(*)` })
      .from(requestsTable)
      .where(and(
        eq(requestsTable.tenantId, tenantId),
        gte(requestsTable.createdAt, periodStart),
      ))
      .get();

    const count = row?.count ?? 0;
    const quota = quotaForTier(tier);
    const remaining = Math.max(0, quota - count);
    const percentUsed = quota === Number.MAX_SAFE_INTEGER ? 0 : Math.min(100, (count / quota) * 100);

    return c.json({
      tier,
      periodStart,
      periodEnd: sub?.currentPeriodEnd ?? null,
      used: count,
      quota,
      quotaUnlimited: quota === Number.MAX_SAFE_INTEGER,
      remaining,
      percentUsed,
    });
  });

  /**
   * Generate a Stripe Customer Portal URL for plan management. Owner-
   * scoped (members can't manage billing). Requires the tenant to have
   * a Stripe customer ID already; Free tenants who've never bought
   * anything get a 400 with guidance to use /checkout-session instead.
   */
  app.post("/portal-session", async (c) => {
    const stripe = getStripe();
    if (!stripe) {
      return c.json({ error: { message: "Billing is not configured on this deployment.", type: "not_configured" } }, 503);
    }
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }

    const sub = await getSubscriptionForTenant(db, tenantId);
    if (!sub) {
      return c.json(
        { error: { message: "No active subscription to manage. Upgrade to Pro first.", type: "no_subscription" } },
        400,
      );
    }

    const dashboardOrigin = c.req.header("origin") || "https://www.provara.xyz";
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${dashboardOrigin}/dashboard/billing`,
    });
    return c.json({ url: session.url });
  });

  /**
   * Generate a Stripe Checkout Session for upgrading to a named price.
   * Body: { priceLookupKey: "cloud_pro_monthly" | "cloud_pro_yearly" |
   * "cloud_team_monthly" | "cloud_team_yearly" }.
   *
   * The lookup key is how we reference a Stripe price without hardcoding
   * price_xxx IDs that differ between test and live environments. The
   * endpoint translates it at request time and 400s cleanly if unknown.
   *
   * metadata.tenantId on the session is how the #167 webhook links the
   * resulting subscription back to the Provara tenant. Without it the
   * webhook handler no-ops with a warning and no row is written.
   */
  app.post("/checkout-session", async (c) => {
    const stripe = getStripe();
    if (!stripe) {
      return c.json({ error: { message: "Billing is not configured on this deployment.", type: "not_configured" } }, 503);
    }
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }

    // Refuse a second Checkout when the tenant is already on a paid,
    // active(-ish) plan. Our schema allows one subscription per tenant
    // (unique index on subscriptions.tenant_id and .stripe_customer_id);
    // a second Stripe sub would bill the customer twice and crash the
    // webhook upsert on UNIQUE collision. Plan changes (Pro → Team, etc.)
    // go through the Stripe Portal, not a fresh Checkout.
    const existingSub = await getSubscriptionForTenant(db, tenantId);
    if (existingSub && ACTIVE_SUBSCRIPTION_STATUSES.has(existingSub.status)) {
      return c.json(
        {
          error: {
            message:
              "You already have an active subscription. Use the billing portal to change your plan.",
            type: "already_subscribed",
          },
        },
        409,
      );
    }

    const body = await c.req
      .json<{ priceLookupKey?: string }>()
      .catch(() => ({} as { priceLookupKey?: string }));
    const lookupKey = body.priceLookupKey;
    if (!lookupKey) {
      return c.json({ error: { message: "priceLookupKey is required.", type: "validation_error" } }, 400);
    }

    const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) {
      return c.json(
        { error: { message: `Unknown price lookup key: ${lookupKey}`, type: "validation_error" } },
        400,
      );
    }

    // Re-use the existing Stripe customer if the tenant has a dormant
    // (canceled/incomplete_expired) subscription row, otherwise Checkout
    // creates a fresh one. Either way the subscription's `metadata.tenantId`
    // (set below) is what the webhook uses to link it back.
    const dashboardOrigin = c.req.header("origin") || "https://www.provara.xyz";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      customer: existingSub?.stripeCustomerId,
      client_reference_id: tenantId,
      metadata: { tenantId },
      subscription_data: { metadata: { tenantId } },
      success_url: `${dashboardOrigin}/dashboard/billing?checkout=success`,
      cancel_url: `${dashboardOrigin}/dashboard/billing?checkout=cancelled`,
    });

    return c.json({ url: session.url });
  });

  /**
   * Audit log of recent usage reports for the caller's tenant (#170).
   * Customer-facing: "prove the overage charge on my invoice" workflow.
   * Tenant-scoped; no privileged access required beyond being signed in
   * as a member of the tenant. Returns up to 50 most-recent periods
   * (subscription + legacy rows).
   */
  app.get("/usage-reports", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }
    const reports = await listRecentUsageReports(db, tenantId);
    return c.json({ reports });
  });

  return app;
}
