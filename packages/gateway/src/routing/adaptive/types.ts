export type FeedbackSource = "user" | "judge";

export type RoutingProfile = "cost" | "balanced" | "quality" | "custom";

export interface RoutingWeights {
  quality: number;
  cost: number;
  latency: number;
}

export interface ModelScore {
  provider: string;
  model: string;
  /** EMA of feedback scores (1-5 scale). */
  qualityScore: number;
  sampleCount: number;
  /** Input + output price per 1M tokens. */
  costPer1M: number;
  /** EMA of observed latency in ms. */
  avgLatencyMs: number;
  /** Last time this score was updated. Null for rows seeded purely from
   *  pre-EMA feedback aggregation. Used to detect stale cells and force
   *  exploration on them. */
  updatedAt?: Date | null;
}
