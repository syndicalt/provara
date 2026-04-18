import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Db } from "@provara/db";
import { auditLogs, users } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import { emitAudit, emitAuditSync } from "../src/audit/emit.js";
import {
  AUDIT_AUTH_LOGIN_SUCCESS,
  AUDIT_API_KEY_CREATED,
  AUDIT_BILLING_SUBSCRIPTION_UPDATED,
} from "../src/audit/actions.js";

describe("emitAudit / emitAuditSync (#210/T2)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("writes a row with the supplied actor email (no DB roundtrip needed)", async () => {
    await emitAuditSync(db, {
      tenantId: "t-1",
      actorUserId: "u-1",
      actorEmail: "owner@example.com",
      action: AUDIT_AUTH_LOGIN_SUCCESS,
      metadata: { method: "magic_link", ip: "10.0.0.1" },
    });
    const rows = await db.select().from(auditLogs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("t-1");
    expect(rows[0].actorEmail).toBe("owner@example.com");
    expect(rows[0].action).toBe(AUDIT_AUTH_LOGIN_SUCCESS);
    expect(rows[0].metadata).toEqual({ method: "magic_link", ip: "10.0.0.1" });
  });

  it("falls back to users table when actorEmail is omitted", async () => {
    await db.insert(users).values({
      id: "u-fallback",
      email: "fallback@example.com",
      tenantId: "t-1",
      role: "owner",
      createdAt: new Date(),
    }).run();

    await emitAuditSync(db, {
      tenantId: "t-1",
      actorUserId: "u-fallback",
      action: AUDIT_API_KEY_CREATED,
      resourceType: "api_key",
      resourceId: "ak_abc",
    });
    const row = await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_API_KEY_CREATED)).get();
    expect(row?.actorEmail).toBe("fallback@example.com");
  });

  it("allows system-emitted events (actorUserId=null)", async () => {
    await emitAuditSync(db, {
      tenantId: "t-1",
      actorUserId: null,
      actorEmail: null,
      action: AUDIT_BILLING_SUBSCRIPTION_UPDATED,
      resourceType: "subscription",
      resourceId: "sub_xyz",
      metadata: { from: "active", to: "past_due" },
    });
    const row = await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_BILLING_SUBSCRIPTION_UPDATED)).get();
    expect(row?.actorUserId).toBeNull();
    expect(row?.actorEmail).toBeNull();
    expect(row?.resourceType).toBe("subscription");
  });

  it("fire-and-forget emitAudit writes asynchronously and does not throw", async () => {
    // Synchronous call returns void; the write lands on the next tick.
    emitAudit(db, {
      tenantId: "t-1",
      actorUserId: null,
      action: AUDIT_AUTH_LOGIN_SUCCESS,
    });
    // Flush microtasks — the internal write is awaited inside the
    // IIFE, so waiting one tick is sufficient.
    await new Promise((r) => setTimeout(r, 20));
    const rows = await db.select().from(auditLogs).all();
    expect(rows).toHaveLength(1);
  });

  it("swallows DB errors and logs instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Pass a db-like object whose insert().values().run() throws.
    const exploding = {
      insert: () => ({
        values: () => ({
          run: () => {
            throw new Error("boom");
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ get: async () => null }),
        }),
      }),
    } as unknown as Db;
    expect(() =>
      emitAudit(exploding, {
        tenantId: "t-1",
        actorUserId: null,
        action: AUDIT_AUTH_LOGIN_SUCCESS,
      }),
    ).not.toThrow();
    // Give the background microtask a chance to execute.
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("[audit] write failed");
    warn.mockRestore();
  });

  it("persists the JSON metadata blob round-trip", async () => {
    const complex = {
      ip: "192.168.1.1",
      userAgent: "Mozilla/5.0 (X11)",
      before: { tier: "pro", seats: 3 },
      after: { tier: "team", seats: 10 },
    };
    await emitAuditSync(db, {
      tenantId: "t-1",
      actorUserId: null,
      action: AUDIT_BILLING_SUBSCRIPTION_UPDATED,
      metadata: complex,
    });
    const row = await db.select().from(auditLogs).get();
    expect(row?.metadata).toEqual(complex);
  });
});
