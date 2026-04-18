import type { Db } from "@provara/db";
import { tenantAdaptiveIsolation } from "@provara/db";
import { eq } from "drizzle-orm";
import { isCloudDeployment } from "../../config.js";
import { getSubscriptionForTenant } from "../../stripe/subscriptions.js";

/**
 * Tier-aware adaptive isolation policy per #176/#195. Four fields:
 *
 * - `writesTenantRow` — does this tenant maintain its own `model_scores`
 *   row dimension (i.e. are we keeping per-tenant EMA)?
 * - `writesPool` — do feedback ratings update the shared pool row?
 * - `readsTenantRow` — does the router consult the tenant's row at
 *   decision time?
 * - `readsPool` — does the router consult the shared pool row (either
 *   primary or as fallback when the tenant row is empty/insufficient)?
 *
 * The combinations allowed per tier:
 *
 * | Tier       | writesTenant | writesPool  | readsTenant | readsPool    |
 * |------------|--------------|-------------|-------------|--------------|
 * | free       | false        | true        | false       | true         |
 * | pro        | false        | true        | false       | true         |
 * | team       | true         | toggle      | true        | toggle       |
 * | enterprise | true         | toggle      | true        | toggle       |
 *
 * For Free/Pro there are no toggles — they are always in the shared pool.
 * For Team/Enterprise the defaults are isolated, and two opt-in toggles
 * (`consumes_pool`, `contributes_pool`) flip `readsPool` and `writesPool`.
 *
 * Self-host (`PROVARA_CLOUD=false`) is single-tenant by definition, so
 * everyone is treated as Free-equivalent regardless of inputs.
 */
export type Tier = "free" | "pro" | "team" | "enterprise";

export interface IsolationPolicy {
  tier: Tier;
  writesTenantRow: boolean;
  writesPool: boolean;
  readsTenantRow: boolean;
  readsPool: boolean;
}

const FREE_POLICY: IsolationPolicy = {
  tier: "free",
  writesTenantRow: false,
  writesPool: true,
  readsTenantRow: false,
  readsPool: true,
};

const PRO_POLICY: IsolationPolicy = {
  ...FREE_POLICY,
  tier: "pro",
};

/** Which tiers are eligible for the per-tenant isolation toggles. */
const ISOLATION_TIERS = new Set<Tier>(["team", "enterprise"]);

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

function normalizeTier(raw: string | null | undefined): Tier {
  if (raw === "pro" || raw === "team" || raw === "enterprise") return raw;
  return "free";
}

/**
 * Resolve the live isolation policy for a tenant. Hits two tables in
 * the worst case (subscription + preferences), both indexed on
 * tenantId. Not cached yet — see #195 comment; add TTL caching if
 * latency shows up in hot-path tracing.
 */
export async function getTenantIsolationPolicy(
  db: Db,
  tenantId: string | null | undefined,
): Promise<IsolationPolicy> {
  // Self-host: single tenant, pool-only. Same path as Free.
  if (!isCloudDeployment()) return FREE_POLICY;

  // Unauthenticated / anonymous: pool-only, like Free. No tenant row exists.
  if (!tenantId) return FREE_POLICY;

  const sub = await getSubscriptionForTenant(db, tenantId);
  const tier = sub && ACTIVE_STATUSES.has(sub.status) ? normalizeTier(sub.tier) : "free";

  if (!ISOLATION_TIERS.has(tier)) {
    return tier === "pro" ? PRO_POLICY : FREE_POLICY;
  }

  // Team/Enterprise: load toggles.
  const prefs = await db
    .select()
    .from(tenantAdaptiveIsolation)
    .where(eq(tenantAdaptiveIsolation.tenantId, tenantId))
    .get();

  return {
    tier,
    writesTenantRow: true,
    readsTenantRow: true,
    writesPool: prefs?.contributesPool ?? false,
    readsPool: prefs?.consumesPool ?? false,
  };
}
