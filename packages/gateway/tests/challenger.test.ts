import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { modelScores, abTests, abTestVariants } from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import {
  LOW_SCORE_THRESHOLD,
  LOW_SCORE_MIN_SAMPLES_FOR_PROBE,
  findLowScoringCells,
  pickChallenger,
  spawnChallengerTest,
  getScoredModelsForCell,
} from "../src/routing/adaptive/challenger.js";
import { POOL_KEY } from "../src/routing/adaptive/score-store.js";

const MIN_SAMPLES = parseInt(process.env.PROVARA_MIN_SAMPLES || "5", 10);

async function seedScore(
  db: Db,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  qualityScore: number,
  sampleCount = MIN_SAMPLES,
) {
  await db
    .insert(modelScores)
    .values({
      tenantId: POOL_KEY,
      taskType,
      complexity,
      provider,
      model,
      qualityScore,
      sampleCount,
      updatedAt: new Date(),
    })
    .run();
}

describe("findLowScoringCells", () => {
  it("flags lonely-low cells with a single sufficiently-sampled model", async () => {
    const db = await makeTestDb();
    // Lonely-low candidate: one model below threshold, well-sampled.
    await seedScore(db, "summarization", "simple", "openai", "gpt-4.1-nano", 1.8);
    // Healthy cell: model above threshold — should be skipped.
    await seedScore(db, "qa", "medium", "openai", "gpt-4o", 4.5);
    // Cell with two low-scoring models — broader detection skipped per
    // module contract (existing tie-cell logic already handles ties).
    await seedScore(db, "creative", "complex", "openai", "gpt-4.1-nano", 2.1);
    await seedScore(db, "creative", "complex", "google", "gemini-2.0-flash", 2.0);

    const cells = await findLowScoringCells(db);
    expect(cells).toHaveLength(1);
    expect(cells[0].taskType).toBe("summarization");
    expect(cells[0].incumbent.model).toBe("gpt-4.1-nano");
    expect(cells[0].incumbent.qualityScore).toBeCloseTo(1.8);
  });

  it("ignores cells where the only model is below the probe-sample floor", async () => {
    const db = await makeTestDb();
    // 1 sample is below LOW_SCORE_MIN_SAMPLES_FOR_PROBE (default 2)
    // — too few to rule out a fluke.
    await seedScore(db, "vision", "simple", "openai", "gpt-4.1-mini", 1.0, 1);

    const cells = await findLowScoringCells(db);
    expect(cells).toHaveLength(0);
  });

  it("flags cells whose only model has at least the probe-sample floor (below MIN_SAMPLES is ok)", async () => {
    const db = await makeTestDb();
    // 2 samples — meets the probe floor (default 2) but stays below
    // MIN_SAMPLES (default 5). The dashboard's manual button should
    // surface, even though Track 2 auto exploration would not boost
    // this cell yet.
    expect(LOW_SCORE_MIN_SAMPLES_FOR_PROBE).toBeLessThan(MIN_SAMPLES);
    await seedScore(db, "vision", "complex", "openai", "gpt-4.1-mini", 1.5, 2);

    const cells = await findLowScoringCells(db);
    expect(cells).toHaveLength(1);
    expect(cells[0].taskType).toBe("vision");
    expect(cells[0].incumbent.sampleCount).toBe(2);
  });

  it("respects an explicit minSamples override", async () => {
    const db = await makeTestDb();
    await seedScore(db, "vision", "simple", "openai", "gpt-4.1-mini", 1.5, 3);

    const strict = await findLowScoringCells(db, { minSamples: 5 });
    expect(strict).toHaveLength(0);
    const relaxed = await findLowScoringCells(db, { minSamples: 1 });
    expect(relaxed).toHaveLength(1);
  });

  it("respects the threshold option override", async () => {
    const db = await makeTestDb();
    await seedScore(db, "qa", "complex", "openai", "gpt-4.1-mini", 2.8);

    const defaultRun = await findLowScoringCells(db);
    expect(defaultRun).toHaveLength(0); // 2.8 > 2.5 default
    const customRun = await findLowScoringCells(db, { threshold: 3.0 });
    expect(customRun).toHaveLength(1);
  });

  it("sorts results worst-first", async () => {
    const db = await makeTestDb();
    await seedScore(db, "vision", "complex", "openai", "gpt-4.1-mini", 1.5);
    await seedScore(db, "summarization", "simple", "openai", "gpt-4.1-nano", 1.8);

    const cells = await findLowScoringCells(db);
    expect(cells.map((c) => c.taskType)).toEqual(["vision", "summarization"]);
  });

  it("threshold constant is sane", () => {
    expect(LOW_SCORE_THRESHOLD).toBeGreaterThan(1);
    expect(LOW_SCORE_THRESHOLD).toBeLessThan(5);
  });
});

describe("pickChallenger", () => {
  const candidates = [
    { provider: "openai", model: "gpt-4.1-nano" },
    { provider: "openai", model: "gpt-4.1-mini" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    { provider: "google", model: "gemini-2.0-flash" },
  ];
  const allProviders = new Set(["openai", "anthropic", "google"]);

  it("prefers a different provider family over the incumbent's", () => {
    const pick = pickChallenger({
      taskType: "qa",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-nano" },
      candidates,
      availableProviders: allProviders,
    });
    expect(pick).not.toBeNull();
    expect(pick!.provider).not.toBe("openai");
  });

  it("falls back to same-family when no other provider is available", () => {
    const pick = pickChallenger({
      taskType: "qa",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-nano" },
      candidates,
      availableProviders: new Set(["openai"]),
    });
    expect(pick).not.toBeNull();
    expect(pick!.provider).toBe("openai");
    expect(pick!.model).not.toBe("gpt-4.1-nano");
  });

  it("excludes already-scored models", () => {
    const pick = pickChallenger({
      taskType: "qa",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-nano" },
      candidates,
      availableProviders: allProviders,
      scoredModels: new Set([
        "openai/gpt-4.1-nano",
        "openai/gpt-4.1-mini",
        "anthropic/claude-haiku-4-5-20251001",
      ]),
    });
    expect(pick).not.toBeNull();
    expect(pick!.provider).toBe("google");
  });

  it("returns null when no eligible challenger remains", () => {
    const pick = pickChallenger({
      taskType: "qa",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-nano" },
      candidates: [{ provider: "openai", model: "gpt-4.1-nano" }],
      availableProviders: allProviders,
    });
    expect(pick).toBeNull();
  });

  it("filters to vision-capable models for vision cells", () => {
    const pick = pickChallenger({
      taskType: "vision",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-mini" },
      candidates: [
        { provider: "openai", model: "gpt-4.1-nano" }, // not vision-capable
        { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, // vision
      ],
      availableProviders: allProviders,
    });
    expect(pick).not.toBeNull();
    expect(pick!.model).toBe("claude-haiku-4-5-20251001");
  });

  it("never returns the incumbent itself", () => {
    const pick = pickChallenger({
      taskType: "qa",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-nano" },
      candidates: [{ provider: "openai", model: "gpt-4.1-nano" }, { provider: "google", model: "gemini-2.0-flash" }],
      availableProviders: allProviders,
    });
    expect(pick).not.toBeNull();
    expect(`${pick!.provider}/${pick!.model}`).not.toBe("openai/gpt-4.1-nano");
  });
});

describe("spawnChallengerTest", () => {
  it("creates a non-auto-generated 50/50 A/B test scoped to the cell", async () => {
    const db = await makeTestDb();
    const result = await spawnChallengerTest(db, {
      taskType: "summarization",
      complexity: "simple",
      incumbent: { provider: "openai", model: "gpt-4.1-nano" },
      challenger: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    });

    const test = await db.select().from(abTests).where(eq(abTests.id, result.testId)).get();
    expect(test).toBeDefined();
    expect(test!.autoGenerated).toBe(false);
    expect(test!.status).toBe("active");
    expect(test!.sourceTaskType).toBe("summarization");
    expect(test!.sourceComplexity).toBe("simple");

    const variants = await db
      .select()
      .from(abTestVariants)
      .where(eq(abTestVariants.abTestId, result.testId))
      .all();
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v.weight === 0.5)).toBe(true);
    expect(variants.every((v) => v.taskType === "summarization")).toBe(true);
    expect(variants.every((v) => v.complexity === "simple")).toBe(true);
    const models = new Set(variants.map((v) => v.model));
    expect(models.has("gpt-4.1-nano")).toBe(true);
    expect(models.has("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("scopes to the caller's tenant when tenantId is provided", async () => {
    const db = await makeTestDb();
    const result = await spawnChallengerTest(db, {
      taskType: "qa",
      complexity: "complex",
      incumbent: { provider: "openai", model: "gpt-4.1-mini" },
      challenger: { provider: "google", model: "gemini-2.5-flash" },
      tenantId: "tenant-abc",
    });

    const test = await db.select().from(abTests).where(eq(abTests.id, result.testId)).get();
    expect(test!.tenantId).toBe("tenant-abc");
  });
});

describe("getScoredModelsForCell", () => {
  it("returns provider/model keys for the requested cell", async () => {
    const db = await makeTestDb();
    await seedScore(db, "qa", "simple", "openai", "gpt-4.1-nano", 4.5);
    await seedScore(db, "qa", "simple", "anthropic", "claude-haiku-4-5-20251001", 3.5);
    await seedScore(db, "qa", "complex", "openai", "gpt-4.1-mini", 2.5); // different cell

    const scored = await getScoredModelsForCell(db, "qa", "simple");
    expect(scored.has("openai/gpt-4.1-nano")).toBe(true);
    expect(scored.has("anthropic/claude-haiku-4-5-20251001")).toBe(true);
    expect(scored.has("openai/gpt-4.1-mini")).toBe(false);
  });
});
