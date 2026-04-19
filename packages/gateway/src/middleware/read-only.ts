import type { Context, MiddlewareHandler, Next } from "hono";
import { isReadOnlySession } from "../auth/tenant.js";

/**
 * Read-only session enforcement (#229). Refuses write verbs for any
 * caller whose session has `read_only=true` — specifically the public
 * `/demo` flow that hands anonymous visitors a short-lived session on
 * the pre-seeded `t_demo` tenant.
 *
 * The middleware is mounted on `/v1/*` and on `/v1/chat/completions`
 * (since GET isn't used on that endpoint and even a POST to chat would
 * burn real LLM tokens on the operator's dime). Reads pass through
 * untouched so the full dashboard UX renders — tables, charts, CSV
 * downloads, audit logs viewer, everything.
 *
 * Block shape mirrors the budget hard-stop contract: 402-style `type`
 * that the UI can key off for a tailored message, paired with an
 * obvious sign-up CTA in the dashboard banner (#229/T4).
 */
const WRITE_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createReadOnlyMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isReadOnlySession(c.req.raw)) return next();
    if (!WRITE_VERBS.has(c.req.method)) return next();

    return c.json(
      {
        error: {
          message:
            "This is a read-only demo session. Sign up to create your own tenant and start writing.",
          type: "demo_read_only",
          signupUrl: "https://www.provara.xyz/login",
        },
      },
      403,
    );
  };
}
