import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import {
  requests,
  feedback,
  replayBank,
  regressionEvents,
} from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import {
  REPLAY_BANK_MAX_PER_CELL,
  REPLAY_BANK_MIN_SCORE,
  isRegressionDetectionEnabled,
  setRegressionOptIn,
  getBudgetStatus,
  runBankPopulationCycle,
  runReplayCycle,
  listRegressionEvents,
  resolveRegressionEvent,
} from "../src/routing/adaptive/regression.js";
import type { ProviderRegistry, Provider } from "../src/providers/index.js";

beforeEach(() => {
  resetTierEnv();
});

function makeRequestRow(
  db: Db,
  params: {
    id: string;
    tenantId: string | null;
    provider: string;
    model: string;
    taskType: string;
    complexity: string;
    prompt?: string;
    response?: string;
  },
) {
  return db
    .insert(requests)
    .values({
      id: params.id,
      provider: params.provider,
      model: params.model,
      prompt: params.prompt ?? JSON.stringify([{ role: "user", content: "test " + params.id }]),
      response: params.response ?? "response for " + params.id,
      taskType: params.taskType,
      complexity: params.complexity,
      tenantId: params.tenantId,
      createdAt: new Date(),
    })
    .run();
}

function makeFeedbackRow(db: Db, requestId: string, score: number, source: "user" | "judge" = "judge") {
  return db
    .insert(feedback)
    .values({
      id: "fb-" + requestId,
      requestId,
      score,
      source,
      createdAt: new Date(),
    })
    .run();
}

describe("regression opt-in / budget", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("defaults to disabled when no config row exists", async () => {
    expect(await isRegressionDetectionEnabled(db, null)).toBe(false);
  });

  it("round-trips opt-in state per tenant", async () => {
    await setRegressionOptIn(db, "tenant-a", true);
    await setRegressionOptIn(db, "tenant-b", false);
    expect(await isRegressionDetectionEnabled(db, "tenant-a")).toBe(true);
    expect(await isRegressionDetectionEnabled(db, "tenant-b")).toBe(false);
    expect(await isRegressionDetectionEnabled(db, null)).toBe(false);
  });

  it("budget starts at zero and sums add correctly", async () => {
    const first = await getBudgetStatus(db, "tenant-a");
    expect(first.used).toBe(0);
    expect(first.remaining).toBe(first.limit);
  });
});

describe("runBankPopulationCycle", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("only populates cells for opted-in tenants", async () => {
    for (let i = 0; i < 3; i++) {
      await makeRequestRow(db, {
        id: `r-${i}`,
        tenantId: "opted-in",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
      await makeFeedbackRow(db, `r-${i}`, 5);
    }
    for (let i = 0; i < 3; i++) {
      await makeRequestRow(db, {
        id: `r-skip-${i}`,
        tenantId: "opted-out",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
      await makeFeedbackRow(db, `r-skip-${i}`, 5);
    }

    await grantIntelligenceAccess(db, "opted-in");
    await grantIntelligenceAccess(db, "opted-out");
    await setRegressionOptIn(db, "opted-in", true);

    const results = await runBankPopulationCycle(db, null);
    expect(results).toHaveLength(1);
    expect(results[0].tenantId).toBe("opted-in");
    expect(results[0].added).toBe(3);

    const rows = await db.select().from(replayBank).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.tenantId === "opted-in")).toBe(true);
  });

  it("skips low-rated prompts below REPLAY_BANK_MIN_SCORE", async () => {
    await makeRequestRow(db, {
      id: "lo",
      tenantId: "t",
      provider: "openai",
      model: "gpt-4o",
      taskType: "coding",
      complexity: "complex",
    });
    await makeFeedbackRow(db, "lo", REPLAY_BANK_MIN_SCORE - 1);

    await makeRequestRow(db, {
      id: "hi",
      tenantId: "t",
      provider: "openai",
      model: "gpt-4o",
      taskType: "coding",
      complexity: "complex",
    });
    await makeFeedbackRow(db, "hi", REPLAY_BANK_MIN_SCORE);

    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    await runBankPopulationCycle(db, null);

    const rows = await db.select().from(replayBank).all();
    expect(rows.map((r) => r.sourceRequestId)).toEqual(["hi"]);
  });

  it("respects REPLAY_BANK_MAX_PER_CELL cap", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    const over = REPLAY_BANK_MAX_PER_CELL + 5;
    for (let i = 0; i < over; i++) {
      await makeRequestRow(db, {
        id: `r-${i}`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
        prompt: JSON.stringify([{ role: "user", content: `prompt ${i}` }]),
      });
      await makeFeedbackRow(db, `r-${i}`, 5);
    }

    await runBankPopulationCycle(db, null);
    const rows = await db.select().from(replayBank).all();
    expect(rows.length).toBe(REPLAY_BANK_MAX_PER_CELL);
  });

  it("is idempotent — running twice doesn't duplicate existing entries", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    for (let i = 0; i < 3; i++) {
      await makeRequestRow(db, {
        id: `r-${i}`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
      await makeFeedbackRow(db, `r-${i}`, 5);
    }

    await runBankPopulationCycle(db, null);
    await runBankPopulationCycle(db, null);

    const rows = await db.select().from(replayBank).all();
    expect(rows).toHaveLength(3);
  });
});

interface MockCompletion {
  content: string;
  tokens?: { input: number; output: number };
}

function mockRegistry(responses: Map<string, MockCompletion[]>): ProviderRegistry {
  const providers = new Map<string, Provider>();
  const names = new Set<string>();
  for (const key of responses.keys()) {
    const [providerName] = key.split("::");
    names.add(providerName);
  }
  for (const name of names) {
    providers.set(name, {
      name,
      models: [],
      async complete(req) {
        const key = `${name}::${req.model}`;
        const queue = responses.get(key);
        if (!queue || queue.length === 0) {
          throw new Error(`no mock response for ${key}`);
        }
        const next = queue.shift()!;
        return {
          id: "mock",
          provider: name,
          model: req.model,
          content: next.content,
          usage: {
            inputTokens: next.tokens?.input ?? 10,
            outputTokens: next.tokens?.output ?? 20,
          },
          latencyMs: 50,
        };
      },
      async *stream() {},
    });
  }
  return {
    get: (name: string) => providers.get(name),
    list: () => Array.from(providers.values()),
    refreshModels: async () => [],
  } as unknown as ProviderRegistry;
}

describe("runReplayCycle", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  async function seedBank(tenantId: string, count: number, score = 5) {
    for (let i = 0; i < count; i++) {
      await db
        .insert(replayBank)
        .values({
          id: `bank-${tenantId}-${i}`,
          tenantId,
          taskType: "coding",
          complexity: "complex",
          provider: "openai",
          model: "gpt-4o",
          prompt: JSON.stringify([{ role: "user", content: `prompt ${i}` }]),
          response: `original response ${i}`,
          originalScore: score,
          originalScoreSource: "user",
          sourceRequestId: `req-${i}`,
        })
        .run();

      // Need a request row so distinctEligibleCells discovers this cell
      await makeRequestRow(db, {
        id: `req-${i}-${tenantId}`,
        tenantId,
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
    }
  }

  it("records a regression_events row when replay scores drop below threshold", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    await seedBank("t", 3, 5);

    const registry = mockRegistry(
      new Map([
        ["openai::gpt-4o", [
          { content: "weak new answer 1" },
          { content: "weak new answer 2" },
          { content: "weak new answer 3" },
        ]],
        ["openai::judge", [
          { content: '{"score": 2}' },
          { content: '{"score": 2}' },
          { content: '{"score": 2}' },
        ]],
      ]),
    );

    const stats = await runReplayCycle(db, registry, { provider: "openai", model: "judge" });
    expect(stats.replaysExecuted).toBe(3);
    expect(stats.regressionsDetected).toBe(1);

    const events = await db.select().from(regressionEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBeLessThanOrEqual(-0.5);
  });

  it("does not record an event when replay scores hold steady", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    await seedBank("t", 3, 5);

    const registry = mockRegistry(
      new Map([
        ["openai::gpt-4o", [
          { content: "ok 1" },
          { content: "ok 2" },
          { content: "ok 3" },
        ]],
        ["openai::judge", [
          { content: '{"score": 5}' },
          { content: '{"score": 5}' },
          { content: '{"score": 5}' },
        ]],
      ]),
    );

    const stats = await runReplayCycle(db, registry, { provider: "openai", model: "judge" });
    expect(stats.regressionsDetected).toBe(0);
    const events = await db.select().from(regressionEvents).all();
    expect(events).toHaveLength(0);
  });

  it("skips tenants that have not opted in", async () => {
    // Grant Intelligence access so the ONLY remaining gate is the opt-in
    // check — otherwise this test could pass for the wrong reason (tier
    // gate skipping it first).
    await grantIntelligenceAccess(db, "not-opted-in");
    await seedBank("not-opted-in", 3);

    const registry = mockRegistry(new Map([
      ["openai::gpt-4o", []],
      ["openai::judge", []],
    ]));
    const stats = await runReplayCycle(db, registry, { provider: "openai", model: "judge" });
    expect(stats.cellsEvaluated).toBe(0);
    expect(stats.replaysExecuted).toBe(0);
  });

  it("returns early when no judge target is provided", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    await seedBank("t", 3);

    const registry = mockRegistry(new Map());
    const stats = await runReplayCycle(db, registry, null);
    expect(stats.cellsEvaluated).toBe(0);
    expect(stats.replaysExecuted).toBe(0);
  });
});

describe("listRegressionEvents / resolveRegressionEvent", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns events tenant-scoped and resolves them", async () => {
    await db.insert(regressionEvents).values({
      id: "e1",
      tenantId: "t",
      taskType: "coding",
      complexity: "complex",
      provider: "openai",
      model: "gpt-4o",
      replayCount: 5,
      originalMean: 4.5,
      replayMean: 3.5,
      delta: -1,
      costUsd: 0.1,
    }).run();

    const listed = await listRegressionEvents(db, "t");
    expect(listed).toHaveLength(1);
    expect(listed[0].resolvedAt).toBeNull();

    const ok = await resolveRegressionEvent(db, "e1", "manual rollback");
    expect(ok).toBe(true);

    const unresolved = await listRegressionEvents(db, "t", { unresolvedOnly: true });
    expect(unresolved).toHaveLength(0);
  });

  it("returns false when resolving a missing event", async () => {
    const ok = await resolveRegressionEvent(db, "missing", null);
    expect(ok).toBe(false);
  });
});

describe("bank calibration: user-rated entries excluded (#160)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("user-rated prompts are NOT ingested into the bank", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);

    // Three judge-scored (should be banked), three user-rated (should NOT be)
    for (let i = 0; i < 3; i++) {
      await makeRequestRow(db, {
        id: `j-${i}`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
      await makeFeedbackRow(db, `j-${i}`, 5, "judge");
    }
    for (let i = 0; i < 3; i++) {
      await makeRequestRow(db, {
        id: `u-${i}`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
      await makeFeedbackRow(db, `u-${i}`, 5, "user");
    }

    await runBankPopulationCycle(db, null);
    const rows = await db.select().from(replayBank).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.originalScoreSource === "judge")).toBe(true);
    expect(rows.map((r) => r.sourceRequestId).sort()).toEqual(["j-0", "j-1", "j-2"]);
  });

  it("a cell with only user-rated prompts produces an empty bank", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    for (let i = 0; i < 5; i++) {
      await makeRequestRow(db, {
        id: `u-${i}`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
      await makeFeedbackRow(db, `u-${i}`, 5, "user");
    }

    const results = await runBankPopulationCycle(db, null);
    expect(results).toHaveLength(0);
    const rows = await db.select().from(replayBank).all();
    expect(rows).toHaveLength(0);
  });
});

describe("regression event dedupe (#160)", () => {
  let db: Db;

  async function seedBankWithScores(tenantId: string, count: number, score = 5) {
    for (let i = 0; i < count; i++) {
      await db
        .insert(replayBank)
        .values({
          id: `bank-${tenantId}-${i}`,
          tenantId,
          taskType: "coding",
          complexity: "complex",
          provider: "openai",
          model: "gpt-4o",
          prompt: JSON.stringify([{ role: "user", content: `prompt ${i}` }]),
          response: `orig ${i}`,
          originalScore: score,
          originalScoreSource: "judge",
          sourceRequestId: `req-${i}`,
        })
        .run();
      await makeRequestRow(db, {
        id: `req-${i}-${tenantId}`,
        tenantId,
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
    }
  }

  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("second replay cycle updates the existing unresolved event instead of duplicating", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    await seedBankWithScores("t", 3, 5);

    const buildRegistry = () => mockRegistry(new Map([
      ["openai::gpt-4o", [
        { content: "weak 1" }, { content: "weak 2" }, { content: "weak 3" },
      ]],
      ["openai::judge", [
        { content: '{"score": 2}' }, { content: '{"score": 2}' }, { content: '{"score": 2}' },
      ]],
    ]));

    await runReplayCycle(db, buildRegistry(), { provider: "openai", model: "judge" });
    const afterFirst = await db.select().from(regressionEvents).all();
    expect(afterFirst).toHaveLength(1);
    const firstDetectedAt = afterFirst[0].detectedAt;
    const firstCost = afterFirst[0].costUsd;

    await runReplayCycle(db, buildRegistry(), { provider: "openai", model: "judge" });
    const afterSecond = await db.select().from(regressionEvents).all();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
    expect(afterSecond[0].detectedAt.getTime()).toBe(firstDetectedAt.getTime());
    // Cost accumulates across cycles
    expect(afterSecond[0].costUsd).toBeGreaterThanOrEqual(firstCost);
  });

  it("a resolved event does not block a new event on the next regression", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    await seedBankWithScores("t", 3, 5);

    const buildRegistry = () => mockRegistry(new Map([
      ["openai::gpt-4o", [
        { content: "weak 1" }, { content: "weak 2" }, { content: "weak 3" },
      ]],
      ["openai::judge", [
        { content: '{"score": 2}' }, { content: '{"score": 2}' }, { content: '{"score": 2}' },
      ]],
    ]));

    await runReplayCycle(db, buildRegistry(), { provider: "openai", model: "judge" });
    const first = (await db.select().from(regressionEvents).all())[0];

    // Operator dismisses
    const { resolveRegressionEvent } = await import("../src/routing/adaptive/regression.js");
    await resolveRegressionEvent(db, first.id, "dismissed");

    // Next cycle — should now produce a NEW event since the old one is resolved
    await runReplayCycle(db, buildRegistry(), { provider: "openai", model: "judge" });
    const all = await db.select().from(regressionEvents).all();
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.resolvedAt === null)).toHaveLength(1);
  });
});

describe("closed feedback loop (#163)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("runReplayCycle feeds judge scores into adaptive.updateScore when writer is provided", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    // Seed bank with judge-scored baselines (post-#160 requirement)
    for (let i = 0; i < 3; i++) {
      await db.insert(replayBank).values({
        id: `bank-${i}`,
        tenantId: "t",
        taskType: "coding",
        complexity: "complex",
        provider: "openai",
        model: "gpt-4o",
        prompt: JSON.stringify([{ role: "user", content: `p-${i}` }]),
        response: "original",
        originalScore: 5,
        originalScoreSource: "judge",
        sourceRequestId: `req-${i}`,
      }).run();
      await makeRequestRow(db, {
        id: `req-${i}-t`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
    }

    const updates: Array<{ taskType: string; complexity: string; provider: string; model: string; score: number; source: string; tenantId?: string | null }> = [];
    const adaptiveStub = {
      async updateScore(taskType: string, complexity: string, provider: string, model: string, score: number, source: "user" | "judge", tenantId?: string | null) {
        updates.push({ taskType, complexity, provider, model, score, source, tenantId });
      },
    };

    const registry = mockRegistry(new Map([
      ["openai::gpt-4o", [
        { content: "weak 1" }, { content: "weak 2" }, { content: "weak 3" },
      ]],
      ["openai::judge", [
        { content: '{"score": 2}' }, { content: '{"score": 2}' }, { content: '{"score": 2}' },
      ]],
    ]));

    await runReplayCycle(db, registry, { provider: "openai", model: "judge" }, adaptiveStub);

    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u).toMatchObject({
        taskType: "coding",
        complexity: "complex",
        provider: "openai",
        model: "gpt-4o",
        score: 2,
        source: "judge",
        tenantId: "t", // C3: tenantId threads from cell → adaptive.updateScore
      });
    }
  });

  it("does not fail when adaptive writer is omitted (back-compat)", async () => {
    await grantIntelligenceAccess(db, "t");
    await setRegressionOptIn(db, "t", true);
    for (let i = 0; i < 3; i++) {
      await db.insert(replayBank).values({
        id: `bank-${i}`,
        tenantId: "t",
        taskType: "coding",
        complexity: "complex",
        provider: "openai",
        model: "gpt-4o",
        prompt: JSON.stringify([{ role: "user", content: `p-${i}` }]),
        response: "o",
        originalScore: 5,
        originalScoreSource: "judge",
        sourceRequestId: `req-${i}`,
      }).run();
      await makeRequestRow(db, {
        id: `req-${i}-t`,
        tenantId: "t",
        provider: "openai",
        model: "gpt-4o",
        taskType: "coding",
        complexity: "complex",
      });
    }

    const registry = mockRegistry(new Map([
      ["openai::gpt-4o", [{ content: "w1" }, { content: "w2" }, { content: "w3" }]],
      ["openai::judge", [
        { content: '{"score": 3}' }, { content: '{"score": 3}' }, { content: '{"score": 3}' },
      ]],
    ]));

    const stats = await runReplayCycle(db, registry, { provider: "openai", model: "judge" });
    expect(stats.replaysExecuted).toBe(3);
  });
});

describe("RegressionCellTable (#163)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("reports false for cells with no events", async () => {
    const { createRegressionCellTable } = await import("../src/routing/adaptive/regression.js");
    const table = createRegressionCellTable(db);
    await table.refresh();
    expect(table.isRegressing("coding", "complex")).toBe(false);
  });

  it("reports true for cells with an unresolved regression event", async () => {
    await db.insert(regressionEvents).values({
      id: "e1",
      tenantId: "t",
      taskType: "coding",
      complexity: "complex",
      provider: "openai",
      model: "gpt-4o",
      replayCount: 5,
      originalMean: 4.8,
      replayMean: 3.5,
      delta: -1.3,
      costUsd: 0.05,
    }).run();

    const { createRegressionCellTable } = await import("../src/routing/adaptive/regression.js");
    const table = createRegressionCellTable(db);
    await table.refresh();
    expect(table.isRegressing("coding", "complex")).toBe(true);
    expect(table.isRegressing("qa", "simple")).toBe(false);
  });

  it("refresh picks up new events and drops resolved ones", async () => {
    const { createRegressionCellTable } = await import("../src/routing/adaptive/regression.js");
    const table = createRegressionCellTable(db);
    await table.refresh();
    expect(table.isRegressing("coding", "complex")).toBe(false);

    await db.insert(regressionEvents).values({
      id: "e1",
      tenantId: "t",
      taskType: "coding",
      complexity: "complex",
      provider: "openai",
      model: "gpt-4o",
      replayCount: 5,
      originalMean: 4.5,
      replayMean: 3.5,
      delta: -1,
      costUsd: 0.05,
    }).run();
    await table.refresh();
    expect(table.isRegressing("coding", "complex")).toBe(true);

    await db.update(regressionEvents).set({ resolvedAt: new Date() }).where(eq(regressionEvents.id, "e1")).run();
    await table.refresh();
    expect(table.isRegressing("coding", "complex")).toBe(false);
  });
});
