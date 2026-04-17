export { createAdaptiveRouter, type AdaptiveRouter } from "./router.js";
export type { FeedbackSource, ModelScore, RoutingProfile, RoutingWeights } from "./types.js";
export { resolveWeights, computeRouteScore, PROFILE_WEIGHTS, MIN_SAMPLES } from "./scoring.js";
export { ema, getQualityAlpha, EMA_ALPHA } from "./ema.js";
export { pickExploration, EXPLORATION_RATE } from "./exploration.js";
