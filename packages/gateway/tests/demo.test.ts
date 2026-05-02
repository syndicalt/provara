import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Db } from "@provara/db";
import { auditLogs, contextOptimizationEvents, contextQualityEvents, contextRetrievalEvents, costLogs, requests, sessions, subscriptions, users } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import { reseedDemoTenant, DEMO_TENANT_ID } from "../src/demo/seed.js";
import { createReadOnlyMiddleware } from "../src/middleware/read-only.js";
import { __testSetReadOnlySession, __testSetTenant } from "../src/auth/tenant.js";

describe("#229 — demo tenant seed", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("seeds the expected top-level objects idempotently", async () => {
    await reseedDemoTenant(db);
    await reseedDemoTenant(db);

    const uRows = await db.select().from(users).where(eq(users.tenantId, DEMO_TENANT_ID)).all();
    expect(uRows).toHaveLength(3);
    expect(uRows.some((u) => u.id === "u_demo_visitor")).toBe(true);

    const sub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, DEMO_TENANT_ID))
      .get();
    expect(sub?.tier).toBe("enterprise");
    expect(sub?.includesIntelligence).toBe(true);

    const reqs = await db
      .select()
      .from(requests)
      .where(eq(requests.tenantId, DEMO_TENANT_ID))
      .all();
    expect(reqs.length).toBe(240);

    const costs = await db
      .select()
      .from(costLogs)
      .where(eq(costLogs.tenantId, DEMO_TENANT_ID))
      .all();
    expect(costs.length).toBe(240);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, DEMO_TENANT_ID))
      .all();
    expect(audit.length).toBeGreaterThan(0);

    const contextEvents = await db
      .select()
      .from(contextOptimizationEvents)
      .where(eq(contextOptimizationEvents.tenantId, DEMO_TENANT_ID))
      .all();
    expect(contextEvents).toHaveLength(4);
    expect(contextEvents.reduce((sum, row) => sum + row.savedTokens, 0)).toBe(11800);
    expect(contextEvents.reduce((sum, row) => sum + row.nearDuplicateChunks, 0)).toBeGreaterThan(0);
    expect(contextEvents.reduce((sum, row) => sum + row.flaggedChunks, 0)).toBe(1);
    expect(contextEvents.reduce((sum, row) => sum + row.quarantinedChunks, 0)).toBe(1);
    expect(JSON.parse(contextEvents[0].duplicateSourceIds)).toEqual(expect.any(Array));
    expect(JSON.parse(contextEvents[0].nearDuplicateSourceIds)).toEqual(expect.any(Array));
    expect(JSON.parse(contextEvents[0].riskySourceIds)).toEqual(expect.any(Array));

    const qualityEvents = await db
      .select()
      .from(contextQualityEvents)
      .where(eq(contextQualityEvents.tenantId, DEMO_TENANT_ID))
      .all();
    expect(qualityEvents).toHaveLength(3);
    expect(qualityEvents.some((row) => row.regressed)).toBe(true);

    const retrievalEvents = await db
      .select()
      .from(contextRetrievalEvents)
      .where(eq(contextRetrievalEvents.tenantId, DEMO_TENANT_ID))
      .all();
    expect(retrievalEvents).toHaveLength(4);
    expect(retrievalEvents.reduce((sum, row) => sum + row.unusedChunks, 0)).toBeGreaterThan(0);
    expect(retrievalEvents.reduce((sum, row) => sum + row.nearDuplicateChunks, 0)).toBeGreaterThan(0);
    expect(JSON.parse(retrievalEvents[0].unusedSourceIds)).toEqual(expect.any(Array));
  });

  it("populates attribution fields on every seeded request", async () => {
    await reseedDemoTenant(db);
    const r = await db.select().from(requests).where(eq(requests.tenantId, DEMO_TENANT_ID)).all();
    for (const row of r) {
      expect(row.userId).toBeTruthy();
      expect(row.apiTokenId).toBeTruthy();
      expect(row.taskType).toBeTruthy();
      expect(row.complexity).toBeTruthy();
    }
  });

  it("clears prior demo rows before re-seeding (no duplicates)", async () => {
    await reseedDemoTenant(db);
    const first = await db.select().from(requests).where(eq(requests.tenantId, DEMO_TENANT_ID)).all();
    await reseedDemoTenant(db);
    const second = await db.select().from(requests).where(eq(requests.tenantId, DEMO_TENANT_ID)).all();
    expect(second.length).toBe(first.length);
  });
});

describe("#229 — read-only session middleware", () => {
  it("passes GETs through regardless of read-only flag", async () => {
    const app = new Hono();
    app.use("/v1/x", async (c, next) => {
      __testSetReadOnlySession(c.req.raw, true);
      __testSetTenant(c.req.raw, "t_demo");
      return next();
    });
    app.use("/v1/x", createReadOnlyMiddleware());
    app.get("/v1/x", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/x");
    expect(res.status).toBe(200);
  });

  it("blocks write verbs with 403 demo_read_only", async () => {
    const app = new Hono();
    app.use("/v1/x", async (c, next) => {
      __testSetReadOnlySession(c.req.raw, true);
      __testSetTenant(c.req.raw, "t_demo");
      return next();
    });
    app.use("/v1/x", createReadOnlyMiddleware());
    app.post("/v1/x", (c) => c.json({ ok: true }));
    app.put("/v1/x", (c) => c.json({ ok: true }));
    app.patch("/v1/x", (c) => c.json({ ok: true }));
    app.delete("/v1/x", (c) => c.json({ ok: true }));

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request("/v1/x", { method });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.type).toBe("demo_read_only");
    }
  });

  it("does NOT block write verbs on non-demo sessions", async () => {
    const app = new Hono();
    app.use("/v1/x", async (c, next) => {
      // No __testSetReadOnlySession — this is a normal session.
      __testSetTenant(c.req.raw, "t_normal");
      return next();
    });
    app.use("/v1/x", createReadOnlyMiddleware());
    app.post("/v1/x", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/x", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
