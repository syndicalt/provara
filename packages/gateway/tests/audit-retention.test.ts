import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@provara/db";
import { auditLogs, subscriptions } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import { runAuditRetentionCycle } from "../src/scheduler/audit-retention.js";
import { AUDIT_API_KEY_CREATED } from "../src/audit/actions.js";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function seedSub(db: Db, tenantId: string, tier: "free" | "pro" | "team" | "enterprise") {
  const now = new Date();
  await db.insert(subscriptions).values({
    stripeSubscriptionId: `sub_${tenantId}`,
    tenantId,
    stripeCustomerId: `cus_${tenantId}`,
    stripePriceId: "price",
    stripeProductId: "prod",
    tier,
    includesIntelligence: true,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
  }).run();
}

async function seedAudit(db: Db, tenantId: string, createdAt: Date, idSuffix: string) {
  await db.insert(auditLogs).values({
    id: `a-${tenantId}-${idSuffix}`,
    tenantId,
    action: AUDIT_API_KEY_CREATED,
    createdAt,
  }).run();
}

describe("runAuditRetentionCycle (#210/T5)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("deletes rows older than the tier window — Pro keeps 90 days", async () => {
    await seedSub(db, "t-pro", "pro");
    await seedAudit(db, "t-pro", daysAgo(120), "old"); // outside
    await seedAudit(db, "t-pro", daysAgo(80), "kept-1"); // inside
    await seedAudit(db, "t-pro", daysAgo(30), "kept-2"); // inside

    const stats = await runAuditRetentionCycle(db);
    expect(stats.rowsDeleted).toBe(1);
    expect(stats.tenantsDeleted).toBe(1);

    const remaining = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-pro")).all();
    expect(remaining.map((r) => r.id).sort()).toEqual(["a-t-pro-kept-1", "a-t-pro-kept-2"].sort());
  });

  it("Team window is 365 days", async () => {
    await seedSub(db, "t-team", "team");
    await seedAudit(db, "t-team", daysAgo(400), "old");   // outside
    await seedAudit(db, "t-team", daysAgo(300), "kept"); // inside

    await runAuditRetentionCycle(db);

    const remaining = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-team")).all();
    expect(remaining.map((r) => r.id)).toEqual(["a-t-team-kept"]);
  });

  it("Enterprise window is 730 days", async () => {
    await seedSub(db, "t-ent", "enterprise");
    await seedAudit(db, "t-ent", daysAgo(800), "old");
    await seedAudit(db, "t-ent", daysAgo(500), "kept");

    await runAuditRetentionCycle(db);

    const remaining = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-ent")).all();
    expect(remaining.map((r) => r.id)).toEqual(["a-t-ent-kept"]);
  });

  it("tenants without a subscription fall back to Free-tier window (90 days)", async () => {
    // No sub row at all
    await seedAudit(db, "t-ghost", daysAgo(120), "old");
    await seedAudit(db, "t-ghost", daysAgo(30), "kept");

    await runAuditRetentionCycle(db);

    const remaining = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-ghost")).all();
    expect(remaining.map((r) => r.id)).toEqual(["a-t-ghost-kept"]);
  });

  it("does not touch rows from tenants whose all audit is still in-window", async () => {
    await seedSub(db, "t-pro", "pro");
    await seedAudit(db, "t-pro", daysAgo(10), "fresh-1");
    await seedAudit(db, "t-pro", daysAgo(5), "fresh-2");

    const stats = await runAuditRetentionCycle(db);
    expect(stats.rowsDeleted).toBe(0);
    expect(stats.tenantsDeleted).toBe(0);
    expect(stats.tenantsScanned).toBe(1);
  });

  it("chunks DELETEs — handles batches larger than batchSize", async () => {
    await seedSub(db, "t-pro", "pro");
    // 12 rows, all outside the 90d window
    for (let i = 0; i < 12; i++) {
      await seedAudit(db, "t-pro", daysAgo(100 + i), `old-${i}`);
    }
    const stats = await runAuditRetentionCycle(db, { batchSize: 5 });
    expect(stats.rowsDeleted).toBe(12);
    const remaining = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-pro")).all();
    expect(remaining).toHaveLength(0);
  });

  it("processes multiple tenants independently", async () => {
    await seedSub(db, "t-pro", "pro");
    await seedSub(db, "t-team", "team");
    // Pro's threshold = 90d; Team's = 365d. A row at 200d is outside
    // Pro but inside Team.
    await seedAudit(db, "t-pro", daysAgo(200), "pro-old");
    await seedAudit(db, "t-team", daysAgo(200), "team-ok");

    const stats = await runAuditRetentionCycle(db);
    expect(stats.rowsDeleted).toBe(1);

    const proLeft = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-pro")).all();
    const teamLeft = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, "t-team")).all();
    expect(proLeft).toHaveLength(0);
    expect(teamLeft).toHaveLength(1);
  });
});
