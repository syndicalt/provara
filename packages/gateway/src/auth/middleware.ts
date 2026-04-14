import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { apiTokens } from "@provara/db";
import { sql } from "drizzle-orm";
import { verifyToken, type TokenInfo } from "./tokens.js";
import { checkRateLimit, checkSpendLimit } from "./rate-limiter.js";

// Store tenant info on the request context via a WeakMap keyed by request
const tokenInfoMap = new WeakMap<Request, TokenInfo>();

export function getTokenInfo(req: Request): TokenInfo | undefined {
  return tokenInfoMap.get(req);
}

export function createAuthMiddleware(db: Db) {
  return async (c: Context, next: Next) => {
    // Skip auth for health check
    if (c.req.path === "/health") {
      return next();
    }

    // Skip auth for admin routes (accessed from dashboard)
    if (c.req.path.startsWith("/v1/admin/")) {
      return next();
    }

    // Check if any tokens exist — if not, run in open mode
    const tokenCount = db
      .select({ count: sql<number>`count(*)` })
      .from(apiTokens)
      .get();

    if (!tokenCount || tokenCount.count === 0) {
      return next();
    }

    // Extract Bearer token
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        { error: { message: "Missing or invalid Authorization header. Use: Bearer <token>", type: "auth_error" } },
        401
      );
    }

    const token = authHeader.slice(7);
    const info = verifyToken(db, token);

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
      const spendResult = checkSpendLimit(db, info);
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
