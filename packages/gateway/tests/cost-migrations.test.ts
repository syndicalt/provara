import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { modelScores, requests, costMigrations } from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import {
  EPSILON_QUALITY,
  GRACE_BOOST,
  MIGRATION_MIN_SAMPLES,
  createBoostTable,
  executeMigration,
  findMigrationCandidates,
  isCostMigrationEnabled,
  listMigrations,
  rollbackMigration,
  runCostMigrationCycle,
  setCostMigrationOptIn,
  totalSavingsThisMonth,
} from "../src/routing/adaptive/migrations.js";

async function seedScore(
  db: Db,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  qualityScore: number,
  sampleCount = MIGRATION_MIN_SAMPLES,
  updatedAt: Date = new Date(),
) {
  await db
    .insert(modelScores)
    .values({ taskType, complexity, provider, model, qualityScore, sampleCount, updatedAt })
    .run();
}

async function seedRequests(db: Db, params: { provider: string; model: string; taskType: string; complexity: string; count: number; avgInputTokens?: number; avgOutputTokens?: number }) {
  for (let i = 0; i < params.count; i++) {
    await db.insert(requests).values({
      id: `r-${params.provider}-${params.model}-${params.taskType}-${params.complexity}-${i}`,
      provider: params.provider,
      model: params.model,
      prompt: "test",
      taskType: params.taskType,
      complexity: params.complexity,
      inputTokens: params.avgInputTokens ?? 1000,
      outputTokens: params.avgOutputTokens ?? 500,
      createdAt: new Date(),
    }).run();
  }
}

describe("findMigrationCandidates", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("flags cells where a cheaper model holds quality within epsilon", async () => {
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.4);
    const candidates = await findMigrationCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].from.model).toBe("gpt-4o");
    expect(candidates[0].to.model).toBe("gpt-4o-mini");
  });

  it("skips cells where cheaper model's quality drops beyond epsilon", async () => {
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.5 - EPSILON_QUALITY - 0.1);
    const candidates = await findMigrationCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it("skips cells where cheaper model isn't cheap enough", async () => {
    // Both gpt-4o at same quality — no cost advantage
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5);
    await seedScore(db, "coding", "complex", "anthropic", "claude-sonnet-4-6", 4.4);
    // gpt-4o=12.5, sonnet=18 — not cheaper
    const candidates = await findMigrationCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it("requires MIGRATION_MIN_SAMPLES samples (stricter than routing)", async () => {
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5, MIGRATION_MIN_SAMPLES);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.4, MIGRATION_MIN_SAMPLES - 1);
    const candidates = await findMigrationCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it("skips stale cells (updatedAt older than 30 days)", async () => {
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5, MIGRATION_MIN_SAMPLES, staleDate);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.4, MIGRATION_MIN_SAMPLES, staleDate);
    const candidates = await findMigrationCandidates(db);
    expect(candidates).toHaveLength(0);
  });

  it("sorts by projected savings descending", async () => {
    // Cell A: heavy traffic, modest cost diff
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.4);
    await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "complex", count: 100 });

    // Cell B: light traffic, similar cost diff
    await seedScore(db, "qa", "simple", "openai", "gpt-4o", 4.5);
    await seedScore(db, "qa", "simple", "openai", "gpt-4o-mini", 4.4);
    await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "qa", complexity: "simple", count: 10 });

    const candidates = await findMigrationCandidates(db);
    expect(candidates).toHaveLength(2);
    // Coding+complex should outrank qa+simple (more traffic)
    expect(candidates[0].taskType).toBe("coding");
    expect(candidates[0].projectedMonthlySavingsUsd).toBeGreaterThan(candidates[1].projectedMonthlySavingsUsd);
  });
});

describe("executeMigration / cooldown", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  const candidate = {
    taskType: "coding",
    complexity: "complex",
    from: { provider: "openai", model: "gpt-4o", qualityScore: 4.5, costPer1M: 12.5 },
    to: { provider: "openai", model: "gpt-4o-mini", qualityScore: 4.4, costPer1M: 0.75 },
    projectedMonthlySavingsUsd: 42,
  };

  it("creates a cost_migrations row with grace window", async () => {
    const result = await executeMigration(db, null, candidate);
    expect(result).not.toBeNull();
    const row = await db.select().from(costMigrations).where(eq(costMigrations.id, result!.id)).get();
    expect(row?.fromModel).toBe("gpt-4o");
    expect(row?.toModel).toBe("gpt-4o-mini");
    expect(row?.graceEndsAt).toBeTruthy();
    expect(row?.graceEndsAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null when the same cell was migrated recently", async () => {
    const first = await executeMigration(db, null, candidate);
    expect(first).not.toBeNull();
    const second = await executeMigration(db, null, candidate);
    expect(second).toBeNull();
  });

  it("allows re-migration after cooldown elapses", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-01-01T00:00:00Z");
      vi.setSystemTime(start);
      await executeMigration(db, null, candidate);

      vi.setSystemTime(new Date(start.getTime() + 31 * 24 * 60 * 60 * 1000));
      const again = await executeMigration(db, null, candidate);
      expect(again).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createBoostTable", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns 0 boost when no active migrations exist", async () => {
    const bt = createBoostTable(db);
    await bt.refresh();
    expect(bt.getBoost("coding", "complex", "openai", "gpt-4o-mini")).toBe(0);
  });

  it("returns GRACE_BOOST for the target of an active migration", async () => {
    await executeMigration(db, null, {
      taskType: "coding",
      complexity: "complex",
      from: { provider: "openai", model: "gpt-4o", qualityScore: 4.5, costPer1M: 12.5 },
      to: { provider: "openai", model: "gpt-4o-mini", qualityScore: 4.4, costPer1M: 0.75 },
      projectedMonthlySavingsUsd: 10,
    });

    const bt = createBoostTable(db);
    await bt.refresh();
    expect(bt.getBoost("coding", "complex", "openai", "gpt-4o-mini")).toBe(GRACE_BOOST);
    expect(bt.getBoost("coding", "complex", "openai", "gpt-4o")).toBe(0);
  });

  it("drops the boost after rollback", async () => {
    const result = await executeMigration(db, null, {
      taskType: "coding",
      complexity: "complex",
      from: { provider: "openai", model: "gpt-4o", qualityScore: 4.5, costPer1M: 12.5 },
      to: { provider: "openai", model: "gpt-4o-mini", qualityScore: 4.4, costPer1M: 0.75 },
      projectedMonthlySavingsUsd: 10,
    });

    const bt = createBoostTable(db);
    await bt.refresh();
    expect(bt.getBoost("coding", "complex", "openai", "gpt-4o-mini")).toBe(GRACE_BOOST);

    await rollbackMigration(db, result!.id, "test");
    await bt.refresh();
    expect(bt.getBoost("coding", "complex", "openai", "gpt-4o-mini")).toBe(0);
  });
});

describe("runCostMigrationCycle", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("no-ops when global opt-in is disabled", async () => {
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.4);

    const stats = await runCostMigrationCycle(db);
    expect(stats.executed).toHaveLength(0);
  });

  it("executes eligible migrations once opted in", async () => {
    await setCostMigrationOptIn(db, null, true);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o", 4.5);
    await seedScore(db, "coding", "complex", "openai", "gpt-4o-mini", 4.4);
    await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "complex", count: 50 });

    const stats = await runCostMigrationCycle(db);
    expect(stats.executed).toHaveLength(1);
  });

  it("respects the per-cycle cap", async () => {
    await setCostMigrationOptIn(db, null, true);
    for (let i = 0; i < 5; i++) {
      const tt = `task-${i}`;
      await seedScore(db, tt, "complex", "openai", "gpt-4o", 4.5);
      await seedScore(db, tt, "complex", "openai", "gpt-4o-mini", 4.4);
    }
    const stats = await runCostMigrationCycle(db);
    expect(stats.executed.length).toBeLessThanOrEqual(3);
  });
});

describe("listMigrations + savings", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("totalSavingsThisMonth sums non-rolled-back migrations", async () => {
    await executeMigration(db, null, {
      taskType: "coding",
      complexity: "complex",
      from: { provider: "openai", model: "gpt-4o", qualityScore: 4.5, costPer1M: 12.5 },
      to: { provider: "openai", model: "gpt-4o-mini", qualityScore: 4.4, costPer1M: 0.75 },
      projectedMonthlySavingsUsd: 42,
    });
    await executeMigration(db, null, {
      taskType: "qa",
      complexity: "simple",
      from: { provider: "openai", model: "gpt-4o", qualityScore: 4.5, costPer1M: 12.5 },
      to: { provider: "openai", model: "gpt-4o-mini", qualityScore: 4.4, costPer1M: 0.75 },
      projectedMonthlySavingsUsd: 20,
    });

    const total = await totalSavingsThisMonth(db, null);
    expect(total).toBe(62);

    const migrations = await listMigrations(db, null);
    expect(migrations).toHaveLength(2);
  });

  it("excludes rolled-back migrations from savings", async () => {
    const result = await executeMigration(db, null, {
      taskType: "coding",
      complexity: "complex",
      from: { provider: "openai", model: "gpt-4o", qualityScore: 4.5, costPer1M: 12.5 },
      to: { provider: "openai", model: "gpt-4o-mini", qualityScore: 4.4, costPer1M: 0.75 },
      projectedMonthlySavingsUsd: 42,
    });
    await rollbackMigration(db, result!.id, "test");
    const total = await totalSavingsThisMonth(db, null);
    expect(total).toBe(0);
  });
});

describe("opt-in roundtrip", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("defaults to disabled", async () => {
    expect(await isCostMigrationEnabled(db, null)).toBe(false);
    expect(await isCostMigrationEnabled(db, "t")).toBe(false);
  });

  it("toggles per tenant", async () => {
    await setCostMigrationOptIn(db, "t-a", true);
    expect(await isCostMigrationEnabled(db, "t-a")).toBe(true);
    expect(await isCostMigrationEnabled(db, "t-b")).toBe(false);
  });
});
