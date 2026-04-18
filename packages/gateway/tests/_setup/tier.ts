import type { Db } from "@provara/db";
import { subscriptions, users } from "@provara/db";
import { nanoid } from "nanoid";

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
  delete process.env.PROVARA_OPERATOR_EMAILS;
}

/**
 * Seed an operator user on the given tenant (#173). Does NOT set
 * PROVARA_CLOUD — operator bypass works regardless of deployment flag,
 * which is by design (operators can test self-host preview deploys).
 * Caller sets PROVARA_OPERATOR_EMAILS separately or via this helper's
 * `registerInAllowlist` option.
 */
export async function seedOperatorUser(
  db: Db,
  tenantId: string,
  email: string,
  options: { registerInAllowlist?: boolean } = {},
): Promise<void> {
  await db
    .insert(users)
    .values({
      id: nanoid(),
      email,
      tenantId,
      role: "owner",
      createdAt: new Date(),
    })
    .run();
  if (options.registerInAllowlist ?? true) {
    const existing = process.env.PROVARA_OPERATOR_EMAILS || "";
    const set = new Set(existing.split(",").map((e) => e.trim()).filter(Boolean));
    set.add(email);
    process.env.PROVARA_OPERATOR_EMAILS = Array.from(set).join(",");
  }
}
