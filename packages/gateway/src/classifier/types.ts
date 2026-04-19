export type TaskType = "coding" | "creative" | "summarization" | "qa" | "general" | "vision";
export type Complexity = "simple" | "medium" | "complex";

export interface ClassificationResult<T> {
  value: T;
  confidence: number; // 0-1
  ambiguous: boolean;
}

export interface FullClassification {
  taskType: TaskType;
  complexity: Complexity;
  taskConfidence: number;
  complexityConfidence: number;
  usedLlmFallback: boolean;
}
