import type { ChatMessage } from "../providers/types.js";
import { messageText } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { TaskType, Complexity } from "./types.js";
import { getPricing } from "../cost/index.js";

interface LlmClassification {
  taskType: TaskType;
  complexity: Complexity;
}

const CLASSIFICATION_PROMPT = `Classify the following user message. Respond with ONLY valid JSON, no other text.

{
  "taskType": "coding" | "creative" | "summarization" | "qa" | "general",
  "complexity": "simple" | "medium" | "complex"
}

Task type definitions:
- coding: programming, debugging, code review, technical implementation
- creative: writing, storytelling, brainstorming, content creation
- summarization: condensing, extracting key points, TL;DR
- qa: factual questions, explanations, comparisons, definitions
- general: anything that doesn't fit the above categories

Complexity definitions:
- simple: short answer, single concept, minimal context needed
- medium: moderate reasoning, some context, multi-step but straightforward
- complex: deep analysis, multi-faceted, requires significant reasoning or expertise`;

// Simple hash for cache keys
function hashMessages(messages: ChatMessage[]): string {
  const content = messages.map((m) => `${m.role}:${messageText(m)}`).join("|");
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

const classificationCache = new Map<string, LlmClassification>();
const MAX_CACHE_SIZE = 500;

function findCheapestModel(registry: ProviderRegistry): { provider: string; model: string } | null {
  let cheapest: { provider: string; model: string; cost: number } | null = null;

  for (const provider of registry.list()) {
    for (const model of provider.models) {
      const pricing = getPricing(model);
      if (!pricing) continue;
      const totalCost = pricing[0] + pricing[1]; // input + output per 1M
      if (!cheapest || totalCost < cheapest.cost) {
        cheapest = { provider: provider.name, model, cost: totalCost };
      }
    }
  }

  return cheapest ? { provider: cheapest.provider, model: cheapest.model } : null;
}

const VALID_TASK_TYPES: TaskType[] = ["coding", "creative", "summarization", "qa", "general", "vision"];
const VALID_COMPLEXITIES: Complexity[] = ["simple", "medium", "complex"];

function parseClassification(raw: string): LlmClassification | null {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (
      VALID_TASK_TYPES.includes(parsed.taskType) &&
      VALID_COMPLEXITIES.includes(parsed.complexity)
    ) {
      return { taskType: parsed.taskType, complexity: parsed.complexity };
    }
    return null;
  } catch {
    return null;
  }
}

export async function classifyWithLlm(
  messages: ChatMessage[],
  registry: ProviderRegistry
): Promise<LlmClassification | null> {
  const cacheKey = hashMessages(messages);
  const cached = classificationCache.get(cacheKey);
  if (cached) return cached;

  const target = findCheapestModel(registry);
  if (!target) return null;

  const provider = registry.get(target.provider);
  if (!provider) return null;

  // Build classification request with the last user message
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMessage) return null;

  const classificationMessages: ChatMessage[] = [
    { role: "system", content: CLASSIFICATION_PROMPT },
    { role: "user", content: messageText(lastUserMessage) },
  ];

  try {
    const response = await provider.complete({
      model: target.model,
      messages: classificationMessages,
      temperature: 0,
      max_tokens: 100,
    });

    const result = parseClassification(response.content);
    if (result) {
      // Evict oldest entries if cache is full
      if (classificationCache.size >= MAX_CACHE_SIZE) {
        const firstKey = classificationCache.keys().next().value!;
        classificationCache.delete(firstKey);
      }
      classificationCache.set(cacheKey, result);
      return result;
    }
    return null;
  } catch {
    return null;
  }
}
