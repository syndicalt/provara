import type { FeedbackSource } from "./types.js";

/**
 * Parse a numeric env var safely. Returns `fallback` when the var is unset,
 * empty, or not a valid number. The raw `parseFloat(process.env.X || "0.2")`
 * pattern silently yields NaN on an empty-string value — which poisons
 * every downstream calculation. This helper clamps that to the default.
 */
function numFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * EMA decay factor used for latency tracking and as the global override for
 * quality EMA when per-source vars are unset. 0.1 = slow adaptation,
 * 0.3 = moderate, 0.5 = fast.
 */
export const EMA_ALPHA = numFromEnv(process.env.PROVARA_EMA_ALPHA, 0.2);

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
  if (specific !== undefined && specific !== "") {
    const parsed = parseFloat(specific);
    if (Number.isFinite(parsed)) return parsed;
  }
  const global = process.env.PROVARA_EMA_ALPHA;
  if (global !== undefined && global !== "") {
    const parsed = parseFloat(global);
    if (Number.isFinite(parsed)) return parsed;
  }
  return source === "user" ? 0.4 : 0.2;
}
