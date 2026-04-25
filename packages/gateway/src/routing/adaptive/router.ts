import type { Db } from "@provara/db";
import type { TaskType, Complexity } from "../../classifier/types.js";
import type { RouteTarget } from "../types.js";
import { EMA_ALPHA, ema, getQualityAlpha } from "./ema.js";
import { MIN_SAMPLES, computeRouteScore, getModelCost, resolveWeights } from "./scoring.js";
import { isStaleTimestamp, pickExploration } from "./exploration.js";
import { LOW_SCORE_THRESHOLD } from "./challenger.js";
import { POOL_KEY, createScoreStore, type ScoreStore } from "./score-store.js";
import { loadScoresFromDb, persistScore } from "./persistence.js";
import { getTenantIsolationPolicy, type IsolationPolicy } from "./isolation-policy.js";
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
 * Tenant scoping plumbing landed in #194 (C1). Tier-aware read fallback
 * and tier-gated writes land here (#195 / C2). Policy is resolved per
 * call via `getTenantIsolationPolicy(db, tenantId)` — no TTL cache yet;
 * see #195 discussion.
 */
export async function createAdaptiveRouter(db: Db, options: AdaptiveRouterOptions = {}) {
  const store: ScoreStore = createScoreStore();
  const getScoreBoost = options.getScoreBoost ?? (() => 0);
  const isCellRegressing = options.isCellRegressing ?? (() => false);

  /** Apply an EMA update to a single (tenantKey, cell) slot — memory + DB. */
  async function applyUpdateTo(
    tenantKey: string | null,
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    newScore: number,
    alpha: number,
    now: Date,
  ): Promise<void> {
    const existing = store.get(taskType, complexity, provider, model, tenantKey);
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
        tenantKey,
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
      tenantKey ?? POOL_KEY,
    );
  }

  /**
   * Feedback-driven EMA update. Routes the update to the tenant row,
   * the pool row, or both, per the tenant's isolation policy. An
   * omitted / nullish `tenantId` is treated as an anonymous caller
   * (pool-only). Self-host and unauthenticated paths also end up here.
   */
  async function updateScore(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    newScore: number,
    source: FeedbackSource,
    tenantId?: string | null,
  ): Promise<void> {
    const policy = await getTenantIsolationPolicy(db, tenantId);
    const alpha = getQualityAlpha(source);
    const now = new Date();

    if (policy.writesTenantRow && tenantId) {
      await applyUpdateTo(tenantId, taskType, complexity, provider, model, newScore, alpha, now);
    }
    if (policy.writesPool) {
      await applyUpdateTo(null, taskType, complexity, provider, model, newScore, alpha, now);
    }
  }

  function updateLatency(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    latencyMs: number,
    tenantId?: string | null,
  ): void {
    // Latency is an in-memory signal, not persisted. Update wherever the
    // request's routing decision was sourced from — see getBestModel's
    // policy gating. For simplicity, update both dimensions if they
    // exist; a stale latency in an unused dimension is harmless.
    const tenantExisting = tenantId
      ? store.get(taskType, complexity, provider, model, tenantId)
      : undefined;
    if (tenantExisting) {
      tenantExisting.avgLatencyMs = ema(tenantExisting.avgLatencyMs, latencyMs, EMA_ALPHA);
    }
    const poolExisting = store.get(taskType, complexity, provider, model);
    if (poolExisting) {
      poolExisting.avgLatencyMs = ema(poolExisting.avgLatencyMs, latencyMs, EMA_ALPHA);
    }
  }

  /** Pure pick-from-a-single-cell, reused for tenant and pool paths. */
  function pickBestFromCell(
    cellMap: Map<string, ModelScore> | undefined,
    availableProviders: Set<string>,
    taskType: string,
    complexity: string,
    profile: RoutingProfile,
    customWeights: RoutingWeights | undefined,
  ): RouteTarget | null {
    if (!cellMap || cellMap.size === 0) return null;
    const candidates = Array.from(cellMap.values()).filter(
      (s) => s.sampleCount >= MIN_SAMPLES && availableProviders.has(s.provider),
    );
    if (candidates.length === 0) return null;

    const weights = resolveWeights(profile, customWeights);
    let best: { target: RouteTarget; score: number } | null = null;
    for (const candidate of candidates) {
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
    return best?.target ?? null;
  }

  /**
   * Pick the best model for a cell. Returns `via: "exploration"` when the
   * ε-greedy branch fired (uniform-random from allCandidates, ignoring EMA)
   * and `via: "adaptive"` when the EMA-scoring branch picked the winner.
   * Returns null when no adaptive candidate qualifies and exploration
   * didn't fire — caller falls through to cheapest-first.
   *
   * Tier-aware fallback: consults the tenant row first (when policy
   * allows), then the pool row (when policy allows). Cells whose
   * most-recent update is older than the stale threshold get a boosted
   * exploration rate so their stored EMA doesn't drift further from
   * current truth (#148).
   */
  async function getBestModel(
    taskType: TaskType,
    complexity: Complexity,
    profile: RoutingProfile,
    availableProviders: Set<string>,
    allCandidates: RouteTarget[],
    customWeights?: RoutingWeights,
    tenantId?: string | null,
  ): Promise<{ target: RouteTarget; via: "adaptive" | "exploration" } | null> {
    const policy = await getTenantIsolationPolicy(db, tenantId);
    const tenantCell =
      policy.readsTenantRow && tenantId ? store.getCellMap(taskType, complexity, tenantId) : undefined;
    const poolCell = policy.readsPool ? store.getCellMap(taskType, complexity) : undefined;

    // Stale/exploration decision uses whichever cell the router will
    // actually consult first. If the tenant row exists with data, it's
    // primary; else the pool row (if the tenant can read it).
    const primaryCell = tenantCell && tenantCell.size > 0 ? tenantCell : poolCell;
    const stale = isCellStale(primaryCell);
    const regressed = isCellRegressing(taskType, complexity);
    // Low-score detection (Track 2 of #lonely-low-cells). A cell qualifies
    // when its top sufficiently-sampled candidate is at or below
    // `LOW_SCORE_THRESHOLD`. The MIN_SAMPLES floor matters here — a
    // 1.0 score on a single sample is noise, not a quality verdict.
    // Tier-gated to Pro+ tenants per the monetization split (#152): free
    // traffic stays on the base 10% rate so the boost is a paid-tier
    // differentiator. Free + anonymous tenants resolve to FREE_POLICY
    // with `tier: "free"`, so the inequality below excludes them.
    const lowScore = policy.tier !== "free" && isLowScoringCell(primaryCell);
    const exploration = pickExploration(allCandidates, availableProviders, {
      stale,
      regressed,
      lowScore,
    });
    if (exploration) {
      return { target: exploration, via: "exploration" };
    }

    const tenantPick = pickBestFromCell(tenantCell, availableProviders, taskType, complexity, profile, customWeights);
    if (tenantPick) return { target: tenantPick, via: "adaptive" };

    const poolPick = pickBestFromCell(poolCell, availableProviders, taskType, complexity, profile, customWeights);
    if (poolPick) return { target: poolPick, via: "adaptive" };

    return null;
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

  /** Resolve the live tier + toggle policy for a tenant. */
  async function getIsolationPolicy(
    tenantId?: string | null,
  ): Promise<IsolationPolicy> {
    return getTenantIsolationPolicy(db, tenantId);
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

  /**
   * The cell's top sufficiently-sampled candidate is at or below
   * `LOW_SCORE_THRESHOLD`. Mirrors the offline detector in
   * `challenger.ts#findLowScoringCells` so the routing-time boost and
   * the dashboard's manual probe agree on what "low" means.
   *
   * Note we only consider models above MIN_SAMPLES — the same floor the
   * EMA-pick step uses. A cold cell (all candidates below the floor)
   * is not "low-score," it's "no signal yet" — exploration still runs
   * via the cold-start branch in `pickExploration` itself.
   */
  function isLowScoringCell(cellMap: Map<string, ModelScore> | undefined): boolean {
    if (!cellMap || cellMap.size === 0) return false;
    let topEligible: number | null = null;
    for (const s of cellMap.values()) {
      if (s.sampleCount < MIN_SAMPLES) continue;
      if (topEligible === null || s.qualityScore > topEligible) {
        topEligible = s.qualityScore;
      }
    }
    if (topEligible === null) return false;
    return topEligible <= LOW_SCORE_THRESHOLD;
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
    getIsolationPolicy,
    isStale,
    lastUpdated,
    loadScoresFromDb: () => loadScoresFromDb(db, store),
  };
}
