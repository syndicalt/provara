import type { Context, Next } from "hono";
import type { Db } from "@provara/db";
import { getMode } from "../config.js";
import { getSessionFromCookie, validateSession } from "./session.js";

export function createAdminMiddleware(db?: Db) {
  return async (c: Context, next: Next) => {
    // In multi_tenant mode, use session auth
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
