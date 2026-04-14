import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProviderRegistry, CompletionRequest, CompletionResponse } from "./providers/index.js";
import type { Db } from "@provara/db";
import { requests } from "@provara/db";
import { nanoid } from "nanoid";
import { logCost } from "./cost/index.js";
import { createRoutingEngine, type RoutingProfile } from "./routing/index.js";
import { createAbTestRoutes } from "./routes/ab-tests.js";
import { createAnalyticsRoutes } from "./routes/analytics.js";
import { createApiKeyRoutes } from "./routes/api-keys.js";
import { createAuthMiddleware, getTokenInfo } from "./auth/middleware.js";
import { createTokenRoutes } from "./routes/tokens.js";
import { createFeedbackRoutes } from "./routes/feedback.js";
import { createProviderCrudRoutes } from "./routes/providers.js";
import { createJudge } from "./routing/judge.js";

interface RouterContext {
  registry: ProviderRegistry;
  db: Db;
}

export function createRouter(ctx: RouterContext) {
  const app = new Hono();
  const routingEngine = createRoutingEngine({ registry: ctx.registry, db: ctx.db });
  const judge = createJudge(ctx.registry, ctx.db);

  // Enable CORS for web dashboard
  app.use("/*", cors());

  // Auth middleware — checks Bearer token on /v1/* routes
  // Runs in "open mode" (no auth) when no tokens have been created
  app.use("/v1/*", createAuthMiddleware(ctx.db));

  // Mount A/B test CRUD routes
  app.route("/v1/ab-tests", createAbTestRoutes(ctx.db));

  // Mount analytics routes
  app.route("/v1/analytics", createAnalyticsRoutes(ctx.db));

  // Mount API key management routes
  app.route("/v1/api-keys", createApiKeyRoutes(ctx.db));

  // Mount feedback routes
  app.route("/v1/feedback", createFeedbackRoutes(ctx.db));

  // Mount token management routes (admin — no auth required)
  app.route("/v1/admin/tokens", createTokenRoutes(ctx.db));

  // Mount custom provider CRUD routes (admin)
  app.route("/v1/admin/providers", createProviderCrudRoutes(ctx.db));

  // Reload providers endpoint (call after adding/removing API keys)
  app.post("/v1/providers/reload", (c) => {
    ctx.registry.reload();
    const providers = ctx.registry.list().map((p) => ({ name: p.name, models: p.models }));
    return c.json({ reloaded: true, providers });
  });

  // OpenAI-compatible chat completions endpoint
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<CompletionRequest & { provider?: string }>();
    const { provider: providerName, routing_hint, ...rest } = body;
    const request = rest as CompletionRequest;

    // Route the request through the intelligent routing engine
    const tokenInfo = getTokenInfo(c.req.raw);
    const routingResult = await routingEngine.route({
      messages: request.messages,
      provider: providerName,
      model: request.model !== "" ? request.model : undefined,
      routingHint: routing_hint,
      routingProfile: (tokenInfo?.routingProfile as RoutingProfile) || undefined,
    });

    const tenantId = tokenInfo?.tenant || null;

    // Build the attempt order: primary target + fallbacks
    const attempts = [
      { provider: routingResult.provider, model: routingResult.model },
      ...routingResult.fallbacks,
    ];

    let response: CompletionResponse | undefined;
    let usedProvider: string = routingResult.provider;
    let usedModel: string = routingResult.model;
    let usedFallback = routingResult.usedFallback;
    let lastError: unknown;
    let latencyMs = 0;

    const PROVIDER_TIMEOUT_MS = 30_000;

    for (const attempt of attempts) {
      const provider = ctx.registry.get(attempt.provider);
      if (!provider) continue;

      try {
        const start = performance.now();
        const result = await Promise.race([
          provider.complete({ ...request, model: attempt.model }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${PROVIDER_TIMEOUT_MS}ms`)), PROVIDER_TIMEOUT_MS)
          ),
        ]);
        response = result;
        latencyMs = Math.round(performance.now() - start);
        usedProvider = attempt.provider;
        usedModel = attempt.model;
        if (attempt !== attempts[0]) usedFallback = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`Provider ${attempt.provider}/${attempt.model} failed:`, err instanceof Error ? err.message : err);
        continue;
      }
    }

    if (!response) {
      const errMsg = lastError instanceof Error ? lastError.message : "All providers failed";
      return c.json(
        { error: { message: errMsg, type: "provider_error" } },
        502
      );
    }

    const requestId = nanoid();
    ctx.db
      .insert(requests)
      .values({
        id: requestId,
        provider: usedProvider,
        model: usedModel,
        prompt: JSON.stringify(request.messages),
        response: response.content,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        latencyMs,
        taskType: routingResult.taskType,
        complexity: routingResult.complexity,
        routedBy: routingResult.routedBy,
        tenantId,
        abTestId: routingResult.abTestId || null,
      })
      .run();

    await logCost(ctx.db, {
      requestId,
      provider: usedProvider,
      model: usedModel,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      tenantId,
    });

    // Fire-and-forget: LLM-as-judge quality scoring on a sample of responses
    judge.maybeJudge({
      requestId,
      tenantId,
      messages: request.messages,
      responseContent: response.content,
    }).catch(() => {});

    // Return OpenAI-compatible response format
    return c.json({
      id: `chatcmpl-${response.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: usedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: response.content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.inputTokens + response.usage.outputTokens,
      },
      _provara: {
        provider: usedProvider,
        latencyMs,
        routing: {
          taskType: routingResult.taskType,
          complexity: routingResult.complexity,
          routedBy: routingResult.routedBy,
          usedFallback,
          usedLlmFallback: routingResult.usedLlmFallback,
        },
      },
    });
  });

  // List available providers and models
  app.get("/v1/providers", (c) => {
    const providers = ctx.registry.list().map((p) => ({
      name: p.name,
      models: p.models,
    }));
    return c.json({ providers });
  });

  // Adaptive routing scores (for dashboard)
  app.get("/v1/analytics/adaptive/scores", (c) => {
    return c.json({ cells: routingEngine.adaptive.getAllScores() });
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}
