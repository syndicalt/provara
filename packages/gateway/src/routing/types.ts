import type { TaskType, Complexity } from "../classifier/types.js";

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface RoutingResult {
  provider: string;
  model: string;
  taskType: TaskType;
  complexity: Complexity;
  routedBy: "classification" | "user-override" | "routing-hint" | "ab-test" | "adaptive" | "exploration";
  abTestId?: string;
  usedFallback: boolean;
  usedLlmFallback: boolean;
  fallbacks: RouteTarget[];
}
