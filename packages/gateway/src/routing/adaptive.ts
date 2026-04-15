import type { Db } from "@provara/db";
import { feedback, requests } from "@provara/db";
import { eq, sql } from "drizzle-orm";
import type { TaskType, Complexity } from "../classifier/types.js";
import type { RouteTarget } from "./types.js";
import { getPricing } from "../cost/index.js";

// EMA decay factor: 0.1 = slow adaptation, 0.3 = moderate, 0.5 = fast
const EMA_ALPHA = parseFloat(process.env.PROVARA_EMA_ALPHA || "0.2");
const MIN_SAMPLES = parseInt(process.env.PROVARA_MIN_SAMPLES || "5");

export type RoutingProfile = "cost" | "balanced" | "quality" | "custom";

export interface RoutingWeights {
  quality: number;
  cost: number;
  latency: number;
}

export interface ModelScore {
  provider: string;
  model: string;
  qualityScore: number; // EMA of feedback scores (1-5)
  sampleCount: number;
  costPer1M: number; // input + output per 1M tokens
  avgLatencyMs: number; // EMA of latency
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

// Profile weight presets: quality, cost, latency
const PROFILE_WEIGHTS: Record<string, RoutingWeights> = {
  cost: { quality: 0.2, cost: 0.7, latency: 0.1 },
  balanced: { quality: 0.4, cost: 0.4, latency: 0.2 },
  quality: { quality: 0.7, cost: 0.15, latency: 0.15 },
};

export function resolveWeights(profile: RoutingProfile, customWeights?: RoutingWeights): RoutingWeights {
  if (profile === "custom" && customWeights) return customWeights;
  return PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS.balanced;
}

function computeRouteScore(
  qualityScore: number,
  costPer1M: number,
  avgLatencyMs: number,
  weights: RoutingWeights
): number {
  // Normalize quality to 0-1 (from 1-5 scale)
  const normalizedQuality = (qualityScore - 1) / 4;
  // Normalize cost inversely: cheaper = higher score
  const normalizedCost = 1 / (1 + Math.log1p(costPer1M));
  // Normalize latency inversely: faster = higher score
  const normalizedLatency = 1 / (1 + Math.log1p(avgLatencyMs / 1000));

  return weights.quality * normalizedQuality + weights.cost * normalizedCost + weights.latency * normalizedLatency;
}

export async function createAdaptiveRouter(db: Db) {
  // Load initial scores from existing feedback data
  async function loadScoresFromDb(): Promise<void> {
    const rows = await db
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
        avgLatencyMs: 0, // Will be populated by updateLatency calls
      });
    }

    // Load latency data separately
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
      const ck = cellKey(row.taskType, row.complexity);
      const mk = modelKey(row.provider, row.model);
      const cellScores = emaScores.get(ck);
      if (cellScores) {
        const existing = cellScores.get(mk);
        if (existing) {
          existing.avgLatencyMs = row.avgLatency || 0;
        }
      }
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
      existing.qualityScore = EMA_ALPHA * newScore + (1 - EMA_ALPHA) * existing.qualityScore;
      existing.sampleCount++;
    } else {
      cellScores.set(mk, {
        provider,
        model,
        qualityScore: newScore,
        sampleCount: 1,
        costPer1M: getModelCost(model),
        avgLatencyMs: 0,
      });
    }
  }

  // Update latency EMA after each request
  function updateLatency(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    latencyMs: number
  ): void {
    const ck = cellKey(taskType, complexity);
    const mk = modelKey(provider, model);

    if (!emaScores.has(ck)) emaScores.set(ck, new Map());
    const cellScores = emaScores.get(ck)!;

    const existing = cellScores.get(mk);
    if (existing) {
      existing.avgLatencyMs = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * existing.avgLatencyMs;
    }
  }

  // Get the best model for a routing cell, considering quality scores and profile
  function getBestModel(
    taskType: TaskType,
    complexity: Complexity,
    profile: RoutingProfile,
    availableProviders: Set<string>,
    customWeights?: RoutingWeights
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
    const weights = resolveWeights(profile, customWeights);
    let best: { target: RouteTarget; score: number } | null = null;

    for (const candidate of candidates) {
      const score = computeRouteScore(candidate.qualityScore, candidate.costPer1M, candidate.avgLatencyMs, weights);
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
  await loadScoresFromDb();

  return {
    updateScore,
    updateLatency,
    getBestModel,
    getCellScores,
    getAllScores,
    loadScoresFromDb,
  };
}
