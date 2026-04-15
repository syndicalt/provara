import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { getMode } from "../config.js";
import { getSessionFromCookie, validateSession } from "./session.js";
import { getTokenInfo } from "./middleware.js";

// Store tenant ID on the request via a WeakMap
const tenantMap = new WeakMap<Request, string>();

export function getTenantId(req: Request): string | null {
  return tenantMap.get(req) || null;
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
