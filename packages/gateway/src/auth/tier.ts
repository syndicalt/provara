import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { users } from "@provara/db";
import { eq, and, sql } from "drizzle-orm";
import { getOperatorEmails, isCloudDeployment } from "../config.js";
import { getTenantId } from "./tenant.js";
import { getSubscriptionForTenant } from "../stripe/subscriptions.js";

/**
 * Operator bypass lookup (#173). A tenant is an "operator tenant" if any
 * of its users has an email on the PROVARA_OPERATOR_EMAILS allowlist.
 * Returns true → the tenant bypasses subscription checks at both the
 * HTTP middleware and the scheduler cycle layer. Tiny DB hit per gate
 * check; acceptable because Intelligence routes are not on the hot path
 * for chat completions.
 */
export async function isOperatorTenant(db: Db, tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false;
  const allowlist = getOperatorEmails();
  if (allowlist.length === 0) return false;
  // Case-insensitive comparison — OAuth providers return inconsistent
  // casings (Google preserves the user's preferred casing, GitHub
  // lowercases), so we compare on LOWER(email). The allowlist is
  // already lowercased by getOperatorEmails.
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

/**
 * Subscription statuses that grant feature access to the tenant's tier.
 * `active` and `trialing` are the happy paths. `past_due` grace is
 * intentional — Stripe's Smart Retries give customers time to fix a
 * failed card before true account lockout, and we mirror that by
 * keeping access live during dunning. Dashboard surfaces a warning
 * banner so the customer knows.
 *
 * Everything else (canceled, unpaid, incomplete, incomplete_expired,
 * paused) blocks access.
 */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface TierGateFailure {
  reason: "not_cloud" | "no_subscription" | "insufficient_tier" | "inactive_status";
  currentTier: string;
  status?: string;
  upgradeUrl: string;
}

/**
 * Middleware factory: returns a Hono middleware that allows the request
 * through only when the caller's tenant has an active subscription with
 * `includes_intelligence = true`. Returns HTTP 402 otherwise.
 *
 * Two layers of refusal (#168):
 *
 *   1. Deployment layer — `PROVARA_CLOUD` must be "true". Self-host
 *      installs never reach tenant lookup; they see a generic "this is
 *      a Cloud feature" response.
 *
 *   2. Tenant layer — the tenant's `subscriptions` row must grant
 *      Intelligence and be in an active-ish status.
 *
 * The 402 response body carries enough structured info for the dashboard
 * to render an Upgrade CTA in place of the feature (see #169).
 */
export function requireIntelligenceTier(db: Db) {
  return async (c: Context, next: Next) => {
    const tenantId = getTenantId(c.req.raw);

    // Operator bypass (#173) runs before any other gate so CoreLumen's own
    // team can use Intelligence features in all environments — including
    // self-host preview deploys — without needing a Stripe subscription
    // seeded for their tenant.
    if (tenantId && (await isOperatorTenant(db, tenantId))) {
      return next();
    }

    if (!isCloudDeployment()) {
      return c.json(
        {
          error: {
            message: "Intelligence features are available on Provara Cloud.",
            type: "cloud_only",
          },
          gate: {
            reason: "not_cloud",
            currentTier: "selfhost",
            upgradeUrl: "https://provara.xyz/pricing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    if (!tenantId) {
      // Multi_tenant mode without a tenant means unauthenticated — the
      // admin/auth middleware upstream should have caught this. Belt-and-
      // suspenders: refuse rather than apply gate to an anonymous caller.
      return c.json(
        { error: { message: "Authentication required.", type: "auth_error" } },
        401,
      );
    }

    const sub = await getSubscriptionForTenant(db, tenantId);

    if (!sub) {
      return c.json(
        {
          error: {
            message: "Your current plan does not include this feature.",
            type: "insufficient_tier",
          },
          gate: {
            reason: "no_subscription",
            currentTier: "free",
            upgradeUrl: "https://provara.xyz/dashboard/billing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    if (!ACTIVE_STATUSES.has(sub.status)) {
      return c.json(
        {
          error: {
            message: "Your subscription is not in an active status.",
            type: "inactive_subscription",
          },
          gate: {
            reason: "inactive_status",
            currentTier: sub.tier,
            status: sub.status,
            upgradeUrl: "https://provara.xyz/dashboard/billing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    if (!sub.includesIntelligence) {
      return c.json(
        {
          error: {
            message: "Intelligence features are available on Pro and higher plans.",
            type: "insufficient_tier",
          },
          gate: {
            reason: "insufficient_tier",
            currentTier: sub.tier,
            status: sub.status,
            upgradeUrl: "https://provara.xyz/dashboard/billing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    return next();
  };
}

/**
 * Middleware factory: like `requireIntelligenceTier`, but gates on the
 * Enterprise tier specifically. Used for enterprise-exclusive features
 * (SAML SSO #209, extended audit-log retention, dedicated support APIs).
 *
 * Same operator bypass + Cloud check as `requireIntelligenceTier` — the
 * only difference is the tier comparison: the tenant's subscription row
 * must have `tier === "enterprise"` (or `selfhost_enterprise`, which the
 * dashboard TIER_ORDER treats at the same rank).
 */
export function requireEnterpriseTier(db: Db) {
  return async (c: Context, next: Next) => {
    const tenantId = getTenantId(c.req.raw);

    if (tenantId && (await isOperatorTenant(db, tenantId))) {
      return next();
    }

    if (!isCloudDeployment()) {
      return c.json(
        {
          error: {
            message: "Enterprise features are available on Provara Cloud.",
            type: "cloud_only",
          },
          gate: {
            reason: "not_cloud",
            currentTier: "selfhost",
            upgradeUrl: "https://provara.xyz/pricing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    if (!tenantId) {
      return c.json(
        { error: { message: "Authentication required.", type: "auth_error" } },
        401,
      );
    }

    const sub = await getSubscriptionForTenant(db, tenantId);

    if (!sub) {
      return c.json(
        {
          error: {
            message: "This feature is available on the Enterprise plan.",
            type: "insufficient_tier",
          },
          gate: {
            reason: "no_subscription",
            currentTier: "free",
            upgradeUrl: "https://provara.xyz/pricing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    if (!ACTIVE_STATUSES.has(sub.status)) {
      return c.json(
        {
          error: {
            message: "Your subscription is not in an active status.",
            type: "inactive_subscription",
          },
          gate: {
            reason: "inactive_status",
            currentTier: sub.tier,
            status: sub.status,
            upgradeUrl: "https://provara.xyz/dashboard/billing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    if (sub.tier !== "enterprise" && sub.tier !== "selfhost_enterprise") {
      return c.json(
        {
          error: {
            message: "This feature is available on the Enterprise plan.",
            type: "insufficient_tier",
          },
          gate: {
            reason: "insufficient_tier",
            currentTier: sub.tier,
            status: sub.status,
            upgradeUrl: "https://provara.xyz/pricing",
          } satisfies TierGateFailure,
        },
        402,
      );
    }

    return next();
  };
}

/**
 * Non-middleware variant for server-side callers (scheduler cycles) that
 * need to decide per-tenant whether to process. Mirrors the middleware
 * logic exactly so the gates are consistent, including the operator
 * allowlist bypass (#173).
 */
export async function tenantHasIntelligenceAccess(
  db: Db,
  tenantId: string | null,
): Promise<boolean> {
  if (!tenantId) return false;
  // Operator bypass takes precedence so CoreLumen's own scheduler cycles
  // process operator tenants even in self-host preview environments.
  if (await isOperatorTenant(db, tenantId)) return true;
  if (!isCloudDeployment()) return false;
  const sub = await getSubscriptionForTenant(db, tenantId);
  if (!sub) return false;
  if (!ACTIVE_STATUSES.has(sub.status)) return false;
  return sub.includesIntelligence;
}
