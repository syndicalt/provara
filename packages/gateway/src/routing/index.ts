import type { ChatMessage } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { Db } from "@provara/db";
import { abTests, abTestVariants } from "@provara/db";
import { eq } from "drizzle-orm";
import type { TaskType, Complexity } from "../classifier/types.js";
import type { RoutingTable, RoutingResult, RouteTarget } from "./types.js";
import { classifyRequest } from "../classifier/index.js";
import { selectVariant } from "../ab/index.js";
import { DEFAULT_ROUTING_TABLE } from "./routing-table.js";
import { createAdaptiveRouter, type RoutingProfile } from "./adaptive.js";

export type { RoutingTable, RoutingResult, RouteTarget } from "./types.js";
export { type RoutingProfile } from "./adaptive.js";

export interface RoutingEngineConfig {
  registry: ProviderRegistry;
  db: Db;
  routingTable?: RoutingTable;
}

export interface RoutingRequest {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  routingHint?: TaskType;
  routingProfile?: RoutingProfile;
}

export function createRoutingEngine(config: RoutingEngineConfig) {
  const table = config.routingTable || DEFAULT_ROUTING_TABLE;
  const adaptive = createAdaptiveRouter(config.db);

  function findAvailableTarget(
    targets: RouteTarget[],
    registry: ProviderRegistry
  ): { target: RouteTarget; usedFallback: boolean } | null {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const provider = registry.get(target.provider);
      if (provider) {
        return { target, usedFallback: i > 0 };
      }
    }
    return null;
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
      };
    }

    // Fall back to static routing table
    const routedBy = request.routingHint ? "routing-hint" as const : "classification" as const;
    const entry = table[taskType]?.[complexity];

    if (!entry) {
      const fallbackEntry = table.general.medium;
      const result = findAvailableTarget(
        [fallbackEntry.primary, ...fallbackEntry.fallbacks],
        config.registry
      );
      if (result) {
        return {
          provider: result.target.provider,
          model: result.target.model,
          taskType,
          complexity,
          routedBy,
          usedFallback: result.usedFallback,
          usedLlmFallback: classification.usedLlmFallback,
        };
      }
      const anyProvider = config.registry.list()[0];
      return {
        provider: anyProvider.name,
        model: anyProvider.models[0] || "unknown",
        taskType,
        complexity,
        routedBy,
        usedFallback: true,
        usedLlmFallback: classification.usedLlmFallback,
      };
    }

    const result = findAvailableTarget(
      [entry.primary, ...entry.fallbacks],
      config.registry
    );

    if (result) {
      return {
        provider: result.target.provider,
        model: result.target.model,
        taskType,
        complexity,
        routedBy,
        usedFallback: result.usedFallback,
        usedLlmFallback: classification.usedLlmFallback,
      };
    }

    const anyProvider = config.registry.list()[0];
    return {
      provider: anyProvider.name,
      model: anyProvider.models[0] || "unknown",
      taskType,
      complexity,
      routedBy,
      usedFallback: true,
      usedLlmFallback: classification.usedLlmFallback,
    };
  }

  // Expose adaptive router for feedback updates and dashboard queries
  return { route, adaptive };
}
