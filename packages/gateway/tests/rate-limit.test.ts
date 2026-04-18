import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Db } from "@provara/db";
import { auditLogs } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import {
  checkWindowLimit,
  createRateLimitMiddleware,
  __resetRateLimitStateForTests,
} from "../src/middleware/rate-limit.js";
import { __testSetTenant } from "../src/auth/tenant.js";

describe("#192 — rate-limit primitive", () => {
  beforeEach(() => __resetRateLimitStateForTests());

  it("allows up to `limit` requests in the window, then rejects", () => {
    const cfg = { limit: 3, windowMs: 60_000 };
    const now = 1_700_000_000_000;
    expect(checkWindowLimit("s", "k", cfg, now).allowed).toBe(true);
    expect(checkWindowLimit("s", "k", cfg, now).allowed).toBe(true);
    expect(checkWindowLimit("s", "k", cfg, now).allowed).toBe(true);
    const fourth = checkWindowLimit("s", "k", cfg, now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.resetMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    const cfg = { limit: 2, windowMs: 1000 };
    const t0 = 1_700_000_000_000;
    checkWindowLimit("s", "k", cfg, t0);
    checkWindowLimit("s", "k", cfg, t0);
    expect(checkWindowLimit("s", "k", cfg, t0).allowed).toBe(false);
    // Jump past the window.
    expect(checkWindowLimit("s", "k", cfg, t0 + 1001).allowed).toBe(true);
  });

  it("isolates buckets by scope and key", () => {
    const cfg = { limit: 1, windowMs: 60_000 };
    const now = 1_700_000_000_000;
    expect(checkWindowLimit("scope-a", "ip1", cfg, now).allowed).toBe(true);
    // Different scope, same key → separate bucket.
    expect(checkWindowLimit("scope-b", "ip1", cfg, now).allowed).toBe(true);
    // Different key, same scope → separate bucket.
    expect(checkWindowLimit("scope-a", "ip2", cfg, now).allowed).toBe(true);
  });
});

describe("#192 — rate-limit Hono middleware", () => {
  let db: Db;
  let app: Hono;

  beforeEach(async () => {
    __resetRateLimitStateForTests();
    db = await makeTestDb();
    app = new Hono();
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns 429 with Retry-After once the limit is hit", async () => {
    app.use(
      "/x",
      createRateLimitMiddleware({ scope: "test", limit: 2, windowMs: 60_000 }),
    );
    app.get("/x", (c) => c.text("ok"));

    const headers = { "x-forwarded-for": "9.9.9.9" };
    expect((await app.request("/x", { headers })).status).toBe(200);
    expect((await app.request("/x", { headers })).status).toBe(200);
    const res = await app.request("/x", { headers });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("isolates limits by client IP", async () => {
    app.use(
      "/x",
      createRateLimitMiddleware({ scope: "test", limit: 1, windowMs: 60_000 }),
    );
    app.get("/x", (c) => c.text("ok"));

    expect((await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(200);
    // Same-IP second hit → 429.
    expect((await app.request("/x", { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(429);
    // Different IP → fresh bucket, 200.
    expect((await app.request("/x", { headers: { "x-forwarded-for": "2.2.2.2" } })).status).toBe(200);
  });

  it("emits one audit event per (ip, tenant) burst and suppresses subsequent hits", async () => {
    // Tenant populated by tenant middleware normally; use the test setter here.
    app.use("/x", async (c, next) => {
      __testSetTenant(c.req.raw, "t-ent");
      return next();
    });
    app.use(
      "/x",
      createRateLimitMiddleware({
        scope: "chat",
        limit: 1,
        windowMs: 60_000,
        audit: { db },
      }),
    );
    app.get("/x", (c) => c.text("ok"));

    const headers = { "x-forwarded-for": "5.5.5.5" };
    expect((await app.request("/x", { headers })).status).toBe(200);
    expect((await app.request("/x", { headers })).status).toBe(429);
    expect((await app.request("/x", { headers })).status).toBe(429);

    // Give the fire-and-forget emitAudit write a tick to flush.
    await new Promise((r) => setTimeout(r, 25));

    const rows = await db.select().from(auditLogs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("rate_limit.exceeded");
    expect(rows[0].tenantId).toBe("t-ent");
    const metadata = rows[0].metadata as Record<string, unknown>;
    expect(metadata.scope).toBe("chat");
    expect(metadata.key).toBe("5.5.5.5");
  });

  it("does not emit audit events for unauthenticated rate-limit hits", async () => {
    // No tenant middleware attached → getTenantId returns null.
    app.use(
      "/x",
      createRateLimitMiddleware({
        scope: "auth",
        limit: 1,
        windowMs: 60_000,
        audit: { db },
      }),
    );
    app.get("/x", (c) => c.text("ok"));

    const headers = { "x-forwarded-for": "6.6.6.6" };
    await app.request("/x", { headers });
    expect((await app.request("/x", { headers })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 25));
    const rows = await db.select().from(auditLogs).all();
    expect(rows).toHaveLength(0);
  });
});
