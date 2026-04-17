import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProviderRegistry, CompletionRequest, CompletionResponse } from "./providers/index.js";
import type { Db } from "@provara/db";
import { requests } from "@provara/db";
import { nanoid } from "nanoid";
import { logCost } from "./cost/index.js";
import { calculateCost } from "./cost/pricing.js";
import { createRoutingEngine, type RoutingProfile } from "./routing/index.js";
import { createAbTestRoutes } from "./routes/ab-tests.js";
import { createAnalyticsRoutes } from "./routes/analytics.js";
import { createApiKeyRoutes } from "./routes/api-keys.js";
import { createAuthMiddleware, getTokenInfo } from "./auth/middleware.js";
import { createAdminMiddleware, requireRole } from "./auth/admin.js";
import { createTenantMiddleware } from "./auth/tenant.js";
import { createTokenRoutes } from "./routes/tokens.js";
import { createFeedbackRoutes } from "./routes/feedback.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createShareHandlers } from "./routes/shares.js";
import { createRoutingConfigRoutes } from "./routes/routing-config.js";
import { createProviderCrudRoutes } from "./routes/providers.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createTeamRoutes } from "./routes/team.js";
import { createModelRoutes } from "./routes/models.js";
import { createGuardrailRoutes } from "./routes/guardrails.js";
import { createAlertRoutes } from "./routes/alerts.js";
import { createPromptRoutes } from "./routes/prompts.js";
import { loadRules, checkContent, logViolations } from "./guardrails/engine.js";
import { getTenantId } from "./auth/tenant.js";
import { createJudge } from "./routing/judge.js";
import { getCached, putCache, cacheStats } from "./cache/index.js";
import { createSemanticCache, type SemanticCache } from "./cache/semantic.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { getMode } from "./config.js";
import type { Scheduler } from "./scheduler/index.js";
import { getActiveAutoAbCells } from "./routing/adaptive/auto-ab.js";
import { createRegressionRoutes } from "./routes/regression.js";
import { createMigrationRoutes } from "./routes/migrations.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { requireIntelligenceTier } from "./auth/tier.js";

interface RouterContext {
  registry: ProviderRegistry;
  db: Db;
  /** DB-stored API keys for resolving the embedding provider. Same map
   *  the ProviderRegistry receives. Optional — null-safe. */
  dbKeys?: Record<string, string>;
  scheduler?: Scheduler;
}

export async function createRouter(ctx: RouterContext) {
  const app = new Hono();
  const routingEngine = await createRoutingEngine({ registry: ctx.registry, db: ctx.db });
  const judge = createJudge(ctx.registry, ctx.db, routingEngine.adaptive);

  // Semantic cache — null when no embedding provider is available (no
  // API key, disabled via env var, or unknown model). Treat as "off":
  // exact-match cache still works and the LLM path is unaffected.
  const embeddings = createEmbeddingProvider({ dbKeys: ctx.dbKeys });
  const semanticCache: SemanticCache | null = embeddings
    ? await createSemanticCache(ctx.db, embeddings)
    : null;

  // CORS: env-driven allowlist. `PROVARA_ALLOWED_ORIGINS` is a
  // comma-separated list of exact origin strings (e.g.
  // "https://www.provara.xyz,https://gateway.provara.xyz"). When unset we
  // fall back to allowing any origin for non-credentialed requests and
  // reflecting the request origin for credentialed ones — a warning is
  // logged once at startup so operators know they're in permissive
  // mode. Setting the allowlist on Railway / self-host Docker env
  // upgrades to strict.
  const allowedOrigins = (process.env.PROVARA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    console.warn(
      "[cors] PROVARA_ALLOWED_ORIGINS is not set — running in permissive mode (any origin allowed with credentials). Set this env var on prod to lock down.",
    );
  }
  const corsOrigin = (origin: string | undefined): string | null => {
    if (!origin) return null;
    if (allowedOrigins.length === 0) return origin;
    return allowedOrigins.includes(origin) ? origin : null;
  };

  app.use("/*", cors({
    origin: corsOrigin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Admin-Key", "X-Stainless-OS", "X-Stainless-Arch", "X-Stainless-Lang", "X-Stainless-Runtime", "X-Stainless-Runtime-Version", "X-Stainless-Package-Version", "X-Stainless-Retry-Count"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Provara-Guardrail", "X-Provara-Model", "X-Provara-Provider", "X-Provara-Request-Id", "X-Provara-Errors", "X-Provara-Cost", "X-Provara-Latency", "X-Provara-Cache", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
  }));

  // Mount OAuth routes (public, only in multi_tenant mode)
  if (getMode() === "multi_tenant") {
    app.route("/auth", createAuthRoutes(ctx.db));
  }

  // Public share read — uses a distinct path (/v1/shared/:token, past tense)
  // so the `/v1/shares/*` admin-auth middleware registered below doesn't
  // accidentally gate it. Admin create/revoke operations use /v1/shares/*.
  const shareHandlers = createShareHandlers(ctx.db);
  app.get("/v1/shared/:token", shareHandlers.getPublic);

  // Stripe webhooks mount BEFORE auth middleware — they come from Stripe,
  // not an authenticated user, and are authenticated via HMAC signature
  // against STRIPE_WEBHOOK_SECRET instead of a session/bearer.
  app.route("/v1/webhooks", createWebhookRoutes(ctx.db));

  // Auth middleware — checks Bearer token on /v1/chat/completions
  app.use("/v1/*", createAuthMiddleware(ctx.db));

  // Admin middleware — checks X-Admin-Key or session on dashboard routes
  const adminAuth = createAdminMiddleware(ctx.db);
  app.use("/v1/ab-tests/*", adminAuth);
  app.use("/v1/analytics/*", adminAuth);
  app.use("/v1/api-keys/*", adminAuth);
  app.use("/v1/feedback/*", adminAuth);
  app.use("/v1/conversations", adminAuth);
  app.use("/v1/conversations/*", adminAuth);
  // Authed share routes: create + revoke. Public read is /v1/shared/:token (above).
  app.use("/v1/shares/*", adminAuth);
  app.post("/v1/conversations/:id/share", shareHandlers.create);
  app.delete("/v1/shares/:token", shareHandlers.revoke);
  app.use("/v1/admin/*", adminAuth);
  app.use("/v1/providers", adminAuth);
  app.use("/v1/providers/*", adminAuth);
  app.use("/v1/cache/*", adminAuth);
  app.use("/v1/routing/*", adminAuth);

  // Role-based access — owner-only routes (after adminAuth attaches user)
  app.use("/v1/admin/*", requireRole("owner"));
  app.use("/v1/api-keys/*", requireRole("owner"));

  // Tenant middleware — enforces tenant context in multi_tenant mode
  app.use("/v1/*", createTenantMiddleware(ctx.db));

  // Mount A/B test CRUD routes
  app.route("/v1/ab-tests", createAbTestRoutes(ctx.db));

  // Intelligence-tier routes (#168): gate behind PROVARA_CLOUD + subscription
  // tier check. Self-host deployments get a 402 with an explanation. Cloud
  // tenants without a Pro+ subscription get the same 402 with an upgrade CTA
  // payload the dashboard can use to render an Upgrade card in place of the
  // feature UI.
  const tierGate = requireIntelligenceTier(ctx.db);
  app.use("/v1/regression/*", tierGate);
  app.use("/v1/cost-migrations/*", tierGate);
  app.route("/v1/regression", createRegressionRoutes(ctx.db, routingEngine.regressionCellTable));
  app.route("/v1/cost-migrations", createMigrationRoutes(ctx.db, routingEngine.boostTable));

  // Mount analytics routes
  app.route("/v1/analytics", createAnalyticsRoutes(ctx.db, ctx.registry));

  // Mount API key management routes
  app.route("/v1/api-keys", createApiKeyRoutes(ctx.db));

  // Mount feedback routes
  app.route("/v1/feedback", createFeedbackRoutes(ctx.db, routingEngine.adaptive));
  app.route("/v1/conversations", createConversationRoutes(ctx.db));
  app.route("/v1/routing/config", createRoutingConfigRoutes(ctx.db));

  // Mount token management routes (owner only)
  app.route("/v1/admin/tokens", createTokenRoutes(ctx.db));

  // Mount custom provider CRUD routes (owner only)
  app.route("/v1/admin/providers", createProviderCrudRoutes(ctx.db));

  // Mount team management routes (owner only, multi_tenant mode)
  app.route("/v1/admin/team", createTeamRoutes(ctx.db));

  // Mount model stats routes (public — no admin auth needed)
  app.route("/v1/models", createModelRoutes({ db: ctx.db, registry: ctx.registry }));

  // Mount guardrail management routes (admin)
  app.route("/v1/admin/guardrails", createGuardrailRoutes(ctx.db));

  // Mount alert management routes (admin)
  app.route("/v1/admin/alerts", createAlertRoutes(ctx.db));

  // Mount prompt management routes (admin)
  app.route("/v1/admin/prompts", createPromptRoutes(ctx.db));

  // Reload providers endpoint (call after adding/removing API keys)
  app.post("/v1/providers/reload", async (c) => {
    await ctx.registry.reload();
    const providers = ctx.registry.list().map((p) => ({ name: p.name, models: p.models }));
    return c.json({ reloaded: true, providers });
  });

  // Refresh models by querying each provider's API
  app.post("/v1/providers/refresh-models", async (c) => {
    const results = await ctx.registry.refreshModels();
    return c.json({ results });
  });

  // OpenAI-compatible chat completions endpoint
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<CompletionRequest & { provider?: string; cache?: boolean; complexity_hint?: "simple" | "medium" | "complex" }>();
    const { provider: providerName, routing_hint, complexity_hint, cache: cacheParam, ...rest } = body;
    const request = rest as CompletionRequest;
    // Serialize once for all downstream DB writes (cache-hit row, streaming
    // row, non-streaming row). Messages is otherwise stringified 2–3× per
    // request on the hot path.
    const promptJson = JSON.stringify(request.messages);

    // Input guardrails — check all message content before routing
    const tenantIdForGuardrails = getTenantId(c.req.raw);
    const guardrailRulesList = await loadRules(ctx.db, tenantIdForGuardrails);
    const guardrailViolations = new Set<string>();
    if (guardrailRulesList.length > 0) {
      // Find the last user message index — only report violations for it
      let lastUserIdx = -1;
      for (let i = request.messages.length - 1; i >= 0; i--) {
        if (request.messages[i].role === "user") { lastUserIdx = i; break; }
      }

      // Check each message individually so we can redact in-place
      for (let i = 0; i < request.messages.length; i++) {
        const msg = request.messages[i];
        const inputCheck = checkContent(msg.content, guardrailRulesList, "input");

        if (inputCheck.violations.length > 0) {
          // Only log and notify for the latest user message
          if (i === lastUserIdx) {
            await logViolations(ctx.db, null, tenantIdForGuardrails, "input", inputCheck.violations);
            for (const v of inputCheck.violations) {
              guardrailViolations.add(v.ruleName);
            }
          }
        }

        if (!inputCheck.passed && i === lastUserIdx) {
          return c.json({
            error: {
              message: `Request blocked by guardrail: ${inputCheck.violations.map((v) => v.ruleName).join(", ")}`,
              type: "guardrail_error",
            },
          }, 400);
        }

        // Always redact all messages (so provider never sees PII in history)
        if (inputCheck.action === "redact") {
          request.messages[i] = { ...msg, content: inputCheck.content };
        }
      }
    }

    // Determine if caching is eligible
    const noCache = c.req.header("x-provara-no-cache") === "true" || cacheParam === false;
    const isCacheable = !noCache && (!request.temperature || request.temperature === 0);

    // Route the request through the intelligent routing engine
    const tokenInfo = getTokenInfo(c.req.raw);
    const routingResult = await routingEngine.route({
      messages: request.messages,
      provider: providerName,
      model: request.model !== "" ? request.model : undefined,
      routingHint: routing_hint,
      complexityHint: complexity_hint,
      routingProfile: (tokenInfo?.routingProfile as RoutingProfile) || undefined,
      routingWeights: tokenInfo?.routingWeights || undefined,
    });

    const tenantId = tokenInfo?.tenant || getTenantId(c.req.raw) || null;

    // Check cache before calling any provider.
    // Cache lookup order: exact-match (in-memory) → semantic-match (embedding
    // cosine). A hit on either returns immediately without billing the
    // provider and logs tokensSaved* so the dashboard can advertise savings.
    const skipCache = !isCacheable || routingResult.routedBy === "ab-test";
    const returnCachedHit = async (
      content: string,
      providerForResp: string,
      modelForResp: string,
      cacheSource: "exact" | "semantic",
      inputTokens: number,
      outputTokens: number,
      hitId: string,
    ) => {
      await ctx.db
        .insert(requests)
        .values({
          id: hitId,
          provider: providerForResp,
          model: modelForResp,
          prompt: promptJson,
          response: content,
          inputTokens,
          outputTokens,
          latencyMs: 0,
          taskType: routingResult.taskType,
          complexity: routingResult.complexity,
          routedBy: routingResult.routedBy,
          usedFallback: false,
          cached: true,
          cacheSource,
          tokensSavedInput: inputTokens,
          tokensSavedOutput: outputTokens,
          tenantId,
          abTestId: routingResult.abTestId || null,
        })
        .run();
      c.header("X-Provara-Request-Id", hitId);
      c.header("X-Provara-Cache", cacheSource);
      return c.json({
        id: `chatcmpl-${hitId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelForResp,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
        _provara: {
          provider: providerForResp,
          latencyMs: 0,
          cached: true,
          cacheSource,
          routing: {
            taskType: routingResult.taskType,
            complexity: routingResult.complexity,
            routedBy: routingResult.routedBy,
            usedFallback: false,
            usedLlmFallback: routingResult.usedLlmFallback,
          },
        },
      });
    };

    if (!skipCache) {
      const cached = getCached(request.messages, routingResult.provider, routingResult.model);
      if (cached) {
        return returnCachedHit(
          cached.content,
          cached.provider,
          cached.model,
          "exact",
          cached.usage.inputTokens,
          cached.usage.outputTokens,
          nanoid(),
        );
      }

      // Semantic cache is best-effort: any error (embedding API down, quota,
      // timeout) falls through to the LLM path silently.
      if (semanticCache) {
        try {
          const match = await semanticCache.get(
            request.messages,
            tenantId,
            routingResult.provider,
            routingResult.model,
          );
          if (match) {
            return returnCachedHit(
              match.row.response,
              match.row.provider,
              match.row.model,
              "semantic",
              match.row.inputTokens,
              match.row.outputTokens,
              nanoid(),
            );
          }
        } catch (err) {
          console.warn("[semantic-cache] lookup failed:", err instanceof Error ? err.message : err);
        }
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
    const attemptErrors: { provider: string; model: string; error: string }[] = [];

    // --- Streaming path ---
    if (request.stream) {
      let usedProvider = routingResult.provider;
      let usedModel = routingResult.model;
      let usedFallback = routingResult.usedFallback;
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
          if (attempt !== attempts[0]) usedFallback = true;
          const requestId = nanoid();
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
                  id: `chatcmpl-${requestId}`,
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

                // Emit a final Provara meta event before [DONE] so the client
                // can show cost/latency/tokens inline with the response. We
                // can't set response headers after the stream started, so we
                // piggyback on the SSE channel with a custom event shape.
                const streamLatencyMs = Math.round(performance.now() - start);
                const streamCost = calculateCost(usedModel, usage.inputTokens, usage.outputTokens);
                const metaEvent = JSON.stringify({
                  _provara: {
                    model: usedModel,
                    provider: usedProvider,
                    latencyMs: streamLatencyMs,
                    cost: streamCost,
                    usage,
                  },
                });
                controller.enqueue(encoder.encode(`data: ${metaEvent}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();

                // Log after stream completes
                const latencyMs = streamLatencyMs;
                await ctx.db
                  .insert(requests)
                  .values({
                    id: requestId,
                    provider: usedProvider,
                    model: usedModel,
                    prompt: promptJson,
                    response: fullContent,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    latencyMs,
                    taskType: routingResult.taskType,
                    complexity: routingResult.complexity,
                    routedBy: routingResult.routedBy,
                    usedFallback,
                    fallbackErrors: attemptErrors.length > 0 ? JSON.stringify(attemptErrors) : null,
                    tenantId,
                    abTestId: routingResult.abTestId || null,
                  })
                  .run();

                if (routingResult.taskType && routingResult.complexity) {
                  routingEngine.adaptive.updateLatency(
                    routingResult.taskType,
                    routingResult.complexity,
                    usedProvider,
                    usedModel,
                    latencyMs
                  );
                }

                logCost(ctx.db, {
                  requestId,
                  provider: usedProvider,
                  model: usedModel,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  tenantId,
                }).catch(() => {});

                if (!skipCache) {
                  const completedResponse: CompletionResponse = {
                    id: requestId,
                    provider: usedProvider,
                    model: usedModel,
                    content: fullContent,
                    usage,
                    latencyMs,
                  };
                  putCache(request.messages, usedProvider, usedModel, completedResponse);
                  if (semanticCache) {
                    void semanticCache
                      .put(request.messages, tenantId, usedProvider, usedModel, completedResponse)
                      .catch((err) => {
                        console.warn(
                          "[semantic-cache] writeback failed:",
                          err instanceof Error ? err.message : err,
                        );
                      });
                  }
                }

                judge.maybeJudge({
                  requestId,
                  tenantId,
                  messages: request.messages,
                  responseContent: fullContent,
                  taskType: routingResult.taskType,
                  complexity: routingResult.complexity,
                  provider: usedProvider,
                  model: usedModel,
                }).catch(() => {});
              } catch (err) {
                controller.error(err);
              }
            },
          });

          const streamHeaders: Record<string, string> = {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Provara-Model": usedModel,
            "X-Provara-Provider": usedProvider,
            "X-Provara-Request-Id": requestId,
          };
          if (guardrailViolations.size > 0) {
            streamHeaders["X-Provara-Guardrail"] = JSON.stringify([...guardrailViolations]);
          }
          if (usedFallback && attemptErrors.length > 0) {
            streamHeaders["X-Provara-Errors"] = JSON.stringify(attemptErrors);
          }
          return new Response(sseStream, { headers: streamHeaders });
        } catch (err) {
          lastError = err;
          failedProviders.add(attempt.provider);
          const msg = err instanceof Error ? err.message : String(err);
          attemptErrors.push({ provider: attempt.provider, model: attempt.model, error: msg });
          console.warn(`Provider ${attempt.provider}/${attempt.model} stream failed:`, msg);
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
        const msg = err instanceof Error ? err.message : String(err);
        attemptErrors.push({ provider: attempt.provider, model: attempt.model, error: msg });
        console.warn(`Provider ${attempt.provider}/${attempt.model} failed:`, msg);
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
        prompt: promptJson,
        response: response.content,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        latencyMs,
        taskType: routingResult.taskType,
        complexity: routingResult.complexity,
        routedBy: routingResult.routedBy,
        usedFallback,
        fallbackErrors: attemptErrors.length > 0 ? JSON.stringify(attemptErrors) : null,
        tenantId,
        abTestId: routingResult.abTestId || null,
      })
      .run();

    if (routingResult.taskType && routingResult.complexity) {
      routingEngine.adaptive.updateLatency(
        routingResult.taskType,
        routingResult.complexity,
        usedProvider,
        usedModel,
        latencyMs
      );
    }

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
      putCache(request.messages, usedProvider, usedModel, response);
      if (semanticCache) {
        void semanticCache
          .put(request.messages, tenantId, usedProvider, usedModel, response)
          .catch((err) => {
            console.warn(
              "[semantic-cache] writeback failed:",
              err instanceof Error ? err.message : err,
            );
          });
      }
    }

    // Fire-and-forget: LLM-as-judge quality scoring on a sample of responses
    judge.maybeJudge({
      requestId,
      tenantId,
      messages: request.messages,
      responseContent: response.content,
      taskType: routingResult.taskType,
      complexity: routingResult.complexity,
      provider: usedProvider,
      model: usedModel,
    }).catch(() => {});

    // Output guardrails — check response content before returning
    let responseContent = response.content;
    if (guardrailRulesList.length > 0) {
      const outputCheck = checkContent(responseContent, guardrailRulesList, "output");
      if (outputCheck.violations.length > 0) {
        await logViolations(ctx.db, requestId, tenantIdForGuardrails, "output", outputCheck.violations);
      }
      if (!outputCheck.passed) {
        return c.json({
          error: {
            message: `Response blocked by guardrail: ${outputCheck.violations.map((v) => v.ruleName).join(", ")}`,
            type: "guardrail_error",
          },
        }, 400);
      }
      responseContent = outputCheck.content; // May be redacted
    }

    // Return OpenAI-compatible response format
    const nonStreamCost = calculateCost(usedModel, response.usage.inputTokens, response.usage.outputTokens);
    c.header("X-Provara-Request-Id", requestId);
    c.header("X-Provara-Latency", String(response.latencyMs));
    c.header("X-Provara-Cost", nonStreamCost.toFixed(6));
    return c.json({
      id: `chatcmpl-${response.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: usedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: responseContent },
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
        ...(usedFallback && attemptErrors.length > 0 ? { errors: attemptErrors } : {}),
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

  // Adaptive routing scores (for dashboard). Annotates each cell with
  // staleness so the heatmap can render stale cells distinctly — see #148.
  // Also annotates active auto-A/B experiments (see #151) so the UI can
  // surface "experimenting" overlays without a second round-trip.
  app.get("/v1/analytics/adaptive/scores", async (c) => {
    const activeAuto = await getActiveAutoAbCells(ctx.db);
    const autoMap = new Map(activeAuto.map((r) => [`${r.taskType}::${r.complexity}`, r.testId]));
    const cells = routingEngine.adaptive.getAllScores().map((cell) => ({
      ...cell,
      isStale: routingEngine.adaptive.isStale(cell.taskType, cell.complexity),
      lastUpdatedAt: routingEngine.adaptive.lastUpdated(cell.taskType, cell.complexity),
      activeAutoAbTestId: autoMap.get(`${cell.taskType}::${cell.complexity}`) ?? null,
    }));
    return c.json({ cells });
  });

  // Scheduler observability (admin-only). Exposes per-job last-run state
  // so the dashboard can surface a "background jobs" pane and operators
  // can trigger a manual run during incident response.
  app.get("/v1/admin/scheduler/jobs", requireRole("owner"), async (c) => {
    if (!ctx.scheduler) return c.json({ jobs: [] });
    return c.json({ jobs: await ctx.scheduler.getJobs() });
  });
  app.post("/v1/admin/scheduler/jobs/:name/run", requireRole("owner"), async (c) => {
    if (!ctx.scheduler) return c.json({ error: { message: "scheduler not available" } }, 503);
    const { name } = c.req.param();
    try {
      await ctx.scheduler.runNow(name);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message: msg } }, 404);
    }
  });

  // Cache stats
  app.get("/v1/cache/stats", (c) => c.json(cacheStats()));

  // Health check + config
  app.get("/health", (c) => c.json({ status: "ok", mode: getMode() }));

  return Object.assign(app, { routingEngine });
}
