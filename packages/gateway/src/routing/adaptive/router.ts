import type { Db } from "@provara/db";
import type { TaskType, Complexity } from "../../classifier/types.js";
import type { RouteTarget } from "../types.js";
import { EMA_ALPHA, ema, getQualityAlpha } from "./ema.js";
import { MIN_SAMPLES, computeRouteScore, getModelCost, resolveWeights } from "./scoring.js";
import { pickExploration } from "./exploration.js";
import { createScoreStore, type ScoreStore } from "./score-store.js";
import { loadScoresFromDb, persistScore } from "./persistence.js";
import type { FeedbackSource, ModelScore, RoutingProfile, RoutingWeights } from "./types.js";

export type AdaptiveRouter = Awaited<ReturnType<typeof createAdaptiveRouter>>;

/**
 * Build an adaptive router wired to `db` as the durable source of truth.
 * The in-memory score store is hydrated at construction time and stays in
 * sync via `updateScore` / `updateLatency`. Single-process constraints
 * apply — see `score-store.ts` for the horizontal-scaling note.
 */
export async function createAdaptiveRouter(db: Db) {
  const store: ScoreStore = createScoreStore();

  async function updateScore(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    newScore: number,
    source: FeedbackSource,
  ): Promise<void> {
    const alpha = getQualityAlpha(source);
    const existing = store.get(taskType, complexity, provider, model);

    let qualityScore: number;
    let sampleCount: number;
    if (existing) {
      existing.qualityScore = ema(existing.qualityScore, newScore, alpha);
      existing.sampleCount++;
      qualityScore = existing.qualityScore;
      sampleCount = existing.sampleCount;
    } else {
      qualityScore = newScore;
      sampleCount = 1;
      store.set(taskType, complexity, {
        provider,
        model,
        qualityScore,
        sampleCount,
        costPer1M: getModelCost(model),
        avgLatencyMs: 0,
      });
    }

    await persistScore(db, taskType, complexity, provider, model, qualityScore, sampleCount);
  }

  function updateLatency(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    latencyMs: number,
  ): void {
    const existing = store.get(taskType, complexity, provider, model);
    if (existing) {
      existing.avgLatencyMs = ema(existing.avgLatencyMs, latencyMs, EMA_ALPHA);
    }
  }

  /**
   * Pick the best model for a cell. Returns `via: "exploration"` when the
   * ε-greedy branch fired (uniform-random from allCandidates, ignoring EMA)
   * and `via: "adaptive"` when the EMA-scoring branch picked the winner.
   * Returns null when no adaptive candidate qualifies and exploration
   * didn't fire — caller falls through to cheapest-first.
   */
  function getBestModel(
    taskType: TaskType,
    complexity: Complexity,
    profile: RoutingProfile,
    availableProviders: Set<string>,
    allCandidates: RouteTarget[],
    customWeights?: RoutingWeights,
  ): { target: RouteTarget; via: "adaptive" | "exploration" } | null {
    const exploration = pickExploration(allCandidates, availableProviders);
    if (exploration) {
      return { target: exploration, via: "exploration" };
    }

    const cellMap = store.getCellMap(taskType, complexity);
    if (!cellMap || cellMap.size === 0) return null;

    const candidates = Array.from(cellMap.values()).filter(
      (s) => s.sampleCount >= MIN_SAMPLES && availableProviders.has(s.provider),
    );
    if (candidates.length === 0) return null;

    const weights = resolveWeights(profile, customWeights);
    let best: { target: RouteTarget; score: number } | null = null;

    for (const candidate of candidates) {
      const score = computeRouteScore(
        candidate.qualityScore,
        candidate.costPer1M,
        candidate.avgLatencyMs,
        weights,
      );
      if (!best || score > best.score) {
        best = { target: { provider: candidate.provider, model: candidate.model }, score };
      }
    }

    return best ? { target: best.target, via: "adaptive" } : null;
  }

  function getCellScores(taskType: string, complexity: string): ModelScore[] {
    return store.getCellScores(taskType, complexity);
  }

  function getAllScores(): { taskType: string; complexity: string; scores: ModelScore[] }[] {
    return store.getAllScores();
  }

  await loadScoresFromDb(db, store);

  return {
    updateScore,
    updateLatency,
    getBestModel,
    getCellScores,
    getAllScores,
    loadScoresFromDb: () => loadScoresFromDb(db, store),
  };
}
