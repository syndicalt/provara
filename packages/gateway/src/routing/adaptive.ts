import type { Db } from "@provara/db";
import { feedback, requests } from "@provara/db";
import { eq, sql } from "drizzle-orm";
import type { TaskType, Complexity } from "../classifier/types.js";
import type { RouteTarget } from "./types.js";
import { getPricing } from "../cost/index.js";

// EMA decay factor: 0.1 = slow adaptation, 0.3 = moderate, 0.5 = fast
const EMA_ALPHA = parseFloat(process.env.PROVARA_EMA_ALPHA || "0.2");
const MIN_SAMPLES = parseInt(process.env.PROVARA_MIN_SAMPLES || "5");

export type RoutingProfile = "cost" | "balanced" | "quality";

export interface ModelScore {
  provider: string;
  model: string;
  qualityScore: number; // EMA of feedback scores (1-5)
  sampleCount: number;
  costPer1M: number; // input + output per 1M tokens
}

// In-memory EMA scores per cell
const emaScores = new Map<string, Map<string, ModelScore>>();

function cellKey(taskType: string, complexity: string): string {
  return `${taskType}:${complexity}`;
}

function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function getModelCost(model: string): number {
  const pricing = getPricing(model);
  if (!pricing) return 10; // Expensive default for unknown models
  return pricing[0] + pricing[1];
}

// Profile weight multipliers: how much to weight quality vs cost
// Higher quality weight = prefer higher-scoring models regardless of cost
const PROFILE_WEIGHTS: Record<RoutingProfile, { quality: number; cost: number }> = {
  cost: { quality: 0.3, cost: 0.7 },
  balanced: { quality: 0.5, cost: 0.5 },
  quality: { quality: 0.8, cost: 0.2 },
};

function computeRouteScore(
  qualityScore: number,
  costPer1M: number,
  profile: RoutingProfile
): number {
  const weights = PROFILE_WEIGHTS[profile];
  // Normalize quality to 0-1 (from 1-5 scale)
  const normalizedQuality = (qualityScore - 1) / 4;
  // Normalize cost inversely: cheaper = higher score
  // Use log scale to prevent extreme outliers
  const normalizedCost = 1 / (1 + Math.log1p(costPer1M));

  return weights.quality * normalizedQuality + weights.cost * normalizedCost;
}

export function createAdaptiveRouter(db: Db) {
  // Load initial scores from existing feedback data
  function loadScoresFromDb(): void {
    const rows = db
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

    for (const row of rows) {
      if (!row.taskType || !row.complexity) continue;
      const ck = cellKey(row.taskType, row.complexity);
      const mk = modelKey(row.provider, row.model);

      if (!emaScores.has(ck)) emaScores.set(ck, new Map());
      const cellScores = emaScores.get(ck)!;

      cellScores.set(mk, {
        provider: row.provider,
        model: row.model,
        qualityScore: row.avgScore,
        sampleCount: row.count,
        costPer1M: getModelCost(row.model),
      });
    }
  }

  // Update EMA score when new feedback arrives
  function updateScore(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    newScore: number
  ): void {
    const ck = cellKey(taskType, complexity);
    const mk = modelKey(provider, model);

    if (!emaScores.has(ck)) emaScores.set(ck, new Map());
    const cellScores = emaScores.get(ck)!;

    const existing = cellScores.get(mk);
    if (existing) {
      // EMA update: new = alpha * latest + (1 - alpha) * previous
      existing.qualityScore = EMA_ALPHA * newScore + (1 - EMA_ALPHA) * existing.qualityScore;
      existing.sampleCount++;
    } else {
      cellScores.set(mk, {
        provider,
        model,
        qualityScore: newScore,
        sampleCount: 1,
        costPer1M: getModelCost(model),
      });
    }
  }

  // Get the best model for a routing cell, considering quality scores and profile
  function getBestModel(
    taskType: TaskType,
    complexity: Complexity,
    profile: RoutingProfile,
    availableProviders: Set<string>
  ): RouteTarget | null {
    const ck = cellKey(taskType, complexity);
    const cellScores = emaScores.get(ck);

    // Not enough data — fall back to static table
    if (!cellScores || cellScores.size === 0) return null;

    // Filter to models with enough samples and available providers
    const candidates = Array.from(cellScores.values()).filter(
      (s) => s.sampleCount >= MIN_SAMPLES && availableProviders.has(s.provider)
    );

    if (candidates.length === 0) return null;

    // Score each candidate using profile weights
    let best: { target: RouteTarget; score: number } | null = null;

    for (const candidate of candidates) {
      const score = computeRouteScore(candidate.qualityScore, candidate.costPer1M, profile);
      if (!best || score > best.score) {
        best = {
          target: { provider: candidate.provider, model: candidate.model },
          score,
        };
      }
    }

    return best?.target || null;
  }

  // Get all scores for a cell (for dashboard display)
  function getCellScores(taskType: string, complexity: string): ModelScore[] {
    const ck = cellKey(taskType, complexity);
    const cellScores = emaScores.get(ck);
    if (!cellScores) return [];
    return Array.from(cellScores.values());
  }

  // Get all scores across all cells
  function getAllScores(): { taskType: string; complexity: string; scores: ModelScore[] }[] {
    const result: { taskType: string; complexity: string; scores: ModelScore[] }[] = [];
    for (const [ck, cellScores] of emaScores) {
      const [taskType, complexity] = ck.split(":");
      result.push({
        taskType,
        complexity,
        scores: Array.from(cellScores.values()),
      });
    }
    return result;
  }

  // Initialize from DB on startup
  loadScoresFromDb();

  return {
    updateScore,
    getBestModel,
    getCellScores,
    getAllScores,
    loadScoresFromDb,
  };
}
