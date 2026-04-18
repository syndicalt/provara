import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Db } from "@provara/db";
import { auditLogs, users } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv, seedOperatorUser } from "./_setup/tier.js";

vi.mock("../src/auth/admin.js", () => ({
  getAuthUser: (req: Request) => {
    const h = req.headers.get("x-test-user");
    if (!h) return null;
    const [id, tenantId, role] = h.split(":");
    return { id, tenantId, role: role as "owner" | "member" };
  },
}));

import { createAuditRoutes } from "../src/routes/audit.js";
import { emitAuditSync } from "../src/audit/emit.js";
import { AUDIT_API_KEY_CREATED, AUDIT_AUTH_LOGIN_SUCCESS, AUDIT_USER_REMOVED } from "../src/audit/actions.js";

function buildApp(db: Db) {
  const app = new Hono();
  app.route("/v1/audit-logs", createAuditRoutes(db));
  return app;
}
function authHeader(u: { id: string; tenantId: string; role: "owner" | "member" }) {
  return `${u.id}:${u.tenantId}:${u.role}`;
}

async function seedOwner(db: Db, tenantId: string, tier?: "pro" | "team" | "enterprise") {
  await db.insert(users).values({
    id: `owner-${tenantId}`,
    email: `owner@${tenantId}.example.com`,
    tenantId,
    role: "owner",
    createdAt: new Date(),
  }).run();
  if (tier) await grantIntelligenceAccess(db, tenantId, { tier });
  return { id: `owner-${tenantId}`, tenantId, role: "owner" as const };
}

describe("GET /v1/audit-logs (#210/T4)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("returns 401 without auth", async () => {
    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs");
    expect(res.status).toBe(401);
  });

  it("returns 402 for a Pro tenant (insufficient tier)", async () => {
    const owner = await seedOwner(db, "t-pro", "pro");
    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.type).toBe("insufficient_tier");
  });

  it("returns 402 for a Free tenant (no subscription row)", async () => {
    const owner = await seedOwner(db, "t-free");
    process.env.PROVARA_CLOUD = "true";
    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(402);
  });

  it("returns events for a Team tenant", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await emitAuditSync(db, {
      tenantId: "t-team",
      actorUserId: owner.id,
      actorEmail: "owner@t-team.example.com",
      action: AUDIT_AUTH_LOGIN_SUCCESS,
      metadata: { method: "magic_link" },
    });

    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe(AUDIT_AUTH_LOGIN_SUCCESS);
    expect(body.events[0].metadata).toEqual({ method: "magic_link" });
    expect(body.nextCursor).toBeNull();
  });

  it("returns events for Enterprise tenants", async () => {
    const owner = await seedOwner(db, "t-ent", "enterprise");
    await emitAuditSync(db, { tenantId: "t-ent", actorUserId: null, action: AUDIT_API_KEY_CREATED });
    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(200);
  });

  it("bypasses the tier gate for operator tenants", async () => {
    await seedOperatorUser(db, "t-op", "ops@corelumen.com");
    await emitAuditSync(db, { tenantId: "t-op", actorUserId: null, action: AUDIT_API_KEY_CREATED });
    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs", {
      headers: { "x-test-user": authHeader({ id: "op-user", tenantId: "t-op", role: "owner" }) },
    });
    expect(res.status).toBe(200);
  });

  it("isolates tenants — never returns rows from a different tenant", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await emitAuditSync(db, { tenantId: "t-team", actorUserId: null, action: AUDIT_API_KEY_CREATED });
    await emitAuditSync(db, { tenantId: "t-other", actorUserId: null, action: AUDIT_API_KEY_CREATED });

    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });

  it("filters by action", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await emitAuditSync(db, { tenantId: "t-team", actorUserId: null, action: AUDIT_API_KEY_CREATED });
    await emitAuditSync(db, { tenantId: "t-team", actorUserId: null, action: AUDIT_USER_REMOVED });

    const app = buildApp(db);
    const res = await app.request(`/v1/audit-logs?action=${AUDIT_USER_REMOVED}`, {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe(AUDIT_USER_REMOVED);
  });

  it("filters by actor substring, case-insensitively", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await emitAuditSync(db, { tenantId: "t-team", actorUserId: null, actorEmail: "Alice@ACME.com", action: AUDIT_API_KEY_CREATED });
    await emitAuditSync(db, { tenantId: "t-team", actorUserId: null, actorEmail: "bob@other.com", action: AUDIT_API_KEY_CREATED });

    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs?actor=acme", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].actorEmail).toBe("Alice@ACME.com");
  });

  it("paginates via cursor (DESC createdAt)", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    for (let i = 0; i < 5; i++) {
      // Separate the rows by real ms so the DESC order is deterministic.
      await emitAuditSync(db, { tenantId: "t-team", actorUserId: null, action: AUDIT_API_KEY_CREATED });
      await new Promise((r) => setTimeout(r, 2));
    }

    const app = buildApp(db);
    const first = await app.request("/v1/audit-logs?limit=2", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const firstBody = await first.json();
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/audit-logs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      { headers: { "x-test-user": authHeader(owner) } },
    );
    const secondBody = await second.json();
    expect(secondBody.events).toHaveLength(2);
    // No overlap between pages.
    const firstIds = new Set(firstBody.events.map((e: { id: string }) => e.id));
    for (const e of secondBody.events) expect(firstIds.has(e.id)).toBe(false);
  });

  it("exports as CSV when format=csv", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await emitAuditSync(db, {
      tenantId: "t-team",
      actorUserId: null,
      actorEmail: "alice@example.com",
      action: AUDIT_API_KEY_CREATED,
      metadata: { key_id: "ak_abc" },
    });

    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs?format=csv", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("audit-t-team");
    const csv = await res.text();
    expect(csv.split("\n")[0]).toContain("action,actor_user_id,actor_email");
    expect(csv).toContain("alice@example.com");
    expect(csv).toContain(AUDIT_API_KEY_CREATED);
  });

  it("CSV-escapes values containing commas and quotes", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await emitAuditSync(db, {
      tenantId: "t-team",
      actorUserId: null,
      actorEmail: 'alice "ali" <alice@x.com>',
      action: AUDIT_API_KEY_CREATED,
      metadata: { note: "hello, world" },
    });

    const app = buildApp(db);
    const res = await app.request("/v1/audit-logs?format=csv", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const csv = await res.text();
    // Actor email contains quotes → must be quoted with inner quotes doubled.
    expect(csv).toContain('"alice ""ali"" <alice@x.com>"');
    // Metadata JSON contains a comma → whole JSON cell is quoted.
    expect(csv).toContain('"{""note"":""hello, world""}"');
  });

  it("filters by since/until range", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    // Insert rows with specific timestamps
    const t1 = new Date(Date.UTC(2026, 3, 1));
    const t2 = new Date(Date.UTC(2026, 3, 10));
    const t3 = new Date(Date.UTC(2026, 3, 20));
    for (const ts of [t1, t2, t3]) {
      await db.insert(auditLogs).values({
        id: `row-${ts.getTime()}`,
        tenantId: "t-team",
        action: AUDIT_API_KEY_CREATED,
        createdAt: ts,
      }).run();
    }

    const app = buildApp(db);
    const res = await app.request(
      `/v1/audit-logs?since=${t1.toISOString()}&until=${t2.toISOString()}`,
      { headers: { "x-test-user": authHeader(owner) } },
    );
    const body = await res.json();
    // since <= x <= until ⇒ two rows (t1, t2) qualify.
    expect(body.events.map((e: { id: string }) => e.id).sort()).toEqual([`row-${t1.getTime()}`, `row-${t2.getTime()}`].sort());
  });
});
