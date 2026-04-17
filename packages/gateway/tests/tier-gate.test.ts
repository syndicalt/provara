import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { subscriptions } from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";

// Mock the tenant module so our unit test can control tenant resolution
// via a test header rather than wiring up full session/bearer auth.
vi.mock("../src/auth/tenant.js", () => ({
  getTenantId: (req: Request) => req.headers.get("x-test-tenant"),
}));

// Import AFTER the mock so the middleware picks up the mocked getTenantId.
import { requireIntelligenceTier, tenantHasIntelligenceAccess } from "../src/auth/tier.js";

function buildApp(db: Db) {
  const app = new Hono();
  app.use("*", requireIntelligenceTier(db));
  app.get("/gated", (c) => c.json({ ok: true }));
  return app;
}

describe("requireIntelligenceTier", () => {
  let db: Db;

  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });

  afterEach(() => {
    resetTierEnv();
  });

  it("returns 402 when PROVARA_CLOUD is unset (self-host)", async () => {
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-1" } });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.gate.reason).toBe("not_cloud");
  });

  it("returns 402 when PROVARA_CLOUD is true but tenant has no subscription", async () => {
    process.env.PROVARA_CLOUD = "true";
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-1" } });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.gate.reason).toBe("no_subscription");
    expect(body.gate.currentTier).toBe("free");
  });

  it("returns 402 when subscription exists but tier lacks Intelligence", async () => {
    process.env.PROVARA_CLOUD = "true";
    const now = new Date();
    await db.insert(subscriptions).values({
      stripeSubscriptionId: "sub_free",
      tenantId: "tenant-free",
      stripeCustomerId: "cus_1",
      stripePriceId: "price_free",
      stripeProductId: "prod_free",
      tier: "free",
      includesIntelligence: false,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 86400000),
      cancelAtPeriodEnd: false,
      createdAt: now,
      updatedAt: now,
    }).run();

    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-free" } });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.gate.reason).toBe("insufficient_tier");
    expect(body.gate.currentTier).toBe("free");
  });

  it("returns 402 when subscription is canceled", async () => {
    await grantIntelligenceAccess(db, "tenant-1", { status: "active" });
    // Then flip to canceled
    await db.update(subscriptions).set({ status: "canceled" }).run();

    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-1" } });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.gate.reason).toBe("inactive_status");
    expect(body.gate.status).toBe("canceled");
  });

  it("allows access for active Pro subscription", async () => {
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro", status: "active" });
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-pro" } });
    expect(res.status).toBe(200);
  });

  it("allows access for trialing subscription", async () => {
    await grantIntelligenceAccess(db, "tenant-trial", { tier: "pro", status: "trialing" });
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-trial" } });
    expect(res.status).toBe(200);
  });

  it("allows access during past_due (grace period)", async () => {
    await grantIntelligenceAccess(db, "tenant-grace", { tier: "pro", status: "past_due" });
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-grace" } });
    expect(res.status).toBe(200);
  });

  it("allows access for Team tier", async () => {
    await grantIntelligenceAccess(db, "tenant-team", { tier: "team" });
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-team" } });
    expect(res.status).toBe(200);
  });

  it("allows access for Enterprise tier", async () => {
    await grantIntelligenceAccess(db, "tenant-ent", { tier: "enterprise" });
    const app = buildApp(db);
    const res = await app.request("/gated", { headers: { "x-test-tenant": "tenant-ent" } });
    expect(res.status).toBe(200);
  });

  it("returns 401 when no tenant can be resolved", async () => {
    process.env.PROVARA_CLOUD = "true";
    const app = buildApp(db);
    const res = await app.request("/gated");
    expect(res.status).toBe(401);
  });
});

describe("tenantHasIntelligenceAccess", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("returns false when not a cloud deployment", async () => {
    await grantIntelligenceAccess(db, "tenant-1");
    resetTierEnv(); // override — remove PROVARA_CLOUD
    expect(await tenantHasIntelligenceAccess(db, "tenant-1")).toBe(false);
  });

  it("returns false for null tenant", async () => {
    process.env.PROVARA_CLOUD = "true";
    expect(await tenantHasIntelligenceAccess(db, null)).toBe(false);
  });

  it("returns false for tenant without subscription", async () => {
    process.env.PROVARA_CLOUD = "true";
    expect(await tenantHasIntelligenceAccess(db, "ghost-tenant")).toBe(false);
  });

  it("returns true for active Pro subscription in Cloud", async () => {
    await grantIntelligenceAccess(db, "tenant-1");
    expect(await tenantHasIntelligenceAccess(db, "tenant-1")).toBe(true);
  });

  it("returns false for canceled subscription", async () => {
    await grantIntelligenceAccess(db, "tenant-1");
    await db.update(subscriptions).set({ status: "canceled" }).run();
    expect(await tenantHasIntelligenceAccess(db, "tenant-1")).toBe(false);
  });
});
