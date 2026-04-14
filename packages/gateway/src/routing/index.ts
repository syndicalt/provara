import type { ChatMessage } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { Db } from "@provara/db";
import { abTests, abTestVariants } from "@provara/db";
import { eq } from "drizzle-orm";
import type { TaskType, Complexity } from "../classifier/types.js";
import type { RoutingResult, RouteTarget } from "./types.js";
import { classifyRequest } from "../classifier/index.js";
import { selectVariant } from "../ab/index.js";
import { createAdaptiveRouter, type RoutingProfile } from "./adaptive.js";
import { getPricing } from "../cost/index.js";

export type { RoutingResult, RouteTarget } from "./types.js";
export { type RoutingProfile } from "./adaptive.js";

export interface RoutingEngineConfig {
  registry: ProviderRegistry;
  db: Db;
}

export interface RoutingRequest {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  routingHint?: TaskType;
  routingProfile?: RoutingProfile;
}

export function createRoutingEngine(config: RoutingEngineConfig) {
  const adaptive = createAdaptiveRouter(config.db);

  // Build dynamic fallback chain from all registered providers, sorted by cost (cheapest first)
  function buildDynamicFallbacks(registry: ProviderRegistry): RouteTarget[] {
    const targets: { provider: string; model: string; cost: number }[] = [];

    for (const provider of registry.list()) {
      for (const model of provider.models) {
        const pricing = getPricing(model);
        const cost = pricing ? pricing[0] + pricing[1] : 999;
        targets.push({ provider: provider.name, model, cost });
      }
    }

    // Sort cheapest first
    targets.sort((a, b) => a.cost - b.cost);
    return targets.map(({ provider, model }) => ({ provider, model }));
  }

  function findActiveAbTest(
    taskType: TaskType,
    complexity: Complexity
  ): { testId: string; provider: string; model: string } | null {
    const activeTests = config.db
      .select()
      .from(abTests)
      .where(eq(abTests.status, "active"))
      .all();

    for (const test of activeTests) {
      const variants = config.db
        .select()
        .from(abTestVariants)
        .where(eq(abTestVariants.abTestId, test.id))
        .all();

      const scopedVariants = variants.filter((v) => {
        if (v.taskType && v.taskType !== taskType) return false;
        if (v.complexity && v.complexity !== complexity) return false;
        return true;
      });

      const applicableVariants =
        scopedVariants.length > 0
          ? scopedVariants
          : variants.every((v) => !v.taskType && !v.complexity)
            ? variants
            : [];

      if (applicableVariants.length >= 2) {
        const selected = selectVariant(
          applicableVariants.map((v) => ({
            id: v.id,
            provider: v.provider,
            model: v.model,
            weight: v.weight,
          }))
        );
        return { testId: test.id, provider: selected.provider, model: selected.model };
      }
    }

    return null;
  }

  async function route(request: RoutingRequest): Promise<RoutingResult> {
    const allFallbacks = buildDynamicFallbacks(config.registry);

    // User override: explicit provider + model bypasses routing entirely
    if (request.provider && request.model) {
      return {
        provider: request.provider,
        model: request.model,
        taskType: "general",
        complexity: "medium",
        routedBy: "user-override",
        usedFallback: false,
        usedLlmFallback: false,
        fallbacks: allFallbacks.filter(
          (t) => !(t.provider === request.provider && t.model === request.model)
        ),
      };
    }

    // User specified just a model — find its provider but skip classification
    if (request.model) {
      const provider = config.registry.getForModel(request.model);
      if (provider) {
        return {
          provider: provider.name,
          model: request.model,
          taskType: "general",
          complexity: "medium",
          routedBy: "user-override",
          usedFallback: false,
          usedLlmFallback: false,
          fallbacks: allFallbacks.filter(
            (t) => !(t.provider === provider.name && t.model === request.model)
          ),
        };
      }
    }

    // Classify the request
    const classification = await classifyRequest(request.messages, config.registry);
    const taskType: TaskType = request.routingHint || classification.taskType;
    const complexity: Complexity = classification.complexity;

    // Check for active A/B test on this routing cell
    const abResult = findActiveAbTest(taskType, complexity);
    if (abResult) {
      return {
        provider: abResult.provider,
        model: abResult.model,
        taskType,
        complexity,
        routedBy: "ab-test",
        abTestId: abResult.testId,
        usedFallback: false,
        usedLlmFallback: classification.usedLlmFallback,
        fallbacks: allFallbacks.filter(
          (t) => !(t.provider === abResult.provider && t.model === abResult.model)
        ),
      };
    }

    // Try adaptive routing — uses quality scores from feedback
    const profile = request.routingProfile || "balanced";
    const availableProviders = new Set(config.registry.list().map((p) => p.name));
    const adaptiveTarget = adaptive.getBestModel(taskType, complexity, profile, availableProviders);

    if (adaptiveTarget) {
      return {
        provider: adaptiveTarget.provider,
        model: adaptiveTarget.model,
        taskType,
        complexity,
        routedBy: "adaptive",
        usedFallback: false,
        usedLlmFallback: classification.usedLlmFallback,
        fallbacks: allFallbacks.filter(
          (t) => !(t.provider === adaptiveTarget.provider && t.model === adaptiveTarget.model)
        ),
      };
    }

    // Build dynamic fallback from all registered providers, sorted by cost
    const routedBy = request.routingHint ? "routing-hint" as const : "classification" as const;
    if (allFallbacks.length > 0) {
      return {
        provider: allFallbacks[0].provider,
        model: allFallbacks[0].model,
        taskType,
        complexity,
        routedBy,
        usedFallback: false,
        usedLlmFallback: classification.usedLlmFallback,
        fallbacks: allFallbacks.slice(1),
      };
    }

    // Last resort
    const anyProvider = config.registry.list()[0];
    return {
      provider: anyProvider.name,
      model: anyProvider.models[0] || "unknown",
      taskType,
      complexity,
      routedBy,
      usedFallback: true,
      usedLlmFallback: classification.usedLlmFallback,
      fallbacks: [],
    };
  }

  // Expose adaptive router for feedback updates and dashboard queries
  return { route, adaptive };
}
