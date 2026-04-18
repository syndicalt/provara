import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { SQL, sql, eq } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { getMode } from "../config.js";
import { getSessionFromCookie, validateSession } from "./session.js";
import { getTokenInfo } from "./middleware.js";

// Store tenant ID on the request via a WeakMap
const tenantMap = new WeakMap<Request, string>();

export function getTenantId(req: Request): string | null {
  return tenantMap.get(req) || null;
}

/** Testing-only helper — sets the tenant on a Request for unit tests that
 *  don't want to wire up the full session/bearer auth chain. Never call
 *  from production code. */
export function __testSetTenant(req: Request, tenantId: string): void {
  tenantMap.set(req, tenantId);
}

/**
 * Fail-safe tenant filter for database queries (#178). Replaces the
 * previous `tenantId ? eq(col, tenantId) : undefined` pattern which
 * was unsafe in multi-tenant mode — `undefined` where clause = "return
 * everything" which is a cross-tenant leak waiting to happen.
 *
 * Behavior:
 *   - tenantId is set        → `eq(col, tenantId)` (filter to that tenant)
 *   - tenantId null/undefined in multi-tenant mode → `sql\`0 = 1\`` (zero rows,
 *                              never leak cross-tenant)
 *   - tenantId null/undefined in self_hosted mode  → undefined (no filter,
 *                              legacy single-tenant behavior)
 *
 * Why the mode split: self_hosted has no tenant concept and existing data
 * may have `tenantId = NULL` that we still want to return. Multi-tenant
 * requires a tenant — the tenant middleware already enforces this at the
 * HTTP layer, but queries should be safe if the middleware is ever bypassed.
 */
export function tenantFilter(
  column: Column,
  tenantId: string | null | undefined,
): SQL | undefined {
  if (tenantId) return eq(column, tenantId);
  if (getMode() === "multi_tenant") {
    return sql`0 = 1`;
  }
  return undefined;
}

/**
 * Variant that combines the tenant check with an additional scope — e.g.
 * "this row AND owned by this tenant". Same mode-aware semantics as
 * `tenantFilter`. Useful for `WHERE id = ? AND tenant_id = ?` patterns.
 */
export function tenantScoped(
  column: Column,
  tenantId: string | null | undefined,
  additional: SQL,
): SQL | undefined {
  if (tenantId) {
    const filter = eq(column, tenantId);
    return sql`${additional} AND ${filter}`;
  }
  if (getMode() === "multi_tenant") {
    return sql`0 = 1`;
  }
  return additional;
}

/**
 * Tenant middleware for multi_tenant mode.
 * In self_hosted mode, this is a no-op.
 * In multi_tenant mode, extracts tenant from session cookie or API token.
 */
export function createTenantMiddleware(db: Db) {
  return async (c: Context, next: Next) => {
    if (getMode() !== "multi_tenant") {
      return next();
    }

    // Public routes that don't require tenant context
    if (c.req.path.startsWith("/v1/models")) {
      return next();
    }

    // Try session cookie first (dashboard users)
    const sessionId = getSessionFromCookie(c);
    if (sessionId) {
      const result = await validateSession(db, sessionId);
      if (result) {
        tenantMap.set(c.req.raw, result.user.tenantId);
        return next();
      }
    }

    // Fall back to API token tenant (programmatic access)
    const tokenInfo = getTokenInfo(c.req.raw);
    if (tokenInfo?.tenant) {
      tenantMap.set(c.req.raw, tokenInfo.tenant);
      return next();
    }

    return c.json(
      { error: { message: "Missing tenant context. Authentication required in multi-tenant mode.", type: "auth_error" } },
      401
    );
  };
}
