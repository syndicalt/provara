import type { Db } from "@provara/db";
import { subscriptions } from "@provara/db";

/**
 * Seed an Intelligence-tier subscription for a test tenant so code paths
 * gated by #168's tier check pass. Also sets PROVARA_CLOUD=true on the
 * process so the deployment-layer gate is satisfied.
 *
 * Tests that want to exercise the *gated-off* path (free tier, non-cloud)
 * should NOT call this — they should either leave PROVARA_CLOUD unset or
 * skip seeding a subscription, and assert 402 / early-return.
 */
export async function grantIntelligenceAccess(
  db: Db,
  tenantId: string,
  options: { tier?: "pro" | "team" | "enterprise"; status?: "active" | "trialing" | "past_due" } = {},
): Promise<void> {
  process.env.PROVARA_CLOUD = "true";
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db
    .insert(subscriptions)
    .values({
      stripeSubscriptionId: `sub_test_${tenantId}`,
      tenantId,
      stripeCustomerId: `cus_test_${tenantId}`,
      stripePriceId: "price_test_pro_monthly",
      stripeProductId: "prod_test_pro",
      tier: options.tier ?? "pro",
      includesIntelligence: true,
      status: options.status ?? "active",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Reset env vars between tests to avoid leaking PROVARA_CLOUD. */
export function resetTierEnv(): void {
  delete process.env.PROVARA_CLOUD;
}
