import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@provara/db";
import { costLogs, requests, spendBudgets } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import {
  checkBudgetHardStop,
  periodBoundsUTC,
  runBudgetAlertsCycle,
} from "../src/billing/budget-alerts.js";

async function seedRequestAndCost(db: Db, id: string, tenantId: string, cost: number, createdAt: Date) {
  await db.insert(requests).values({
    id,
    provider: "openai",
    model: "gpt-4.1-nano",
    prompt: "[]",
    tenantId,
    createdAt,
  }).run();
  await db.insert(costLogs).values({
    id: `cl-${id}`,
    requestId: id,
    tenantId,
    provider: "openai",
    model: "gpt-4.1-nano",
    inputTokens: 100,
    outputTokens: 100,
    cost,
    createdAt,
  }).run();
}

async function seedBudget(db: Db, tenantId: string, overrides: Partial<{
  period: "monthly" | "quarterly";
  capUsd: number;
  alertThresholds: number[];
  alertEmails: string[];
  hardStop: boolean;
  alertedThresholds: number[];
  periodStartedAt: Date;
}> = {}) {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await db.insert(spendBudgets).values({
    tenantId,
    period: overrides.period ?? "monthly",
    capUsd: overrides.capUsd ?? 100,
    alertThresholds: overrides.alertThresholds ?? [50, 75, 90, 100],
    alertEmails: overrides.alertEmails ?? ["finance@example.com"],
    hardStop: overrides.hardStop ?? false,
    alertedThresholds: overrides.alertedThresholds ?? [],
    periodStartedAt: overrides.periodStartedAt ?? periodStart,
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe("#219/T7 — budget alerts", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("fires one email per newly-crossed threshold when tenant is at 80% of cap", async () => {
    await seedBudget(db, "t-1", { capUsd: 100 });
    await seedRequestAndCost(db, "r1", "t-1", 80, new Date());

    const emails: Array<{ to: string; subject: string }> = [];
    const stats = await runBudgetAlertsCycle(db, {
      sendEmail: async (input) => { emails.push(input); },
      emailBuilder: (params) => ({
        subject: `alert ${params.threshold}%`,
        html: "<p/>",
        text: "",
      }),
    });

    expect(stats.alertsFired).toBe(2); // 50 and 75 crossed; 90/100 not yet
    expect(emails.map((e) => e.subject)).toEqual(["alert 50%", "alert 75%"]);

    const after = await db.select().from(spendBudgets).where(eq(spendBudgets.tenantId, "t-1")).get();
    expect(after?.alertedThresholds).toEqual([50, 75]);
  });

  it("is idempotent within a period — a second run fires nothing new", async () => {
    await seedBudget(db, "t-1", { capUsd: 100, alertedThresholds: [50, 75] });
    await seedRequestAndCost(db, "r1", "t-1", 80, new Date());

    const emails: unknown[] = [];
    const stats = await runBudgetAlertsCycle(db, {
      sendEmail: async (input) => { emails.push(input); },
      emailBuilder: () => ({ subject: "x", html: "", text: "" }),
    });

    expect(stats.alertsFired).toBe(0);
    expect(emails).toHaveLength(0);
  });

  it("resets alertedThresholds when the period rolls over", async () => {
    // Budget stored with a period_started_at from a previous month.
    const lastMonth = new Date(Date.UTC(2026, 2, 1));
    await seedBudget(db, "t-1", {
      capUsd: 100,
      alertedThresholds: [50, 75, 90, 100],
      periodStartedAt: lastMonth,
    });
    // No spend in the current period → no new alerts, but the reset happens.
    const stats = await runBudgetAlertsCycle(db, {
      sendEmail: async () => {},
      emailBuilder: () => ({ subject: "x", html: "", text: "" }),
    });
    expect(stats.periodsReset).toBe(1);

    const after = await db.select().from(spendBudgets).where(eq(spendBudgets.tenantId, "t-1")).get();
    expect(after?.alertedThresholds).toEqual([]);
    const { start } = periodBoundsUTC(new Date(), "monthly");
    expect(after?.periodStartedAt.getTime()).toBe(start.getTime());
  });

  it("emails each configured recipient per threshold", async () => {
    await seedBudget(db, "t-1", {
      capUsd: 100,
      alertEmails: ["a@example.com", "b@example.com"],
    });
    await seedRequestAndCost(db, "r1", "t-1", 55, new Date());

    const emails: string[] = [];
    await runBudgetAlertsCycle(db, {
      sendEmail: async (input) => { emails.push(input.to); },
      emailBuilder: () => ({ subject: "x", html: "", text: "" }),
    });

    expect(emails.sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  describe("checkBudgetHardStop", () => {
    it("returns blocked=false when no budget exists", async () => {
      const result = await checkBudgetHardStop(db, "t-nobudget");
      expect(result.blocked).toBe(false);
    });

    it("returns blocked=false when budget has hard_stop=false even at 200%", async () => {
      await seedBudget(db, "t-1", { capUsd: 100, hardStop: false });
      await seedRequestAndCost(db, "r1", "t-1", 200, new Date());
      const result = await checkBudgetHardStop(db, "t-1");
      expect(result.blocked).toBe(false);
    });

    it("returns blocked=true when hard_stop=true and spend >= cap", async () => {
      await seedBudget(db, "t-1", { capUsd: 100, hardStop: true });
      await seedRequestAndCost(db, "r1", "t-1", 150, new Date());
      const result = await checkBudgetHardStop(db, "t-1");
      expect(result.blocked).toBe(true);
      expect(result.spend).toBe(150);
      expect(result.cap).toBe(100);
    });

    it("returns blocked=false when hard_stop=true but spend < cap", async () => {
      await seedBudget(db, "t-1", { capUsd: 100, hardStop: true });
      await seedRequestAndCost(db, "r1", "t-1", 50, new Date());
      const result = await checkBudgetHardStop(db, "t-1");
      expect(result.blocked).toBe(false);
    });
  });
});
