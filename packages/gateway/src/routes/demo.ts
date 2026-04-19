import { Hono } from "hono";
import type { Db } from "@provara/db";
import { users } from "@provara/db";
import { eq } from "drizzle-orm";
import { createSession, setSessionCookie } from "../auth/session.js";
import { DEMO_TENANT_ID } from "../demo/seed.js";

/**
 * Public read-only demo (#229). Anonymous visitor hits `/demo`, gets a
 * short-lived session bound to the pre-seeded `u_demo_visitor` /
 * `t_demo` pair, and lands on the dashboard. All writes on the session
 * are refused by `createReadOnlyMiddleware`; the nightly
 * `demo-reseed` scheduler job keeps the data fresh.
 *
 * Errors: 503 if the demo tenant hasn't been seeded yet (first deploy
 * before the job fires, or someone manually wiped it). The UI should
 * surface this as "demo is temporarily unavailable, try again soon."
 */

export function createDemoRoutes(db: Db) {
  const app = new Hono();

  app.get("/", async (c) => {
    const visitor = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, "u_demo_visitor"))
      .get();
    if (!visitor) {
      return c.json(
        {
          error: {
            message:
              "Demo tenant has not been seeded yet. Try again in a moment or contact support.",
            type: "demo_unavailable",
          },
        },
        503,
      );
    }

    const sessionId = await createSession(db, visitor.id, { readOnly: true });
    setSessionCookie(c, sessionId, { readOnly: true });

    const dashboardUrl = process.env.DASHBOARD_URL || "http://localhost:3000";
    return c.redirect(`${dashboardUrl}/dashboard?demo=1`);
  });

  return app;
}
