import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requests, subscriptions, usageReports, users } from "@provara/db";
import type { Db } from "@provara/db";
import type Stripe from "stripe";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv, seedOperatorUser } from "./_setup/tier.js";
import {
  TIER_QUOTAS,
  calculateOverage,
  countRequestsInPeriod,
  isOperatorTenantForQuota,
  listRecentUsageReports,
  runUsageReportCycle,
} from "../src/billing/usage.js";

interface MeterPush {
  event_name: string;
  identifier: string;
  payload: { stripe_customer_id: string; value: string };
}

function mockStripe(pushes: MeterPush[]): Stripe {
  return {
    billing: {
      meterEvents: {
        create: async (params: MeterPush) => {
          pushes.push(params);
          return { id: nanoid(), object: "billing.meter_event" };
        },
      },
    },
  } as unknown as Stripe;
}

/**
 * Seeds `count` request rows for the tenant. Uses bulk-insert batches
 * so large seed counts (120k) take ~200ms instead of 60s. libSQL caps
 * multi-VALUES inserts at around 32K bound parameters; 500 rows × 6
 * columns = 3000 params per statement stays well under.
 */
async function seedRequests(db: Db, tenantId: string, count: number, createdAt = new Date()) {
  const BATCH = 500;
  const tsSeconds = Math.floor(createdAt.getTime() / 1000);
  for (let offset = 0; offset < count; offset += BATCH) {
    const batchSize = Math.min(BATCH, count - offset);
    const rows = [];
    for (let i = 0; i < batchSize; i++) {
      rows.push({
        id: nanoid(),
        provider: "openai",
        model: "gpt-4o",
        prompt: "x",
        tenantId,
        createdAt,
      });
    }
    await db.insert(requests).values(rows).run();
  }
  void tsSeconds;
}

describe("calculateOverage", () => {
  it("returns 0 when under quota", () => {
    expect(calculateOverage(50_000, "pro")).toBe(0);
  });

  it("returns 0 when exactly at quota", () => {
    expect(calculateOverage(100_000, "pro")).toBe(0);
  });

  it("returns the difference when over quota", () => {
    expect(calculateOverage(150_000, "pro")).toBe(50_000);
    expect(calculateOverage(1_000_000, "team")).toBe(500_000);
  });

  it("uses free tier quota when tier is unknown", () => {
    expect(calculateOverage(15_000, "nonsense")).toBe(5_000);
  });

  it("never over for enterprise / selfhost / operator", () => {
    expect(calculateOverage(1_000_000_000, "enterprise")).toBe(0);
    expect(calculateOverage(1_000_000_000, "operator")).toBe(0);
  });
});

describe("countRequestsInPeriod", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("counts only the given tenant's requests in the window", async () => {
    const periodStart = new Date(Date.UTC(2026, 3, 1));
    const inWindow = new Date(Date.UTC(2026, 3, 10));
    const beforeWindow = new Date(Date.UTC(2026, 2, 15));

    await seedRequests(db, "t-a", 5, inWindow);
    await seedRequests(db, "t-a", 3, beforeWindow);
    await seedRequests(db, "t-b", 100, inWindow);

    const count = await countRequestsInPeriod(db, "t-a", periodStart);
    expect(count).toBe(5);
  });
});

describe("runUsageReportCycle", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("pushes no meter events when no subscribers exist", async () => {
    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));
    expect(stats.subscriptionsEvaluated).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it("reports overage for a Pro subscriber that exceeded quota", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });

    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;

    // 120k requests in this period = 20k overage on Pro (quota 100k)
    await seedRequests(db, "t-1", 120_000, sub.currentPeriodStart);

    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));

    expect(stats.reportsWritten).toBe(1);
    expect(stats.deltaRequestsReported).toBe(20_000);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].event_name).toBe("provara_api_requests");
    expect(pushes[0].payload.value).toBe("20000");
    expect(pushes[0].payload.stripe_customer_id).toBe(sub.stripeCustomerId);

    // High-water mark written to usage_reports
    const rows = await db.select().from(usageReports).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].reportedOverageCount).toBe(20_000);
    expect(rows[0].lastEventIdentifier).toBe(pushes[0].identifier);
  });

  it("is idempotent — running twice with no new usage reports once, not twice", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;
    await seedRequests(db, "t-1", 120_000, sub.currentPeriodStart);

    const pushes: MeterPush[] = [];
    const stripe = mockStripe(pushes);

    await runUsageReportCycle(db, stripe);
    await runUsageReportCycle(db, stripe);

    expect(pushes).toHaveLength(1);
  });

  it("reports only the DELTA when usage grows between cycles", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;

    await seedRequests(db, "t-1", 120_000, sub.currentPeriodStart);
    const pushes: MeterPush[] = [];
    const stripe = mockStripe(pushes);
    await runUsageReportCycle(db, stripe); // pushes 20k

    // Add 30k more requests; cumulative 150k → cumulative overage 50k
    // → delta 30k
    await seedRequests(db, "t-1", 30_000, sub.currentPeriodStart);
    await runUsageReportCycle(db, stripe);

    expect(pushes).toHaveLength(2);
    expect(pushes[0].payload.value).toBe("20000");
    expect(pushes[1].payload.value).toBe("30000");

    const rows = await db.select().from(usageReports).all();
    expect(rows[0].reportedOverageCount).toBe(50_000);
  });

  it("skips subs still within quota", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;
    await seedRequests(db, "t-1", 50_000, sub.currentPeriodStart); // well under 100k

    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));

    expect(stats.reportsWritten).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it("skips Enterprise subs (custom-invoiced, not metered)", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "enterprise" });
    // Enterprise is skipped by tier before we even count usage — no seed needed.

    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));
    expect(stats.subscriptionsEvaluated).toBe(1);
    expect(stats.reportsWritten).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it("skips canceled subscriptions", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro", status: "active" });
    await db.update(subscriptions).set({ status: "canceled" }).run();
    // Canceled subs are filtered out by the status WHERE clause — no seed needed.

    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));
    expect(stats.subscriptionsEvaluated).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it("continues reporting for past_due — grace period still bills", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro", status: "past_due" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;
    await seedRequests(db, "t-1", 110_000, sub.currentPeriodStart);

    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));
    expect(stats.reportsWritten).toBe(1);
    expect(pushes[0].payload.value).toBe("10000");
  });

  it("uses a deterministic meter identifier so Stripe dedupes retries", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;
    await seedRequests(db, "t-1", 120_000, sub.currentPeriodStart);

    const pushes: MeterPush[] = [];
    await runUsageReportCycle(db, mockStripe(pushes));

    const id = pushes[0].identifier;
    expect(id).toContain(sub.stripeSubscriptionId);
    expect(id).toContain("20000"); // high-water mark baked in
  });
});

describe("isOperatorTenantForQuota", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("returns false when no allowlist is set", async () => {
    expect(await isOperatorTenantForQuota(db, "t-1")).toBe(false);
  });

  it("returns true for tenants with an operator user on the allowlist", async () => {
    await seedOperatorUser(db, "op-tenant", "ops@corelumen.com");
    expect(await isOperatorTenantForQuota(db, "op-tenant")).toBe(true);
  });

  it("returns false for tenants without an operator user", async () => {
    process.env.PROVARA_OPERATOR_EMAILS = "ops@corelumen.com";
    expect(await isOperatorTenantForQuota(db, "regular-tenant")).toBe(false);
  });
});

describe("listRecentUsageReports", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns reports for the given tenant, newest first", async () => {
    await db.insert(usageReports).values({
      id: "r1",
      stripeSubscriptionId: "sub_1",
      tenantId: "t-1",
      periodStart: new Date(Date.UTC(2026, 2, 1)),
      periodEnd: new Date(Date.UTC(2026, 3, 1)),
      reportedOverageCount: 5000,
      totalPushedUsd: 2.5,
    }).run();
    await db.insert(usageReports).values({
      id: "r2",
      stripeSubscriptionId: "sub_1",
      tenantId: "t-1",
      periodStart: new Date(Date.UTC(2026, 3, 1)),
      periodEnd: new Date(Date.UTC(2026, 4, 1)),
      reportedOverageCount: 8000,
      totalPushedUsd: 4,
    }).run();
    await db.insert(usageReports).values({
      id: "r3",
      stripeSubscriptionId: "other",
      tenantId: "t-other",
      periodStart: new Date(Date.UTC(2026, 3, 1)),
      periodEnd: new Date(Date.UTC(2026, 4, 1)),
      reportedOverageCount: 999,
      totalPushedUsd: 1,
    }).run();

    const out = await listRecentUsageReports(db, "t-1");
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("r2"); // newer periodStart first
    expect(out.find((r) => r.tenantId === "t-other")).toBeUndefined();
  });
});

describe("TIER_QUOTAS constants", () => {
  it("match the free/pro/team marketing values", () => {
    // Pin the canonical quotas so any drift between this module and the
    // dashboard's /v1/billing/me route or the pricing page surfaces in
    // code review, not on a customer invoice.
    expect(TIER_QUOTAS.free).toBe(10_000);
    expect(TIER_QUOTAS.pro).toBe(100_000);
    expect(TIER_QUOTAS.team).toBe(500_000);
  });
});

describe("rollover self-heal flush", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("flushes prior-period overage with a timestamp inside the old period", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;

    // Simulate the prior period: insert a usage_reports row for an older
    // period with some overage already reported, and seed requests inside
    // that window that push the real overage higher (the missed delta).
    const oldStart = new Date(sub.currentPeriodStart.getTime() - 30 * 86400_000);
    const oldEnd = sub.currentPeriodStart;
    await db.insert(usageReports).values({
      id: "old",
      stripeSubscriptionId: sub.stripeSubscriptionId,
      tenantId: sub.tenantId,
      periodStart: oldStart,
      periodEnd: oldEnd,
      reportedOverageCount: 5_000,
      totalPushedUsd: 2.5,
    }).run();
    // Seed 115k requests in the old period → 15k overage → 10k delta
    await seedRequests(db, "t-1", 115_000, new Date(oldStart.getTime() + 86400_000));

    const pushes: MeterPush[] = [];
    const stats = await runUsageReportCycle(db, mockStripe(pushes));

    expect(stats.reportsWritten).toBeGreaterThanOrEqual(1);
    const flush = pushes.find((p) => p.identifier.endsWith(":final"));
    expect(flush).toBeTruthy();
    expect(flush!.payload.value).toBe("10000");

    // Row is now marked finalized so subsequent cycles skip it.
    const after = await db.select().from(usageReports).where(eq(usageReports.id, "old")).get();
    expect(after?.finalizedAt).toBeTruthy();
    expect(after?.reportedOverageCount).toBe(15_000);
  });

  it("marks a prior period finalized with no push when no delta exists", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;

    const oldStart = new Date(sub.currentPeriodStart.getTime() - 30 * 86400_000);
    await db.insert(usageReports).values({
      id: "old",
      stripeSubscriptionId: sub.stripeSubscriptionId,
      tenantId: sub.tenantId,
      periodStart: oldStart,
      periodEnd: sub.currentPeriodStart,
      // Already fully reconciled — no new requests in the old window
      reportedOverageCount: 0,
      totalPushedUsd: 0,
    }).run();

    const pushes: MeterPush[] = [];
    await runUsageReportCycle(db, mockStripe(pushes));

    // No final push, but the row is finalized so we don't re-check.
    expect(pushes.filter((p) => p.identifier.endsWith(":final"))).toHaveLength(0);
    const after = await db.select().from(usageReports).where(eq(usageReports.id, "old")).get();
    expect(after?.finalizedAt).toBeTruthy();
  });

  it("ignores already-finalized prior periods on subsequent cycles", async () => {
    await db.insert(users).values({ id: "u1", email: "t@x.com", tenantId: "t-1", role: "owner", createdAt: new Date() }).run();
    await grantIntelligenceAccess(db, "t-1", { tier: "pro" });
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, "t-1")).get())!;

    const oldStart = new Date(sub.currentPeriodStart.getTime() - 30 * 86400_000);
    await db.insert(usageReports).values({
      id: "old",
      stripeSubscriptionId: sub.stripeSubscriptionId,
      tenantId: sub.tenantId,
      periodStart: oldStart,
      periodEnd: sub.currentPeriodStart,
      reportedOverageCount: 20_000,
      totalPushedUsd: 10,
      finalizedAt: new Date(),
    }).run();

    const pushes: MeterPush[] = [];
    await runUsageReportCycle(db, mockStripe(pushes));
    expect(pushes).toHaveLength(0);
  });
});

