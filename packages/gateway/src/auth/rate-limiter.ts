import type { Db } from "@provara/db";
import { costLogs } from "@provara/db";
import { eq, and, gte, sql } from "drizzle-orm";
import type { TokenInfo } from "./tokens.js";

// In-memory sliding window counters (reset on restart — fine for single-instance)
const windowCounters = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60_000; // 1 minute

export function checkRateLimit(tokenId: string, rateLimit: number | null): { allowed: boolean; remaining: number; resetMs: number } {
  if (!rateLimit) return { allowed: true, remaining: -1, resetMs: 0 };

  const now = Date.now();
  const entry = windowCounters.get(tokenId);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    // New window
    windowCounters.set(tokenId, { count: 1, windowStart: now });
    return { allowed: true, remaining: rateLimit - 1, resetMs: WINDOW_MS };
  }

  if (entry.count >= rateLimit) {
    const resetMs = WINDOW_MS - (now - entry.windowStart);
    return { allowed: false, remaining: 0, resetMs };
  }

  entry.count++;
  const resetMs = WINDOW_MS - (now - entry.windowStart);
  return { allowed: true, remaining: rateLimit - entry.count, resetMs };
}

function getPeriodStart(period: string): Date {
  const now = new Date();
  switch (period) {
    case "daily":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "weekly": {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday start
      return new Date(now.getFullYear(), now.getMonth(), diff);
    }
    case "monthly":
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1);
  }
}

export async function checkSpendLimit(
  db: Db,
  tokenInfo: TokenInfo
): Promise<{ allowed: boolean; spent: number; limit: number; period: string }> {
  if (!tokenInfo.spendLimit) {
    return { allowed: true, spent: 0, limit: -1, period: "none" };
  }

  const period = tokenInfo.spendPeriod || "monthly";
  const periodStart = getPeriodStart(period);

  const result = await db
    .select({ total: sql<number>`coalesce(sum(${costLogs.cost}), 0)` })
    .from(costLogs)
    .where(
      and(
        eq(costLogs.tenantId, tokenInfo.tenant),
        gte(costLogs.createdAt, periodStart)
      )
    )
    .get();

  const spent = result?.total || 0;

  return {
    allowed: spent < tokenInfo.spendLimit,
    spent,
    limit: tokenInfo.spendLimit,
    period,
  };
}
