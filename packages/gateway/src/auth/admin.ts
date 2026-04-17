import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { timingSafeEqual } from "node:crypto";
import { getMode } from "../config.js";
import { getSessionFromCookie, validateSession } from "./session.js";

// Store authenticated user on request for downstream use
const userMap = new WeakMap<Request, { id: string; tenantId: string; role: string }>();

export function getAuthUser(req: Request) {
  return userMap.get(req) || null;
}

/**
 * Constant-time string compare. `crypto.timingSafeEqual` requires equal-
 * length buffers, so we length-check first and return false on mismatch —
 * leaking the length is fine (the admin secret should be 32+ random
 * bytes; its length is not the secret). Only once lengths match do we
 * compare bytewise without short-circuiting on the first mismatch.
 */
function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Per-client failed-attempt counter for the X-Admin-Key path. Stores a
 * failure count and lockout timestamp per client-ip-ish key. Not shared
 * across processes — single-replica self-hosted only, which is where
 * this matters (multi_tenant uses session cookies, not admin keys). A
 * Redis-backed store would be the upgrade path if we ever scale
 * horizontally.
 */
const ADMIN_MAX_FAILURES = 5;
const ADMIN_LOCKOUT_MS = 60_000;
interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}
const adminAttempts = new Map<string, AttemptRecord>();

function clientKey(c: Context): string {
  const fwd = c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip") || "";
  return fwd.split(",")[0]?.trim() || "unknown";
}

function isLocked(key: string): number {
  const rec = adminAttempts.get(key);
  if (!rec) return 0;
  const remaining = rec.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(key: string): void {
  const rec = adminAttempts.get(key) || { failures: 0, lockedUntil: 0 };
  rec.failures += 1;
  if (rec.failures >= ADMIN_MAX_FAILURES) {
    rec.lockedUntil = Date.now() + ADMIN_LOCKOUT_MS;
    console.warn(
      `[admin-auth] rate-limiting client ${key} for ${ADMIN_LOCKOUT_MS}ms after ${rec.failures} consecutive failures`,
    );
  }
  adminAttempts.set(key, rec);
}

function clearFailures(key: string): void {
  adminAttempts.delete(key);
}

/** Testing helpers — exported for unit tests; not for general use. */
export const __adminAuthInternals = {
  reset: () => adminAttempts.clear(),
  get: (key: string) => adminAttempts.get(key),
  MAX_FAILURES: ADMIN_MAX_FAILURES,
};

/**
 * Admin middleware for dashboard routes.
 * - self_hosted: checks X-Admin-Key header with constant-time compare +
 *   per-IP rate limit on repeated failures.
 * - multi_tenant: checks session cookie, attaches user to request.
 */
export function createAdminMiddleware(db?: Db) {
  return async (c: Context, next: Next) => {
    if (getMode() === "multi_tenant" && db) {
      const sessionId = getSessionFromCookie(c);
      if (!sessionId) {
        return c.json(
          { error: { message: "Authentication required. Please sign in.", type: "auth_error" } },
          401
        );
      }
      const result = await validateSession(db, sessionId);
      if (!result) {
        return c.json(
          { error: { message: "Session expired. Please sign in again.", type: "auth_error" } },
          401
        );
      }
      userMap.set(c.req.raw, {
        id: result.user.id,
        tenantId: result.user.tenantId,
        role: result.user.role,
      });
      return next();
    }

    // self_hosted mode: X-Admin-Key with timing-safe compare + rate limit
    const secret = process.env.PROVARA_ADMIN_SECRET;
    if (!secret) {
      return next();
    }

    const cKey = clientKey(c);
    const lockRemainingMs = isLocked(cKey);
    if (lockRemainingMs > 0) {
      c.header("Retry-After", String(Math.ceil(lockRemainingMs / 1000)));
      return c.json(
        {
          error: {
            message: "Too many failed auth attempts. Try again later.",
            type: "rate_limited",
          },
        },
        429
      );
    }

    const provided = c.req.header("X-Admin-Key");
    if (!provided || !safeStringEqual(provided, secret)) {
      recordFailure(cKey);
      return c.json(
        { error: { message: "Unauthorized. Invalid or missing admin key.", type: "auth_error" } },
        401
      );
    }

    clearFailures(cKey);
    return next();
  };
}

/**
 * Role middleware — restricts access to users with the required role.
 * Must run after createAdminMiddleware (which attaches the user).
 * In self_hosted mode, this is a no-op.
 */
export function requireRole(role: "owner" | "member") {
  return async (c: Context, next: Next) => {
    if (getMode() !== "multi_tenant") {
      return next();
    }

    const user = getAuthUser(c.req.raw);
    if (!user) {
      return c.json(
        { error: { message: "Authentication required.", type: "auth_error" } },
        401
      );
    }

    // Owner has access to everything
    if (user.role === "owner") {
      return next();
    }

    // Member can only access member-level routes
    if (role === "member") {
      return next();
    }

    return c.json(
      { error: { message: "Insufficient permissions. Owner access required.", type: "auth_error" } },
      403
    );
  };
}
