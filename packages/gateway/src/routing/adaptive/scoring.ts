import { getPricing } from "../../cost/index.js";
import type { RoutingProfile, RoutingWeights } from "./types.js";

/**
 * Minimum number of samples required before an adaptive candidate is
 * eligible. Prevents the router from relying on one-shot outliers. Lower
 * to 2 during cold-start bootstrapping; raise back to 5+ once cells are
 * well-populated.
 */
export const MIN_SAMPLES = parseInt(process.env.PROVARA_MIN_SAMPLES || "5");

export const PROFILE_WEIGHTS: Record<string, RoutingWeights> = {
  cost: { quality: 0.2, cost: 0.7, latency: 0.1 },
  balanced: { quality: 0.4, cost: 0.4, latency: 0.2 },
  quality: { quality: 0.7, cost: 0.15, latency: 0.15 },
};

export function resolveWeights(profile: RoutingProfile, customWeights?: RoutingWeights): RoutingWeights {
  if (profile === "custom" && customWeights) return customWeights;
  return PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS.balanced;
}

/** Unknown models default to an expensive value so they don't auto-win on cost. */
export function getModelCost(model: string): number {
  const pricing = getPricing(model);
  if (!pricing) return 10;
  return pricing[0] + pricing[1];
}

/**
 * Compose the weighted routing score. Each axis is normalized to 0–1 first:
 * quality is a simple linear rescale of 1–5, cost and latency are log-inverted
 * so "cheaper/faster = higher" with diminishing returns at the extremes.
 */
export function computeRouteScore(
  qualityScore: number,
  costPer1M: number,
  avgLatencyMs: number,
  weights: RoutingWeights,
): number {
  const normalizedQuality = (qualityScore - 1) / 4;
  const normalizedCost = 1 / (1 + Math.log1p(costPer1M));
  const normalizedLatency = 1 / (1 + Math.log1p(avgLatencyMs / 1000));

  return (
    weights.quality * normalizedQuality
    + weights.cost * normalizedCost
    + weights.latency * normalizedLatency
  );
}
