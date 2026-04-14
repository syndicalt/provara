import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProviderRegistry, CompletionRequest } from "./providers/index.js";
import type { Db } from "@provara/db";
import { requests } from "@provara/db";
import { nanoid } from "nanoid";
import { logCost } from "./cost/index.js";
import { createRoutingEngine } from "./routing/index.js";
import { createAbTestRoutes } from "./routes/ab-tests.js";
import { createAnalyticsRoutes } from "./routes/analytics.js";
import { createApiKeyRoutes } from "./routes/api-keys.js";
import { createAuthMiddleware, getTokenInfo } from "./auth/middleware.js";
import { createTokenRoutes } from "./routes/tokens.js";

interface RouterContext {
  registry: ProviderRegistry;
  db: Db;
}

export function createRouter(ctx: RouterContext) {
  const app = new Hono();
  const routingEngine = createRoutingEngine({ registry: ctx.registry, db: ctx.db });

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

  // Mount token management routes (admin — no auth required)
  app.route("/v1/admin/tokens", createTokenRoutes(ctx.db));

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
    const routingResult = await routingEngine.route({
      messages: request.messages,
      provider: providerName,
      model: request.model !== "" ? request.model : undefined,
      routingHint: routing_hint,
    });

    const provider = ctx.registry.get(routingResult.provider);
    if (!provider) {
      return c.json(
        { error: { message: `No provider available for routing result`, type: "invalid_request_error" } },
        404
      );
    }

    // Use the routed model
    const completionRequest: CompletionRequest = {
      ...request,
      model: routingResult.model,
    };

    const tokenInfo = getTokenInfo(c.req.raw);
    const tenantId = tokenInfo?.tenant || null;

    const start = performance.now();
    const response = await provider.complete(completionRequest);
    const latencyMs = Math.round(performance.now() - start);

    const requestId = nanoid();
    ctx.db
      .insert(requests)
      .values({
        id: requestId,
        provider: response.provider,
        model: response.model,
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
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      tenantId,
    });

    // Return OpenAI-compatible response format
    return c.json({
      id: `chatcmpl-${response.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: response.model,
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
        provider: response.provider,
        latencyMs,
        routing: {
          taskType: routingResult.taskType,
          complexity: routingResult.complexity,
          routedBy: routingResult.routedBy,
          usedFallback: routingResult.usedFallback,
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

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}
