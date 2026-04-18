import type { Db } from "@provara/db";
import { users, teamInvites, subscriptions } from "@provara/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getOperatorEmails } from "../config.js";

/**
 * Seat quotas per tier (#177). Mirrors the marketing copy on
 * apps/web/src/lib/pricing.ts and the Team tier card. Keep in sync.
 *
 * Unlimited tiers use MAX_SAFE_INTEGER so downstream math treats
 * them as "always has room."
 */
export const SEAT_QUOTAS: Record<string, number> = {
  free: 1,
  pro: 3,
  team: 10,
  enterprise: Number.MAX_SAFE_INTEGER,
  selfhost_enterprise: Number.MAX_SAFE_INTEGER,
  operator: Number.MAX_SAFE_INTEGER,
};

export function seatQuotaForTier(tier: string): number {
  return SEAT_QUOTAS[tier] ?? SEAT_QUOTAS.free;
}

export interface SeatStatus {
  tier: string;
  members: number;
  pendingInvites: number;
  used: number;
  limit: number;
  unlimited: boolean;
  canInvite: boolean;
}

/**
 * Current seat state for a tenant. `used` counts active members plus
 * unconsumed, unexpired invites — so an owner can't invite their way
 * past the limit by queueing invites while no one has accepted yet.
 */
export async function getSeatStatus(db: Db, tenantId: string): Promise<SeatStatus> {
  const now = new Date();

  const [{ count: members = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .all();

  const [{ count: pending = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(teamInvites)
    .where(
      and(
        eq(teamInvites.tenantId, tenantId),
        isNull(teamInvites.consumedAt),
        gte(teamInvites.expiresAt, now),
      ),
    )
    .all();

  // Tier resolution — operator tenants override any subscription tier
  // because they're on an allowlist bypass; otherwise read the sub.
  const allowlist = getOperatorEmails();
  let tier = "free";
  if (allowlist.length > 0) {
    const op = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          sql`LOWER(${users.email}) IN (${sql.join(allowlist.map((e) => sql`${e}`), sql`, `)})`,
        ),
      )
      .get();
    if (op) tier = "operator";
  }
  if (tier === "free") {
    const sub = await db
      .select({ tier: subscriptions.tier })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .get();
    if (sub) tier = sub.tier;
  }

  const limit = seatQuotaForTier(tier);
  const unlimited = limit === Number.MAX_SAFE_INTEGER;
  const used = members + pending;
  return {
    tier,
    members,
    pendingInvites: pending,
    used,
    limit,
    unlimited,
    canInvite: unlimited || used < limit,
  };
}
