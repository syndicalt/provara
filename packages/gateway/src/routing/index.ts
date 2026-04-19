import type { ChatMessage } from "../providers/types.js";
import { messagesHaveImage } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { Db } from "@provara/db";
import { abTests, abTestVariants } from "@provara/db";
import { eq } from "drizzle-orm";
import type { TaskType, Complexity } from "../classifier/types.js";
import type { RoutingResult, RouteTarget } from "./types.js";
import { classifyRequest } from "../classifier/index.js";
import { selectVariant } from "../ab/index.js";
import { createAdaptiveRouter, type RoutingProfile, type RoutingWeights } from "./adaptive/index.js";
import { createBoostTable } from "./adaptive/migrations.js";
import { createRegressionCellTable } from "./adaptive/regression.js";
import { getPricing } from "../cost/index.js";
import { getRoutingConfig } from "./config.js";
import { isStructuredOutputReliable, isVisionCapable } from "./model-capabilities.js";

export type { RoutingResult, RouteTarget } from "./types.js";
export { type RoutingProfile } from "./adaptive/index.js";

/**
 * Raised when `requires_structured_output` is true but no registered
 * provider / model is known to reliably follow JSON schemas. The chat-
 * completions handler in router.ts surfaces this as HTTP 502
 * `no_capable_provider` — the caller asked for a constraint we can't
 * honor; better to fail loudly than silently route to an unreliable
 * model.
 */
export class NoCapableProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoCapableProviderError";
  }
}

export interface RoutingEngineConfig {
  registry: ProviderRegistry;
  db: Db;
}

export interface RoutingRequest {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  routingHint?: TaskType;
  complexityHint?: Complexity;
  routingProfile?: RoutingProfile;
  routingWeights?: RoutingWeights;
  /**
   * Tenant identity of the caller. Drives the adaptive router's tier-
   * aware read fallback (#195) — Team/Enterprise tenants see their
   * isolated matrix with pool as optional fallback; Free/Pro see the
   * shared pool only. `null`/`undefined` = anonymous caller, pool-only.
   */
  tenantId?: string | null;
  /**
   * Caller needs a response matching a structured output schema (#233).
   * When true, the adaptive router and fallback chain both filter to
   * models listed in `STRUCTURED_OUTPUT_RELIABLE`. Detected automatically
   * from OpenAI-shape `response_format: { type: "json_schema" }` or a
   * `tools` array, or set explicitly via the `requires_structured_output`
   * request flag. A request with this flag and no capable candidate
   * surfaces as `no_capable_provider` rather than silently routing to
   * an unreliable model.
   */
  requiresStructuredOutput?: boolean;
}

export async function createRoutingEngine(config: RoutingEngineConfig) {
  const boostTable = createBoostTable(config.db);
  await boostTable.refresh();
  const regressionCellTable = createRegressionCellTable(config.db);
  await regressionCellTable.refresh();
  const adaptive = await createAdaptiveRouter(config.db, {
    getScoreBoost: boostTable.getBoost,
    isCellRegressing: regressionCellTable.isRegressing,
  });

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

  async function findActiveAbTest(
    taskType: TaskType,
    complexity: Complexity
  ): Promise<{ testId: string; provider: string; model: string } | null> {
    const activeTests = await config.db
      .select()
      .from(abTests)
      .where(eq(abTests.status, "active"))
      .all();

    for (const test of activeTests) {
      const variants = await config.db
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
    let allFallbacks = buildDynamicFallbacks(config.registry);

    // Vision filter (#256). When any message carries an image part, the
    // router restricts candidates to vision-capable models. Auto-detected
    // from the messages — no caller opt-in needed. User-pinned
    // provider+model is respected as always; pinning is an explicit "I
    // know what I'm doing" signal and the upstream will reject if the
    // target can't actually handle images.
    const hasImage = messagesHaveImage(request.messages);
    if (hasImage && !(request.provider && request.model) && !request.model) {
      allFallbacks = allFallbacks.filter((t) => isVisionCapable(t.model));
      if (allFallbacks.length === 0) {
        throw new NoCapableProviderError(
          "Request contains image content but no registered vision-capable model is available. " +
            "Register a capable model (gpt-4o, claude-sonnet-4-6, gemini-2.5-pro, etc.) and ensure " +
            "its provider has a configured API key.",
        );
      }
    }

    // Structured-output filter (#233). When the caller has signaled (or
    // we auto-detected) that the response must match a JSON schema, the
    // router narrows every candidate pool to models we've marked as
    // reliably schema-conformant. Fallback chain, adaptive scoring, and
    // A/B test variants all run against the filtered set. A user-
    // pinned provider/model bypasses this filter — pinning is an
    // explicit declaration that the caller knows what they're doing.
    if (request.requiresStructuredOutput && !(request.provider && request.model) && !request.model) {
      allFallbacks = allFallbacks.filter((t) => isStructuredOutputReliable(t.model));
      if (allFallbacks.length === 0) {
        throw new NoCapableProviderError(
          "No provider registered with a model known to reliably follow structured output schemas. " +
            "Register a capable model (gpt-4.1, claude-sonnet-4-6, gemini-2.5-pro, etc.) or set " +
            "`requires_structured_output: false` to opt back into the full candidate pool.",
        );
      }
    }

    // User override: explicit provider + model bypasses routing entirely.
    // routingHint + complexityHint let callers place the sample in a meaningful
    // cell for adaptive learning (defaults: general/medium).
    const overrideTaskType: TaskType = request.routingHint || "general";
    const overrideComplexity: Complexity = request.complexityHint || "medium";

    if (request.provider && request.model) {
      return {
        provider: request.provider,
        model: request.model,
        taskType: overrideTaskType,
        complexity: overrideComplexity,
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
          taskType: overrideTaskType,
          complexity: overrideComplexity,
          routedBy: "user-override",
          usedFallback: false,
          usedLlmFallback: false,
          fallbacks: allFallbacks.filter(
            (t) => !(t.provider === provider.name && t.model === request.model)
          ),
        };
      }
    }

    // Classify the request. Caller-supplied `routingHint` / `complexityHint`
    // normally win over the classifier — the hints are an explicit claim that
    // the caller knows better than the heuristic (e.g. a schema-heavy
    // request where a short user message still demands a capable model).
    // Images short-circuit: the classifier's keyword heuristics are text-only
    // and running them over image placeholders produces noise. Vision goes
    // in its own cell for adaptive learning.
    //
    // Image presence beats the caller's taskType hint (#256): the hint is a
    // text-content heuristic, but having an image_url part is a structural
    // fact about the request. Without this override a caller like Ampline
    // that sends `routing_hint: "qa"` on every estimate pollutes the qa cell
    // with vision samples and leaves the vision cell permanently empty on
    // the routing matrix. Complexity hint still wins — "complex" vs "medium"
    // vision is a meaningful distinction the caller may want to preserve.
    const classification = hasImage
      ? { taskType: "vision" as TaskType, complexity: "complex" as Complexity, taskConfidence: 1, complexityConfidence: 1, usedLlmFallback: false }
      : await classifyRequest(request.messages, config.registry);
    const taskType: TaskType = hasImage
      ? "vision"
      : request.routingHint || classification.taskType;
    const complexity: Complexity = request.complexityHint || classification.complexity;

    const { abTestPreempts } = getRoutingConfig();
    const profile = request.routingProfile || "balanced";
    const availableProviders = new Set(config.registry.list().map((p) => p.name));

    // The `availableProviders` set gates which adaptive candidates can be
    // picked. When structured output is required we also need to prevent
    // individual unreliable models within an otherwise-capable provider
    // from winning — `allFallbacks` was already filtered above, but the
    // adaptive EMA sees the full matrix. Post-filter the result.
    const schemaFilter = request.requiresStructuredOutput
      ? (target: RouteTarget) => isStructuredOutputReliable(target.model)
      : null;
    const visionFilter = hasImage
      ? (target: RouteTarget) => isVisionCapable(target.model)
      : null;

    // A/B test candidate (may or may not run before adaptive based on config).
    // Vision requests skip A/B entirely — variants might point at a text-only
    // model and we'd have no safe way to honor the experiment.
    const abResult = hasImage ? null : await findActiveAbTest(taskType, complexity);
    const adaptiveResult = await adaptive.getBestModel(
      taskType,
      complexity,
      profile,
      availableProviders,
      allFallbacks,
      request.routingWeights,
      request.tenantId,
    );

    // Ordering:
    //   - abTestPreempts=true (default): A/B test wins if present, else adaptive/exploration.
    //   - abTestPreempts=false: adaptive/exploration wins if one was produced, else A/B test.
    const preferAb = abTestPreempts || !adaptiveResult;

    if (preferAb && abResult) {
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

    if (
      adaptiveResult &&
      (!schemaFilter || schemaFilter(adaptiveResult.target)) &&
      (!visionFilter || visionFilter(adaptiveResult.target))
    ) {
      const { target, via } = adaptiveResult;
      return {
        provider: target.provider,
        model: target.model,
        taskType,
        complexity,
        routedBy: via === "exploration" ? "exploration" : "adaptive",
        usedFallback: false,
        usedLlmFallback: classification.usedLlmFallback,
        fallbacks: allFallbacks.filter(
          (t) => !(t.provider === target.provider && t.model === target.model)
        ),
      };
    }

    // adaptive didn't apply, but an A/B test might still fit
    if (!preferAb && abResult) {
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
  return { route, adaptive, boostTable, regressionCellTable };
}
