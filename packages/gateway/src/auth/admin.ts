import type { Context, Next } from "hono";

export function createAdminMiddleware() {
  return async (c: Context, next: Next) => {
    const secret = process.env.PROVARA_ADMIN_SECRET;

    // No secret configured — open mode (backward-compatible)
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
