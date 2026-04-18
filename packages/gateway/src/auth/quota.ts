import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { getSubscriptionForTenant } from "../stripe/subscriptions.js";
import { getTenantId } from "./tenant.js";
import {
  TIER_QUOTAS,
  countRequestsInPeriod,
  isOperatorTenantForQuota,
} from "../billing/usage.js";
import { isCloudDeployment } from "../config.js";

/**
 * Hot-path quota enforcement for the Free tier (#170). Pro and Team
 * get soft overage (metered billing via #170 reporting cycle); Free
 * gets a hard cutoff so we don't subsidize unlimited usage on a $0
 * plan. Enterprise and operator tenants bypass entirely.
 *
 * Caching: counting a tenant's requests on every single chat
 * completion would DDoS the DB with `SELECT count(*) FROM requests`
 * queries. We cache the quota decision per tenant with a short TTL
 * and invalidate on subscription changes (webhook from #167 calls
 * `invalidateQuotaCache(tenantId)`).
 *
 * Invariant: a false-negative (allow when we should block) is strictly
 * preferable to a false-positive (block when we shouldn't). Cache
 * misses default to "allow" and refresh on the next tick.
 */

const CACHE_TTL_MS = 60_000; // 1 minute — tight enough that a user who upgrades sees it within a minute

interface QuotaDecision {
  allowed: boolean;
  used: number;
  quota: number;
  tier: string;
  checkedAt: number;
}

const quotaCache = new Map<string, QuotaDecision>();

/** Test-only: clear the cache so unit tests don't leak state. */
export function __resetQuotaCacheForTests(): void {
  quotaCache.clear();
}

/** Webhook handler calls this when a tenant's subscription changes. */
export function invalidateQuotaCache(tenantId: string): void {
  quotaCache.delete(tenantId);
}

/**
 * Expensive check — hits the DB. Called on cache miss or expiry. All
 * fast-path calls come from `shouldAllowRequest`.
 */
async function computeQuotaDecision(db: Db, tenantId: string): Promise<QuotaDecision> {
  // Operator bypass first (zero-DB for the common case once allowlist
  // is cached in process env).
  if (await isOperatorTenantForQuota(db, tenantId)) {
    return {
      allowed: true,
      used: 0,
      quota: Number.MAX_SAFE_INTEGER,
      tier: "operator",
      checkedAt: Date.now(),
    };
  }

  const sub = await getSubscriptionForTenant(db, tenantId);
  const tier = sub?.tier ?? "free";

  // Pro/Team/Enterprise: overage is metered (Pro/Team) or custom
  // (Enterprise). Don't hard-cut; let the request through and let
  // the reporting cycle bill it.
  if (tier !== "free") {
    return {
      allowed: true,
      used: 0,
      quota: TIER_QUOTAS[tier] ?? Number.MAX_SAFE_INTEGER,
      tier,
      checkedAt: Date.now(),
    };
  }

  // Free — check usage against quota. Period = calendar month since
  // there's no subscription row to pin a billing cycle.
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const used = await countRequestsInPeriod(db, tenantId, periodStart);
  const quota = TIER_QUOTAS.free;

  return {
    allowed: used < quota,
    used,
    quota,
    tier: "free",
    checkedAt: Date.now(),
  };
}

async function getQuotaDecision(db: Db, tenantId: string): Promise<QuotaDecision> {
  const cached = quotaCache.get(tenantId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await computeQuotaDecision(db, tenantId);
  quotaCache.set(tenantId, fresh);
  return fresh;
}

/**
 * Middleware factory for `/v1/chat/completions`. Returns 429 with an
 * upgrade-friendly payload when a Free-tier tenant has exhausted their
 * monthly quota. Bypasses entirely in self_hosted mode or when no
 * tenant is resolved (something else will have already 401'd, but
 * we're defensive).
 */
export function requireQuota(db: Db) {
  return async (c: Context, next: Next) => {
    // Self-host has no quotas; the feature is only meaningful on Cloud.
    if (!isCloudDeployment()) return next();

    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) return next(); // upstream auth should have blocked

    const decision = await getQuotaDecision(db, tenantId);
    if (decision.allowed) return next();

    return c.json(
      {
        error: {
          message: `Free-tier monthly quota exhausted (${decision.used} / ${decision.quota} requests). Upgrade to Pro to continue.`,
          type: "quota_exceeded",
        },
        gate: {
          reason: "quota_exceeded",
          currentTier: decision.tier,
          used: decision.used,
          quota: decision.quota,
          upgradeUrl: "/dashboard/billing",
        },
      },
      429,
    );
  };
}
