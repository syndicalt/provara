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
import { createAdminMiddleware, requireRole } from "./auth/admin.js";
import { createTenantMiddleware } from "./auth/tenant.js";
import { createTokenRoutes } from "./routes/tokens.js";
import { createFeedbackRoutes } from "./routes/feedback.js";
import { createProviderCrudRoutes } from "./routes/providers.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createTeamRoutes } from "./routes/team.js";
import { createModelRoutes } from "./routes/models.js";
import { createJudge } from "./routing/judge.js";
import { getCached, putCache, cacheStats } from "./cache/index.js";
import { getMode } from "./config.js";

interface RouterContext {
  registry: ProviderRegistry;
  db: Db;
}

export async function createRouter(ctx: RouterContext) {
  const app = new Hono();
  const routingEngine = await createRoutingEngine({ registry: ctx.registry, db: ctx.db });
  const judge = createJudge(ctx.registry, ctx.db);

  // Enable CORS for web dashboard (credentials needed for session cookies)
  app.use("/*", cors({
    origin: process.env.DASHBOARD_URL || "http://localhost:3000",
    credentials: true,
  }));

  // Mount OAuth routes (public, only in multi_tenant mode)
  if (getMode() === "multi_tenant") {
    app.route("/auth", createAuthRoutes(ctx.db));
  }

  // Auth middleware — checks Bearer token on /v1/chat/completions
  app.use("/v1/*", createAuthMiddleware(ctx.db));

  // Admin middleware — checks X-Admin-Key or session on dashboard routes
  const adminAuth = createAdminMiddleware(ctx.db);
  app.use("/v1/ab-tests/*", adminAuth);
  app.use("/v1/analytics/*", adminAuth);
  app.use("/v1/api-keys/*", adminAuth);
  app.use("/v1/feedback/*", adminAuth);
  app.use("/v1/admin/*", adminAuth);
  app.use("/v1/providers", adminAuth);
  app.use("/v1/providers/*", adminAuth);
  app.use("/v1/cache/*", adminAuth);

  // Role-based access — owner-only routes (after adminAuth attaches user)
  app.use("/v1/admin/*", requireRole("owner"));
  app.use("/v1/api-keys/*", requireRole("owner"));

  // Tenant middleware — enforces tenant context in multi_tenant mode
  app.use("/v1/*", createTenantMiddleware(ctx.db));

  // Mount A/B test CRUD routes
  app.route("/v1/ab-tests", createAbTestRoutes(ctx.db));

  // Mount analytics routes
  app.route("/v1/analytics", createAnalyticsRoutes(ctx.db));

  // Mount API key management routes
  app.route("/v1/api-keys", createApiKeyRoutes(ctx.db));

  // Mount feedback routes
  app.route("/v1/feedback", createFeedbackRoutes(ctx.db));

  // Mount token management routes (owner only)
  app.route("/v1/admin/tokens", createTokenRoutes(ctx.db));

  // Mount custom provider CRUD routes (owner only)
  app.route("/v1/admin/providers", createProviderCrudRoutes(ctx.db));

  // Mount team management routes (owner only, multi_tenant mode)
  app.route("/v1/admin/team", createTeamRoutes(ctx.db));

  // Mount model stats routes (public — no admin auth needed)
  app.route("/v1/models", createModelRoutes({ db: ctx.db, registry: ctx.registry }));

  // Reload providers endpoint (call after adding/removing API keys)
  app.post("/v1/providers/reload", async (c) => {
    await ctx.registry.reload();
    const providers = ctx.registry.list().map((p) => ({ name: p.name, models: p.models }));
    return c.json({ reloaded: true, providers });
  });

  // OpenAI-compatible chat completions endpoint
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<CompletionRequest & { provider?: string; cache?: boolean }>();
    const { provider: providerName, routing_hint, cache: cacheParam, ...rest } = body;
    const request = rest as CompletionRequest;

    // Determine if caching is eligible
    const noCache = c.req.header("x-provara-no-cache") === "true" || cacheParam === false;
    const isCacheable = !noCache && (!request.temperature || request.temperature === 0);

    // Route the request through the intelligent routing engine
    const tokenInfo = getTokenInfo(c.req.raw);
    const routingResult = await routingEngine.route({
      messages: request.messages,
      provider: providerName,
      model: request.model !== "" ? request.model : undefined,
      routingHint: routing_hint?.task_type,
      routingProfile: (tokenInfo?.routingProfile as RoutingProfile) || undefined,
      routingWeights: tokenInfo?.routingWeights || undefined,
    });

    const tenantId = tokenInfo?.tenant || null;

    // Check cache before calling any provider
    const skipCache = !isCacheable || routingResult.routedBy === "ab-test";
    if (!skipCache) {
      const cached = getCached(request.messages);
      if (cached) {
        return c.json({
          id: `chatcmpl-${cached.id}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: routingResult.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: cached.content },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: cached.usage.inputTokens,
            completion_tokens: cached.usage.outputTokens,
            total_tokens: cached.usage.inputTokens + cached.usage.outputTokens,
          },
          _provara: {
            provider: cached.provider,
            latencyMs: 0,
            cached: true,
            routing: {
              taskType: routingResult.taskType,
              complexity: routingResult.complexity,
              routedBy: routingResult.routedBy,
              usedFallback: false,
              usedLlmFallback: routingResult.usedLlmFallback,
            },
          },
        });
      }
    }

    // Build the attempt order: primary target + fallbacks
    const attempts = [
      { provider: routingResult.provider, model: routingResult.model },
      ...routingResult.fallbacks,
    ];

    const CONNECT_TIMEOUT_MS = 10_000;  // For initial connection / first chunk
    const COMPLETION_TIMEOUT_MS = 120_000; // For full non-streaming response
    const failedProviders = new Set<string>();

    // --- Streaming path ---
    if (request.stream) {
      let usedProvider = routingResult.provider;
      let usedModel = routingResult.model;
      let lastError: unknown;

      for (const attempt of attempts) {
        if (failedProviders.has(attempt.provider)) continue;
        const provider = ctx.registry.get(attempt.provider);
        if (!provider) continue;

        try {
          const streamIter = provider.stream({ ...request, model: attempt.model });
          const iterator = streamIter[Symbol.asyncIterator]();

          // Pull the first chunk BEFORE committing to this provider
          // If this throws (e.g. 429), we can still try the next provider
          const first = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
            ),
          ]);

          if (first.done) continue;

          usedProvider = attempt.provider;
          usedModel = attempt.model;
          const responseId = nanoid();
          const start = performance.now();

          const sseStream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              let fullContent = "";
              let usage = { inputTokens: 0, outputTokens: 0 };

              const emitChunk = (chunk: { content: string; done: boolean; usage?: { inputTokens: number; outputTokens: number } }) => {
                fullContent += chunk.content;
                if (chunk.usage) usage = chunk.usage;
                const sseData = JSON.stringify({
                  id: `chatcmpl-${responseId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: usedModel,
                  choices: [{
                    index: 0,
                    delta: chunk.done ? {} : { content: chunk.content },
                    finish_reason: chunk.done ? "stop" : null,
                  }],
                });
                controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
              };

              try {
                // Emit the first chunk we already pulled
                emitChunk(first.value);

                // Continue with remaining chunks
                for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
                  emitChunk(chunk);
                }

                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();

                // Log after stream completes
                const latencyMs = Math.round(performance.now() - start);
                const requestId = nanoid();
                await ctx.db
                  .insert(requests)
                  .values({
                    id: requestId,
                    provider: usedProvider,
                    model: usedModel,
                    prompt: JSON.stringify(request.messages),
                    response: fullContent,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    latencyMs,
                    taskType: routingResult.taskType,
                    complexity: routingResult.complexity,
                    routedBy: routingResult.routedBy,
                    tenantId,
                    abTestId: routingResult.abTestId || null,
                  })
                  .run();

                logCost(ctx.db, {
                  requestId,
                  provider: usedProvider,
                  model: usedModel,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  tenantId,
                }).catch(() => {});

                if (!skipCache) {
                  putCache(request.messages, {
                    id: responseId,
                    provider: usedProvider,
                    model: usedModel,
                    content: fullContent,
                    usage,
                    latencyMs,
                  });
                }

                judge.maybeJudge({
                  requestId,
                  tenantId,
                  messages: request.messages,
                  responseContent: fullContent,
                }).catch(() => {});
              } catch (err) {
                controller.error(err);
              }
            },
          });

          return new Response(sseStream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        } catch (err) {
          lastError = err;
          failedProviders.add(attempt.provider);
          console.warn(`Provider ${attempt.provider}/${attempt.model} stream failed:`, err instanceof Error ? err.message : err);
          continue;
        }
      }

      const errMsg = lastError instanceof Error ? lastError.message : "All providers failed";
      return c.json({ error: { message: errMsg, type: "provider_error" } }, 502);
    }

    // --- Non-streaming path ---
    let response: CompletionResponse | undefined;
    let usedProvider: string = routingResult.provider;
    let usedModel: string = routingResult.model;
    let usedFallback = routingResult.usedFallback;
    let lastError: unknown;
    let latencyMs = 0;

    for (const attempt of attempts) {
      if (failedProviders.has(attempt.provider)) continue;
      const provider = ctx.registry.get(attempt.provider);
      if (!provider) continue;

      try {
        const start = performance.now();
        const result = await Promise.race([
          provider.complete({ ...request, model: attempt.model }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${COMPLETION_TIMEOUT_MS}ms`)), COMPLETION_TIMEOUT_MS)
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
        failedProviders.add(attempt.provider);
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
    await ctx.db
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

    // Cache the response for future identical requests
    if (!skipCache) {
      putCache(request.messages, response);
    }

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
        cached: false,
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

  // Cache stats
  app.get("/v1/cache/stats", (c) => c.json(cacheStats()));

  // Health check + config
  app.get("/health", (c) => c.json({ status: "ok", mode: getMode() }));

  return app;
}
