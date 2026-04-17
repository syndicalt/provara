import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { apiTokens } from "@provara/db";
import { eq, sql } from "drizzle-orm";
import { verifyToken, type TokenInfo } from "./tokens.js";
import { checkRateLimit, checkSpendLimit } from "./rate-limiter.js";
import { getSessionFromCookie, validateSession } from "./session.js";
import { getMode } from "../config.js";

// Store tenant info on the request context via a WeakMap keyed by request
const tokenInfoMap = new WeakMap<Request, TokenInfo>();

export function getTokenInfo(req: Request): TokenInfo | undefined {
  return tokenInfoMap.get(req);
}

/**
 * "Any enabled tokens exist?" is checked on every /v1/chat/completions call
 * to decide open-mode vs locked-mode. In practice this rarely flips —
 * operators add a token once and leave it. Cache the boolean with a short
 * TTL so we skip the COUNT(*) on the hot path. Staleness window: worst
 * case, a newly-added first token isn't enforced for `TOKEN_CHECK_TTL_MS`.
 * That's benign — the caller's token will still validate once the cache
 * refreshes; there's no auth bypass.
 */
const TOKEN_CHECK_TTL_MS = 30_000;
let hasEnabledTokensCache: { value: boolean; expiresAt: number } | null = null;

async function hasEnabledTokens(db: Db): Promise<boolean> {
  if (hasEnabledTokensCache && hasEnabledTokensCache.expiresAt > Date.now()) {
    return hasEnabledTokensCache.value;
  }
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(apiTokens)
    .where(eq(apiTokens.enabled, true))
    .get();
  const value = (row?.count ?? 0) > 0;
  hasEnabledTokensCache = { value, expiresAt: Date.now() + TOKEN_CHECK_TTL_MS };
  return value;
}

/** Invalidate the cache after token create/delete/update so the next
 *  request sees the change without waiting for TTL. Exported for the
 *  token-management routes to call. */
export function invalidateAuthCache(): void {
  hasEnabledTokensCache = null;
}

export function createAuthMiddleware(db: Db) {
  return async (c: Context, next: Next) => {
    // Skip auth for health check
    if (c.req.path === "/health") {
      return next();
    }

    // Skip auth for dashboard/admin routes — only gate chat completions
    if (c.req.path !== "/v1/chat/completions") {
      return next();
    }

    if (!(await hasEnabledTokens(db))) {
      return next();
    }

    // Extract Bearer token
    const authHeader = c.req.header("Authorization");

    // If no Bearer token, check for session cookie (dashboard playground)
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (getMode() === "multi_tenant") {
        const sessionId = getSessionFromCookie(c);
        if (sessionId) {
          const session = await validateSession(db, sessionId);
          if (session) {
            // Authenticated dashboard user — allow through without token
            return next();
          }
        }
      }

      return c.json(
        { error: { message: "Missing or invalid Authorization header. Use: Bearer <token>", type: "auth_error" } },
        401
      );
    }

    const token = authHeader.slice(7);
    const info = await verifyToken(db, token);

    if (!info) {
      return c.json(
        { error: { message: "Invalid or expired API token", type: "auth_error" } },
        401
      );
    }

    // Check rate limit
    const rateResult = checkRateLimit(info.id, info.rateLimit);
    if (!rateResult.allowed) {
      c.header("Retry-After", String(Math.ceil(rateResult.resetMs / 1000)));
      c.header("X-RateLimit-Limit", String(info.rateLimit));
      c.header("X-RateLimit-Remaining", "0");
      return c.json(
        { error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error" } },
        429
      );
    }

    // Check spend limit (only on completions endpoint to avoid overhead on reads)
    if (c.req.path === "/v1/chat/completions" && c.req.method === "POST") {
      const spendResult = await checkSpendLimit(db, info);
      if (!spendResult.allowed) {
        return c.json(
          {
            error: {
              message: `Spend limit exceeded. ${spendResult.spent.toFixed(4)} / ${spendResult.limit.toFixed(4)} USD (${spendResult.period})`,
              type: "spend_limit_error",
            },
          },
          402
        );
      }
    }

    // Set rate limit headers
    if (info.rateLimit) {
      c.header("X-RateLimit-Limit", String(info.rateLimit));
      c.header("X-RateLimit-Remaining", String(rateResult.remaining));
    }

    // Attach tenant info to request for downstream use
    tokenInfoMap.set(c.req.raw, info);

    return next();
  };
}
