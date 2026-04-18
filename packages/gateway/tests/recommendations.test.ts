import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@provara/db";
import { costLogs, modelScores, requests } from "@provara/db";
import { nanoid } from "nanoid";
import { makeTestDb } from "./_setup/db.js";
import {
  computeRecommendations,
  MIN_ALT_SAMPLES,
  MIN_CELL_VOLUME,
} from "../src/routing/recommendations.js";

async function seedScore(
  db: Db,
  tenantId: string,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  qualityScore: number,
  sampleCount: number,
) {
  await db.insert(modelScores).values({
    tenantId, taskType, complexity, provider, model,
    qualityScore, sampleCount, updatedAt: new Date(),
  }).run();
}

async function seedRequests(
  db: Db,
  tenantId: string,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  count: number,
  inputTokens: number,
  outputTokens: number,
  costPerReq: number,
) {
  for (let i = 0; i < count; i++) {
    const id = `${provider}-${model}-${i}-${nanoid(4)}`;
    await db.insert(requests).values({
      id,
      provider,
      model,
      prompt: "[]",
      taskType,
      complexity,
      inputTokens,
      outputTokens,
      tenantId,
      createdAt: new Date(Date.now() - i * 60_000),
    }).run();
    await db.insert(costLogs).values({
      id: `cl-${id}`,
      requestId: id,
      tenantId,
      provider,
      model,
      inputTokens,
      outputTokens,
      cost: costPerReq,
      createdAt: new Date(Date.now() - i * 60_000),
    }).run();
  }
}

describe("#219/T6 — savings recommendations", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns empty when no requests are in the lookback window", async () => {
    const recs = await computeRecommendations(db, "t1");
    expect(recs).toEqual([]);
  });

  it("ranks a cheaper alternate when quality is within delta threshold", async () => {
    // Cell: coding / hard
    // Winner: claude-sonnet-4-6 at 50 reqs, $0.02/req
    // Candidate: gpt-4.1-mini at quality 0.74 (delta 0.02 ≤ 0.05), 25 samples
    const winnerInput = 200, winnerOutput = 300;
    await seedRequests(
      db, "t1", "coding", "hard",
      "anthropic", "claude-sonnet-4-6",
      50, winnerInput, winnerOutput, 0.02,
    );
    await seedScore(db, "t1", "coding", "hard", "anthropic", "claude-sonnet-4-6", 0.76, 40);
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-mini", 0.74, 25);

    const recs = await computeRecommendations(db, "t1");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      task_type: "coding",
      complexity: "hard",
      from_model: "claude-sonnet-4-6",
      to_model: "gpt-4.1-mini",
      monthly_volume: 50,
      confidence_samples: 25,
    });
    expect(recs[0].quality_delta).toBeCloseTo(0.02, 4);
    expect(recs[0].estimated_monthly_savings).toBeGreaterThan(0);
  });

  it("drops candidates whose quality_delta exceeds 0.05", async () => {
    const winnerInput = 200, winnerOutput = 300;
    await seedRequests(
      db, "t1", "coding", "hard",
      "anthropic", "claude-sonnet-4-6",
      50, winnerInput, winnerOutput, 0.02,
    );
    await seedScore(db, "t1", "coding", "hard", "anthropic", "claude-sonnet-4-6", 0.80, 40);
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-mini", 0.70, 25); // delta 0.10

    const recs = await computeRecommendations(db, "t1");
    expect(recs).toEqual([]);
  });

  it(`skips cells with fewer than ${MIN_CELL_VOLUME} requests on the winner`, async () => {
    await seedRequests(
      db, "t1", "coding", "hard",
      "anthropic", "claude-sonnet-4-6",
      MIN_CELL_VOLUME - 1, 200, 300, 0.02,
    );
    await seedScore(db, "t1", "coding", "hard", "anthropic", "claude-sonnet-4-6", 0.76, 40);
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-mini", 0.74, 40);

    const recs = await computeRecommendations(db, "t1");
    expect(recs).toEqual([]);
  });

  it(`skips candidates with fewer than ${MIN_ALT_SAMPLES} quality samples`, async () => {
    await seedRequests(
      db, "t1", "coding", "hard",
      "anthropic", "claude-sonnet-4-6",
      50, 200, 300, 0.02,
    );
    await seedScore(db, "t1", "coding", "hard", "anthropic", "claude-sonnet-4-6", 0.76, 40);
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-mini", 0.74, MIN_ALT_SAMPLES - 1);

    const recs = await computeRecommendations(db, "t1");
    expect(recs).toEqual([]);
  });

  it("skips candidates whose modeled cost per request is not cheaper", async () => {
    // Winner = cheap; candidate = expensive.
    await seedRequests(
      db, "t1", "coding", "hard",
      "openai", "gpt-4.1-nano",
      50, 200, 300, 0.001,
    );
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-nano", 0.74, 40);
    await seedScore(db, "t1", "coding", "hard", "anthropic", "claude-sonnet-4-6", 0.76, 40);

    const recs = await computeRecommendations(db, "t1");
    expect(recs).toEqual([]);
  });

  it("ranks multiple recommendations by estimated monthly savings DESC", async () => {
    // High-volume cell with two qualifying alternates at different prices.
    await seedRequests(
      db, "t1", "coding", "hard",
      "anthropic", "claude-sonnet-4-6",
      100, 300, 400, 0.03,
    );
    await seedScore(db, "t1", "coding", "hard", "anthropic", "claude-sonnet-4-6", 0.78, 40);
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-mini", 0.75, 40);
    await seedScore(db, "t1", "coding", "hard", "openai", "gpt-4.1-nano", 0.74, 40);

    const recs = await computeRecommendations(db, "t1");
    expect(recs.length).toBeGreaterThanOrEqual(2);
    // Nano should edge out mini on savings since it's cheaper per req.
    expect(recs[0].to_model).toBe("gpt-4.1-nano");
    expect(recs[0].estimated_monthly_savings).toBeGreaterThanOrEqual(
      recs[1].estimated_monthly_savings,
    );
  });
});
