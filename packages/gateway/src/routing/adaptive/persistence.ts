import type { Db } from "@provara/db";
import { feedback, modelScores, requests } from "@provara/db";
import { eq, sql } from "drizzle-orm";
import { getModelCost } from "./scoring.js";
import type { ScoreStore } from "./score-store.js";

/**
 * Hydrate the in-memory score store from the DB. Precedence:
 *
 *   1. `model_scores` rows — authoritative live EMA persisted across restarts.
 *   2. `feedback` aggregation — seed for cells that have feedback history
 *      but no `model_scores` row yet (first boot after the table was added,
 *      or cells that predate live learning). Once `updateScore` fires for
 *      a cell, step 2 no longer applies to it.
 *
 * Latency EMA is seeded from the rolling average of logged requests, since
 * it's never written to `model_scores`.
 */
export async function loadScoresFromDb(db: Db, store: ScoreStore): Promise<void> {
  const persisted = await db
    .select({
      taskType: modelScores.taskType,
      complexity: modelScores.complexity,
      provider: modelScores.provider,
      model: modelScores.model,
      qualityScore: modelScores.qualityScore,
      sampleCount: modelScores.sampleCount,
    })
    .from(modelScores)
    .all();

  for (const row of persisted) {
    const cell = store.ensureCell(row.taskType, row.complexity);
    cell.set(`${row.provider}:${row.model}`, {
      provider: row.provider,
      model: row.model,
      qualityScore: row.qualityScore,
      sampleCount: row.sampleCount,
      costPer1M: getModelCost(row.model),
      avgLatencyMs: 0,
    });
  }

  const feedbackRows = await db
    .select({
      provider: requests.provider,
      model: requests.model,
      taskType: requests.taskType,
      complexity: requests.complexity,
      avgScore: sql<number>`avg(${feedback.score})`,
      count: sql<number>`count(*)`,
    })
    .from(feedback)
    .innerJoin(requests, eq(feedback.requestId, requests.id))
    .groupBy(requests.provider, requests.model, requests.taskType, requests.complexity)
    .all();

  for (const row of feedbackRows) {
    if (!row.taskType || !row.complexity) continue;
    const cell = store.ensureCell(row.taskType, row.complexity);
    const mk = `${row.provider}:${row.model}`;
    // Skip cells that already have a persisted EMA — that takes precedence.
    if (cell.has(mk)) continue;
    cell.set(mk, {
      provider: row.provider,
      model: row.model,
      qualityScore: row.avgScore,
      sampleCount: row.count,
      costPer1M: getModelCost(row.model),
      avgLatencyMs: 0,
    });
  }

  const latencyRows = await db
    .select({
      provider: requests.provider,
      model: requests.model,
      taskType: requests.taskType,
      complexity: requests.complexity,
      avgLatency: sql<number>`avg(${requests.latencyMs})`,
    })
    .from(requests)
    .groupBy(requests.provider, requests.model, requests.taskType, requests.complexity)
    .all();

  for (const row of latencyRows) {
    if (!row.taskType || !row.complexity) continue;
    const existing = store.get(row.taskType, row.complexity, row.provider, row.model);
    if (existing) {
      existing.avgLatencyMs = row.avgLatency || 0;
    }
  }
}

/**
 * Upsert a single `model_scores` row. Composite primary key is
 * (taskType, complexity, provider, model) — conflict on any of those
 * updates the score in place rather than inserting a duplicate.
 */
export async function persistScore(
  db: Db,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  qualityScore: number,
  sampleCount: number,
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(modelScores)
    .values({ taskType, complexity, provider, model, qualityScore, sampleCount, updatedAt })
    .onConflictDoUpdate({
      target: [modelScores.taskType, modelScores.complexity, modelScores.provider, modelScores.model],
      set: { qualityScore, sampleCount, updatedAt },
    })
    .run();
}
