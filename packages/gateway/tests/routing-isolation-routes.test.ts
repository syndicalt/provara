import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { adaptiveIsolationPreferencesLog } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import { createRoutingIsolationRoutes } from "../src/routes/routing-isolation.js";
import { __testSetTenant } from "../src/auth/tenant.js";

/**
 * C4 (#197) — API surface for adaptive isolation toggles.
 *
 * Tests mount the routes into a bare Hono app and simulate the tenant
 * middleware by calling the `__testSetTenant` helper. The admin auth +
 * role middleware are skipped here — they're covered by existing
 * admin-auth tests; this file focuses on tier-gating and write semantics.
 */

function appFor(db: Parameters<typeof createRoutingIsolationRoutes>[0], tenantId?: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (tenantId) {
      __testSetTenant(c.req.raw, tenantId);
    }
    await next();
  });
  app.route("/", createRoutingIsolationRoutes(db));
  return app;
}

describe("routing-isolation API — C4", () => {
  afterEach(() => resetTierEnv());

  describe("GET /", () => {
    it("returns 401 when no tenantId is present", async () => {
      const db = await makeTestDb();
      const app = appFor(db);
      const res = await app.request("/");
      expect(res.status).toBe(401);
    });

    it("returns Free policy for an unsubscribed tenant", async () => {
      const db = await makeTestDb();
      process.env.PROVARA_CLOUD = "true";
      const app = appFor(db, "t-free");
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe("free");
      expect(body.canToggle).toBe(false);
      expect(body.preferences).toEqual({ consumesPool: false, contributesPool: false });
    });

    it("returns Pro policy with canToggle=false", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-pro", { tier: "pro" });
      const app = appFor(db, "t-pro");
      const res = await app.request("/");
      const body = await res.json();
      expect(body.tier).toBe("pro");
      expect(body.canToggle).toBe(false);
    });

    it("returns Team policy with canToggle=true and default toggles off", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      const app = appFor(db, "t-team");
      const res = await app.request("/");
      const body = await res.json();
      expect(body.tier).toBe("team");
      expect(body.canToggle).toBe(true);
      expect(body.preferences).toEqual({ consumesPool: false, contributesPool: false });
      expect(body.policy.readsPool).toBe(false);
      expect(body.policy.writesPool).toBe(false);
    });
  });

  describe("PATCH /", () => {
    it("returns 403 for a Pro tenant attempting to toggle", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-pro", { tier: "pro" });
      const app = appFor(db, "t-pro");
      const res = await app.request("/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumesPool: true }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.type).toBe("insufficient_tier");
    });

    it("flips consumesPool for a Team tenant and logs the change", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      const app = appFor(db, "t-team");
      const res = await app.request("/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumesPool: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.preferences.consumesPool).toBe(true);
      expect(body.preferences.contributesPool).toBe(false);

      const logs = await db
        .select()
        .from(adaptiveIsolationPreferencesLog)
        .where(eq(adaptiveIsolationPreferencesLog.tenantId, "t-team"))
        .all();
      expect(logs).toHaveLength(1);
      expect(logs[0].field).toBe("consumes_pool");
      // Without admin middleware attaching a user, changedBy falls back.
      expect(logs[0].changedBy).toBe("unknown");
    });

    it("rejects empty body with 400", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      const app = appFor(db, "t-team");
      const res = await app.request("/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("ignores non-boolean values silently (no write if nothing valid)", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      const app = appFor(db, "t-team");
      const res = await app.request("/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumesPool: "yes" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
