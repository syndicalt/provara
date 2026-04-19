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
 * Role names. Historical rows may still carry the legacy "member"
 * value until the #247 migration backfills them to "developer"; the
 * middleware normalizes "member" → "developer" at read-time so the
 * code after the migration can assume the 4-role set.
 */
export type Role = "owner" | "admin" | "developer" | "viewer";

function normalizeRole(raw: string): Role {
  if (raw === "member") return "developer";
  if (raw === "owner" || raw === "admin" || raw === "developer" || raw === "viewer") {
    return raw;
  }
  // Unknown role = most restricted. Defensive; should never happen once
  // the migration has run.
  return "viewer";
}

export function getAuthRole(req: Request): Role | null {
  const user = getAuthUser(req);
  return user ? normalizeRole(user.role) : null;
}

/**
 * Role middleware — restricts access to users with the required role.
 * Must run after createAdminMiddleware (which attaches the user).
 * In self_hosted mode, this is a no-op.
 *
 * Accepts either a single role or an array. Owner is always allowed.
 * Legacy single-role callers like `requireRole("owner")` remain valid.
 */
export function requireRole(role: Role | Role[]) {
  const allowed = new Set<Role>(Array.isArray(role) ? role : [role]);
  allowed.add("owner"); // owner is always allowed

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

    const normalized = normalizeRole(user.role);
    if (allowed.has(normalized)) {
      return next();
    }

    const requiredList = Array.from(allowed).join(", ");
    return c.json(
      {
        error: {
          message: `Insufficient permissions. Required role: ${requiredList}.`,
          type: "auth_error",
        },
      },
      403
    );
  };
}
