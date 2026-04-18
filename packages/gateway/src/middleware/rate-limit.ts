import type { Context, MiddlewareHandler, Next } from "hono";
import type { Db } from "@provara/db";
import { emitAudit } from "../audit/emit.js";
import { AUDIT_RATE_LIMIT_EXCEEDED } from "../audit/actions.js";
import { getTenantId } from "../auth/tenant.js";

/**
 * IP-keyed rate limiting (#192). Fixed-window counter, single-replica
 * in-memory — fine for v1. Multi-replica shared-state rides on #50.
 *
 * Separate concern from the existing token-scoped `checkRateLimit` in
 * `auth/rate-limiter.ts`: that limiter enforces per-token `rateLimit`
 * on authenticated programmatic callers. This module adds the missing
 * layer — per-IP abuse protection on public + unauthenticated routes
 * plus a global DoS floor on the chat-completions hot path.
 *
 * Scope keys are ("auth" | "chat" | "invite" | ...) so the counter
 * maps for different route groups don't collide. A single request may
 * pass through multiple rate-limit middlewares when both a group-level
 * and route-level limit apply; each middleware consumes one increment
 * in its own scope.
 *
 * Audit emission: when the blocked caller has a tenant resolvable from
 * the existing auth context, we emit `rate_limit.exceeded` via the
 * #210 audit infrastructure — one row per (scope, key, tenantId)
 * burst, suppressed for `AUDIT_SUPPRESS_MS` so sustained hits don't
 * flood `audit_logs`. Unauthenticated hits log to stdout only
 * (operators notice them via infra metrics).
 */

const AUDIT_SUPPRESS_MS = 60_000;

export interface WindowLimit {
  /** Limit within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface WindowCheck {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const counters = new Map<string, { count: number; windowStart: number }>();
const lastAuditAt = new Map<string, number>();

/** Test-only reset. Never call from production code. */
export function __resetRateLimitStateForTests(): void {
  counters.clear();
  lastAuditAt.clear();
}

/**
 * Fixed-window counter check. Keyed by `${scope}:${key}`. Pure w.r.t.
 * I/O (only mutates the module-local counters Map) so tests can drive
 * it directly without spinning up a Hono app.
 */
export function checkWindowLimit(
  scope: string,
  key: string,
  config: WindowLimit,
  now: number = Date.now(),
): WindowCheck {
  const fullKey = `${scope}:${key}`;
  const entry = counters.get(fullKey);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    counters.set(fullKey, { count: 1, windowStart: now });
    return { allowed: true, remaining: config.limit - 1, resetMs: config.windowMs };
  }

  if (entry.count >= config.limit) {
    return {
      allowed: false,
      remaining: 0,
      resetMs: config.windowMs - (now - entry.windowStart),
    };
  }

  entry.count++;
  return {
    allowed: true,
    remaining: config.limit - entry.count,
    resetMs: config.windowMs - (now - entry.windowStart),
  };
}

function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip") || "";
  return fwd.split(",")[0]?.trim() || "unknown";
}

export interface RateLimitMiddlewareOptions extends WindowLimit {
  /** Logical scope label, e.g. "auth", "chat", "invite". */
  scope: string;
  /** Custom key resolver. Default: client IP from x-forwarded-for / cf-connecting-ip. */
  keyFn?: (c: Context) => string;
  /**
   * Emit audit events for rate-limit hits from authenticated callers.
   * Pass the `Db` handle to turn this on; omit to stay silent
   * (unauthenticated-only routes should omit — stdout only).
   */
  audit?: { db: Db };
}

/**
 * Build a Hono middleware that enforces the given rate limit. Returns
 * 429 with `Retry-After` (seconds) and `X-RateLimit-*` headers when
 * the caller's bucket is full.
 */
export function createRateLimitMiddleware(opts: RateLimitMiddlewareOptions): MiddlewareHandler {
  const { scope, limit, windowMs, keyFn, audit } = opts;
  const resolveKey = keyFn ?? clientIp;

  return async (c: Context, next: Next) => {
    const key = resolveKey(c);
    const check = checkWindowLimit(scope, key, { limit, windowMs });

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(check.remaining));

    if (!check.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(check.resetMs / 1000));
      c.header("Retry-After", String(retryAfterSec));

      if (audit) {
        const tenantId = getTenantId(c.req.raw);
        if (tenantId) {
          const auditKey = `${scope}:${key}:${tenantId}`;
          const now = Date.now();
          const last = lastAuditAt.get(auditKey) ?? 0;
          if (now - last >= AUDIT_SUPPRESS_MS) {
            lastAuditAt.set(auditKey, now);
            emitAudit(audit.db, {
              tenantId,
              action: AUDIT_RATE_LIMIT_EXCEEDED,
              metadata: {
                scope,
                key,
                limit,
                window_ms: windowMs,
                path: c.req.path,
                method: c.req.method,
              },
            });
          }
        }
      }

      console.warn(
        `[rate-limit] 429 scope=${scope} key=${key} path=${c.req.path} retry_after_s=${retryAfterSec}`,
      );

      return c.json(
        {
          error: {
            message: "Rate limit exceeded. Try again shortly.",
            type: "rate_limit_error",
          },
        },
        429,
      );
    }

    return next();
  };
}

/**
 * Env-driven config (#192/T5). Sensible defaults so nothing needs env
 * variables to work out of the box; operators can tune per-environment
 * without redeploys.
 */
export interface RateLimitConfig {
  authPerMinute: WindowLimit;
  invitePerMinute: WindowLimit;
  chatPerSecond: WindowLimit;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function loadRateLimitConfig(): RateLimitConfig {
  return {
    authPerMinute: {
      limit: positiveIntFromEnv("RATE_LIMIT_AUTH_PER_MIN", 20),
      windowMs: 60_000,
    },
    invitePerMinute: {
      limit: positiveIntFromEnv("RATE_LIMIT_INVITE_PER_MIN", 20),
      windowMs: 60_000,
    },
    chatPerSecond: {
      limit: positiveIntFromEnv("RATE_LIMIT_CHAT_RPS", 200),
      windowMs: 1_000,
    },
  };
}
