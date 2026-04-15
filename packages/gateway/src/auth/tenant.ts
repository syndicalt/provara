import type { Context, Next } from "hono";
import { getMode } from "../config.js";

// Store tenant ID on the request via a WeakMap
const tenantMap = new WeakMap<Request, string>();

export function getTenantId(req: Request): string | null {
  return tenantMap.get(req) || null;
}

/**
 * Tenant middleware for multi_tenant mode.
 * In self_hosted mode, this is a no-op.
 * In multi_tenant mode, extracts tenant from the authenticated session
 * and attaches it to the request for downstream query scoping.
 */
export function createTenantMiddleware() {
  return async (c: Context, next: Next) => {
    if (getMode() !== "multi_tenant") {
      return next();
    }

    // TODO: In Phase 2 (T6), extract tenant from OAuth session.
    // For now, accept tenant from X-Tenant-Id header (for testing).
    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) {
      return c.json(
        { error: { message: "Missing tenant context. Authentication required in multi-tenant mode.", type: "auth_error" } },
        401
      );
    }

    tenantMap.set(c.req.raw, tenantId);
    return next();
  };
}
