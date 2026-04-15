import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { getMode } from "../config.js";
import { getSessionFromCookie, validateSession } from "./session.js";

// Store authenticated user on request for downstream use
const userMap = new WeakMap<Request, { id: string; tenantId: string; role: string }>();

export function getAuthUser(req: Request) {
  return userMap.get(req) || null;
}

/**
 * Admin middleware for dashboard routes.
 * - self_hosted: checks X-Admin-Key header
 * - multi_tenant: checks session cookie, attaches user to request
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

    // self_hosted mode: existing X-Admin-Key logic
    const secret = process.env.PROVARA_ADMIN_SECRET;
    if (!secret) {
      return next();
    }

    const provided = c.req.header("X-Admin-Key");
    if (provided !== secret) {
      return c.json(
        { error: { message: "Unauthorized. Invalid or missing admin key.", type: "auth_error" } },
        401
      );
    }

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
