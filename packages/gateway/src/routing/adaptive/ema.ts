import type { FeedbackSource } from "./types.js";

/**
 * EMA decay factor used for latency tracking and as the global override for
 * quality EMA when per-source vars are unset. 0.1 = slow adaptation,
 * 0.3 = moderate, 0.5 = fast.
 */
export const EMA_ALPHA = parseFloat(process.env.PROVARA_EMA_ALPHA || "0.2");

/**
 * Standard exponentially weighted moving average step.
 * `alpha * newValue + (1 - alpha) * oldValue`.
 */
export function ema(oldValue: number, newValue: number, alpha: number): number {
  return alpha * newValue + (1 - alpha) * oldValue;
}

/**
 * Quality EMA alpha by feedback source. User ratings move the needle harder
 * than judge scores because a human explicitly taking the action to rate is
 * a stronger signal than an automated sample. Per-source overrides take
 * precedence over the global PROVARA_EMA_ALPHA when both are set.
 */
export function getQualityAlpha(source: FeedbackSource): number {
  const envVar = source === "user" ? "PROVARA_EMA_ALPHA_USER" : "PROVARA_EMA_ALPHA_JUDGE";
  const specific = process.env[envVar];
  if (specific !== undefined) return parseFloat(specific);
  if (process.env.PROVARA_EMA_ALPHA !== undefined) return parseFloat(process.env.PROVARA_EMA_ALPHA);
  return source === "user" ? 0.4 : 0.2;
}
