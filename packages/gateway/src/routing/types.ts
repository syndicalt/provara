import type { TaskType, Complexity } from "../classifier/types.js";

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface RouteEntry {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
}

export type RoutingTable = Record<TaskType, Record<Complexity, RouteEntry>>;

export interface RoutingResult {
  provider: string;
  model: string;
  taskType: TaskType;
  complexity: Complexity;
  routedBy: "classification" | "user-override" | "routing-hint" | "ab-test";
  abTestId?: string;
  usedFallback: boolean;
  usedLlmFallback: boolean;
}
