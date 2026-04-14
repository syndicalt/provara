import type { ChatMessage } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { FullClassification } from "./types.js";
import { classifyTaskType } from "./task-classifier.js";
import { classifyComplexity } from "./complexity-classifier.js";
import { classifyWithLlm } from "./llm-fallback.js";

export type { TaskType, Complexity, FullClassification } from "./types.js";

export async function classifyRequest(
  messages: ChatMessage[],
  registry: ProviderRegistry
): Promise<FullClassification> {
  const taskResult = classifyTaskType(messages);
  const complexityResult = classifyComplexity(messages);

  // If both are confident, return heuristic results
  if (!taskResult.ambiguous && !complexityResult.ambiguous) {
    return {
      taskType: taskResult.value,
      complexity: complexityResult.value,
      taskConfidence: taskResult.confidence,
      complexityConfidence: complexityResult.confidence,
      usedLlmFallback: false,
    };
  }

  // Try LLM fallback for ambiguous classifications
  const llmResult = await classifyWithLlm(messages, registry);

  if (llmResult) {
    return {
      taskType: taskResult.ambiguous ? llmResult.taskType : taskResult.value,
      complexity: complexityResult.ambiguous ? llmResult.complexity : complexityResult.value,
      taskConfidence: taskResult.ambiguous ? 0.8 : taskResult.confidence,
      complexityConfidence: complexityResult.ambiguous ? 0.8 : complexityResult.confidence,
      usedLlmFallback: true,
    };
  }

  // LLM fallback failed — use heuristic results as-is
  return {
    taskType: taskResult.value,
    complexity: complexityResult.value,
    taskConfidence: taskResult.confidence,
    complexityConfidence: complexityResult.confidence,
    usedLlmFallback: false,
  };
}
