import type { Db } from "@provara/db";
import type { TaskType, Complexity } from "../../classifier/types.js";
import type { RouteTarget } from "../types.js";
import { EMA_ALPHA, ema, getQualityAlpha } from "./ema.js";
import { MIN_SAMPLES, computeRouteScore, getModelCost, resolveWeights } from "./scoring.js";
import { isStaleTimestamp, pickExploration } from "./exploration.js";
import { POOL_KEY, createScoreStore, type ScoreStore } from "./score-store.js";
import { loadScoresFromDb, persistScore } from "./persistence.js";
import type { FeedbackSource, ModelScore, RoutingProfile, RoutingWeights } from "./types.js";

export type AdaptiveRouter = Awaited<ReturnType<typeof createAdaptiveRouter>>;

/**
 * Optional quality-score boost lookup, e.g. the grace boost added by
 * #153 cost migrations. When unset, no boost is applied. Kept as a
 * callback so the router doesn't need to know about migration state
 * directly — whoever constructs the router wires this in.
 *
 * `isCellRegressing` (#163) is the companion callback for the regression-
 * event table. When true for a cell, the router uses the higher
 * `REGRESSED_EXPLORATION_RATE` to accelerate discovery of alternatives
 * after a regression has been detected.
 */
export interface AdaptiveRouterOptions {
  getScoreBoost?: (taskType: string, complexity: string, provider: string, model: string) => number;
  isCellRegressing?: (taskType: string, complexity: string) => boolean;
}

/**
 * Build an adaptive router wired to `db` as the durable source of truth.
 * The in-memory score store is hydrated at construction time and stays in
 * sync via `updateScore` / `updateLatency`. Single-process constraints
 * apply — see `score-store.ts` for the horizontal-scaling note.
 *
 * Tenant scoping added by #194 (C1 of #176). All public methods accept an
 * optional trailing `tenantId`; omitting it (or passing `null`/`undefined`)
 * operates on the shared pool — identical to pre-#176 behavior. Call sites
 * that actually want tenant-aware routing live in C2 (#195).
 */
export async function createAdaptiveRouter(db: Db, options: AdaptiveRouterOptions = {}) {
  const store: ScoreStore = createScoreStore();
  const getScoreBoost = options.getScoreBoost ?? (() => 0);
  const isCellRegressing = options.isCellRegressing ?? (() => false);

  async function updateScore(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    newScore: number,
    source: FeedbackSource,
    tenantId?: string | null,
  ): Promise<void> {
    const alpha = getQualityAlpha(source);
    const existing = store.get(taskType, complexity, provider, model, tenantId);
    const now = new Date();

    let qualityScore: number;
    let sampleCount: number;
    if (existing) {
      existing.qualityScore = ema(existing.qualityScore, newScore, alpha);
      existing.sampleCount++;
      existing.updatedAt = now;
      qualityScore = existing.qualityScore;
      sampleCount = existing.sampleCount;
    } else {
      qualityScore = newScore;
      sampleCount = 1;
      store.set(
        taskType,
        complexity,
        {
          provider,
          model,
          qualityScore,
          sampleCount,
          costPer1M: getModelCost(model),
          avgLatencyMs: 0,
          updatedAt: now,
        },
        tenantId,
      );
    }

    await persistScore(
      db,
      taskType,
      complexity,
      provider,
      model,
      qualityScore,
      sampleCount,
      tenantId ?? POOL_KEY,
    );
  }

  function updateLatency(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    latencyMs: number,
    tenantId?: string | null,
  ): void {
    const existing = store.get(taskType, complexity, provider, model, tenantId);
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
   *
   * Cells whose most-recent update is older than the stale threshold get
   * a boosted exploration rate so their stored EMA doesn't drift further
   * from current truth. See #148.
   */
  function getBestModel(
    taskType: TaskType,
    complexity: Complexity,
    profile: RoutingProfile,
    availableProviders: Set<string>,
    allCandidates: RouteTarget[],
    customWeights?: RoutingWeights,
    tenantId?: string | null,
  ): { target: RouteTarget; via: "adaptive" | "exploration" } | null {
    const cellMap = store.getCellMap(taskType, complexity, tenantId);
    const stale = isCellStale(cellMap);
    const regressed = isCellRegressing(taskType, complexity);
    const exploration = pickExploration(allCandidates, availableProviders, { stale, regressed });
    if (exploration) {
      return { target: exploration, via: "exploration" };
    }

    if (!cellMap || cellMap.size === 0) return null;

    const candidates = Array.from(cellMap.values()).filter(
      (s) => s.sampleCount >= MIN_SAMPLES && availableProviders.has(s.provider),
    );
    if (candidates.length === 0) return null;

    const weights = resolveWeights(profile, customWeights);
    let best: { target: RouteTarget; score: number } | null = null;

    for (const candidate of candidates) {
      // Grace boost (#153) nudges migration targets up during their window
      // without mutating the underlying EMA — normal routing wins back if
      // the migration picked wrong once the boost expires.
      const boost = getScoreBoost(taskType, complexity, candidate.provider, candidate.model);
      const score = computeRouteScore(
        candidate.qualityScore + boost,
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

  function getCellScores(
    taskType: string,
    complexity: string,
    tenantId?: string | null,
  ): ModelScore[] {
    return store.getCellScores(taskType, complexity, tenantId);
  }

  function getAllScores(
    tenantId?: string | null,
  ): { taskType: string; complexity: string; scores: ModelScore[] }[] {
    return store.getAllScores(tenantId);
  }

  /**
   * Most-recent `updatedAt` across all models in a cell, or null if the
   * cell has no timestamps (e.g. feedback-seeded, never updated through
   * `updateScore`). `isCellStale` builds on this.
   */
  function cellLastUpdated(cellMap: Map<string, ModelScore> | undefined): Date | null {
    if (!cellMap || cellMap.size === 0) return null;
    let mostRecent: Date | null = null;
    for (const s of cellMap.values()) {
      if (!s.updatedAt) continue;
      if (!mostRecent || s.updatedAt.getTime() > mostRecent.getTime()) {
        mostRecent = s.updatedAt;
      }
    }
    return mostRecent;
  }

  function isCellStale(cellMap: Map<string, ModelScore> | undefined): boolean {
    return isStaleTimestamp(cellLastUpdated(cellMap));
  }

  /** Public read for analytics/UI: is this cell past the stale threshold? */
  function isStale(taskType: string, complexity: string, tenantId?: string | null): boolean {
    return isCellStale(store.getCellMap(taskType, complexity, tenantId));
  }

  /** Public read for analytics/UI: the cell's most-recent updatedAt. */
  function lastUpdated(
    taskType: string,
    complexity: string,
    tenantId?: string | null,
  ): Date | null {
    return cellLastUpdated(store.getCellMap(taskType, complexity, tenantId));
  }

  await loadScoresFromDb(db, store);

  return {
    updateScore,
    updateLatency,
    getBestModel,
    getCellScores,
    getAllScores,
    isStale,
    lastUpdated,
    loadScoresFromDb: () => loadScoresFromDb(db, store),
  };
}
