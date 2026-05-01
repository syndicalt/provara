import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProviderRegistry, CompletionRequest, CompletionResponse, StreamChunk } from "./providers/index.js";
import { modelSupportsTools } from "./providers/capabilities.js";
import type { Db } from "@provara/db";
import { guardrailLogs, requests } from "@provara/db";
import { nanoid } from "nanoid";
import { logCost } from "./cost/index.js";
import { calculateCost } from "./cost/pricing.js";
import { createRoutingEngine, NoCapableProviderError, type RoutingProfile } from "./routing/index.js";
import { createAbTestRoutes } from "./routes/ab-tests.js";
import { createAnalyticsRoutes } from "./routes/analytics.js";
import { createEvalRoutes } from "./routes/evals.js";
import { createRolloutRoutes } from "./routes/rollouts.js";
import { createApiKeyRoutes } from "./routes/api-keys.js";
import { createAuthMiddleware, getTokenInfo } from "./auth/middleware.js";
import { createAdminMiddleware, requireRole } from "./auth/admin.js";
import { createTenantMiddleware } from "./auth/tenant.js";
import { createReadOnlyMiddleware } from "./middleware/read-only.js";
import { createDemoRoutes } from "./routes/demo.js";
import { createTokenRoutes } from "./routes/tokens.js";
import { createFeedbackRoutes } from "./routes/feedback.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createShareHandlers } from "./routes/shares.js";
import { createRoutingConfigRoutes } from "./routes/routing-config.js";
import { createRoutingIsolationRoutes } from "./routes/routing-isolation.js";
import { createProviderCrudRoutes } from "./routes/providers.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createMeRoutes } from "./routes/me.js";
import { createSamlAuthRoutes } from "./routes/auth-saml.js";
import { createAuditRoutes } from "./routes/audit.js";
import { createSpendRoutes } from "./routes/spend.js";
import { createTeamRoutes } from "./routes/team.js";
import { createModelRoutes } from "./routes/models.js";
import { createGuardrailRoutes } from "./routes/guardrails.js";
import { createAlertRoutes } from "./routes/alerts.js";
import { createPromptRoutes } from "./routes/prompts.js";
import { loadRules, checkContent, logViolations } from "./guardrails/engine.js";
import { checkToolCallAlignment } from "./guardrails/tool-call-alignment.js";
import { getTenantId } from "./auth/tenant.js";
import { getRequestAttribution } from "./auth/attribution.js";
import { checkBudgetHardStop } from "./billing/budget-alerts.js";
import { createJudge } from "./routing/judge.js";
import { getCached, putCache, cacheStats } from "./cache/index.js";
import { messagesHaveImage } from "./providers/types.js";
import { publish as publishLive, subscribe as subscribeLive, buildPromptPreview, type LiveEvent } from "./live/emitter.js";
import { createSemanticCache, type SemanticCache } from "./cache/semantic.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { getMode } from "./config.js";
import type { Scheduler } from "./scheduler/index.js";
import { getActiveAutoAbCells } from "./routing/adaptive/auto-ab.js";
import { createAdaptiveAdminRoutes } from "./routes/adaptive-admin.js";
import { createRegressionRoutes } from "./routes/regression.js";
import { createMigrationRoutes } from "./routes/migrations.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createBillingRoutes } from "./routes/billing.js";
import { requireIntelligenceTier } from "./auth/tier.js";
import { requireQuota } from "./auth/quota.js";
import {
  createRateLimitMiddleware,
  loadRateLimitConfig,
} from "./middleware/rate-limit.js";

interface RouterContext {
  registry: ProviderRegistry;
  db: Db;
  /** DB-stored API keys for resolving the embedding provider. Same map
   *  the ProviderRegistry receives. Optional — null-safe. */
  dbKeys?: Record<string, string>;
  scheduler?: Scheduler;
}

// The OpenAI SDK wraps network failures in APIConnectionError with the
// generic message "Connection error.", burying the real cause on `.cause`.
// HTTP errors surface as APIError subclasses with `status`. Unwrap both,
// redact anything that looks like a bearer secret (some underlying errors
// inexplicably contain raw auth headers in their message — don't trust
// the stack not to leak), and prefer structural fields (name, code,
// status) over free-text messages where possible.
const SECRET_PATTERN = /(?:Bearer\s+[A-Za-z0-9][A-Za-z0-9\-_.=]{8,}|sk-[A-Za-z0-9\-_]{6,}|xai-[A-Za-z0-9\-_]{6,}|AIza[A-Za-z0-9\-_]{10,})/g;

function redactSecrets(s: string): string {
  return s.replace(SECRET_PATTERN, "[redacted]");
}

// Emit a redacted stack trace for the whole error chain so we can identify
// *where* a surprising cause (e.g. a TypeError with a bearer-string message)
// is being thrown from. Heavy for steady-state prod, so gated behind
// PROVARA_DEBUG_PROVIDER_ERRORS — enable only when actively diagnosing.
// The short summary from describeProviderError is always logged.
function logProviderErrorStack(err: unknown, label: string): void {
  if (process.env.PROVARA_DEBUG_PROVIDER_ERRORS !== "true") return;
  const chain: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur instanceof Error && depth < 4) {
    const header = `[${cur.constructor?.name || cur.name || "Error"}]`;
    const code = (cur as { code?: string }).code;
    const stack = cur.stack?.split("\n").slice(0, 5).join("\n") ?? "(no stack)";
    chain.push(`${header}${code ? ` code=${code}` : ""}\n${stack}`);
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  if (chain.length === 0) return;
  console.warn(`[provider-error-stack ${label}]\n${redactSecrets(chain.join("\n--- caused by ---\n"))}`);
}

function isRetryableModelRefusal(response: Pick<CompletionResponse, "finish_reason">): boolean {
  return response.finish_reason === "content_filter";
}

function isRetryableStreamRefusal(chunk: StreamChunk): boolean {
  return chunk.done && chunk.finish_reason === "content_filter";
}

function describeModelRefusal(finishReason: string | undefined): string {
  return `Model refused with finish_reason=${finishReason ?? "unknown"}`;
}

function describeProviderError(err: unknown): string {
  if (!(err instanceof Error)) return redactSecrets(String(err));
  const parts: string[] = [];
  const status = (err as { status?: number }).status;
  const code = (err as { code?: string }).code;
  if (typeof status === "number") parts.push(`${status}`);
  if (code) parts.push(`[${code}]`);
  parts.push(err.name !== "Error" ? `${err.name}: ${err.message}` : err.message);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: string }).code;
    const causeParts: string[] = [];
    if (causeCode) causeParts.push(causeCode);
    if (cause.name !== "Error") causeParts.push(cause.name);
    causeParts.push(cause.message);
    parts.push(`(caused by ${causeParts.join(": ")})`);
  }
  return redactSecrets(parts.join(" "));
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

  // Per-IP rate limiting (#192). Flat limits for abuse protection;
  // tier-based promises are handled upstream via monthly quota
  // enforcement (`requireQuota` + TIER_QUOTAS), not here.
  const rateLimits = loadRateLimitConfig();

  // Mount OAuth routes (public, only in multi_tenant mode). Auth
  // endpoints are public + unauthenticated, so rate-limit-hit audit
  // emission is disabled — stdout logging only. Sign-in / invite-claim
  // / OAuth callback are all under /auth/*.
  if (getMode() === "multi_tenant") {
    const authRateLimit = createRateLimitMiddleware({
      scope: "auth",
      ...rateLimits.authPerMinute,
    });
    app.use("/auth/*", authRateLimit);
    app.route("/auth", createAuthRoutes(ctx.db));
    app.route("/auth/saml", createSamlAuthRoutes(ctx.db));
  }

  // Global DoS floor on the chat-completions hot path. Per-token
  // `apiTokens.rateLimit` remains the programmatic lever for
  // fine-grained limits; this is the flat DoS ceiling that protects
  // the process regardless of token count.
  const chatRateLimit = createRateLimitMiddleware({
    scope: "chat",
    ...rateLimits.chatPerSecond,
    audit: { db: ctx.db },
  });
  app.use("/v1/chat/completions", chatRateLimit);

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
  app.use("/v1/billing/*", adminAuth);
  app.use("/v1/audit-logs", adminAuth);
  app.use("/v1/audit-logs/*", adminAuth);
  app.use("/v1/spend", adminAuth);
  app.use("/v1/spend/*", adminAuth);
  app.use("/v1/me", adminAuth);
  app.use("/v1/me/*", adminAuth);

  // Role-based access (#247). Admin-auth middleware above attaches the
  // session user; these gates restrict by role. Owner is always allowed;
  // the passed role is the *minimum* required tier inside the namespace.
  //
  // - tokens / prompts are developer+ (devs need their own tokens; token
  //   CRUD filters to creator for developers in the route handler)
  // - team / providers / guardrails / alerts / api-keys / routing are
  //   admin+ (affect the whole tenant, not policy-appropriate for devs)
  // - audit / spend / analytics / billing-reads stay at viewer+ via the
  //   adminAuth-only gates above (viewer gets into the dashboard, just
  //   no mutation surface)
  app.use("/v1/admin/tokens", requireRole(["developer"]));
  app.use("/v1/admin/tokens/*", requireRole(["developer"]));
  app.use("/v1/admin/prompts", requireRole(["developer"]));
  app.use("/v1/admin/prompts/*", requireRole(["developer"]));
  app.use("/v1/admin/team", requireRole(["admin"]));
  app.use("/v1/admin/team/*", requireRole(["admin"]));
  app.use("/v1/admin/providers", requireRole(["admin"]));
  app.use("/v1/admin/providers/*", requireRole(["admin"]));
  app.use("/v1/admin/guardrails", requireRole(["admin"]));
  app.use("/v1/admin/guardrails/*", requireRole(["admin"]));
  app.use("/v1/admin/alerts", requireRole(["admin"]));
  app.use("/v1/admin/alerts/*", requireRole(["admin"]));
  app.use("/v1/api-keys/*", requireRole(["admin"]));
  app.use("/v1/routing/*", requireRole(["admin"]));

  // Tenant middleware — enforces tenant context in multi_tenant mode
  app.use("/v1/*", createTenantMiddleware(ctx.db));

  // Public demo tenant (#229). Read-only session for anonymous visitors.
  // Mounted AFTER tenant middleware so /v1/* writes from demo sessions
  // are blocked, but BEFORE any feature routes.
  if (getMode() === "multi_tenant") {
    app.route("/demo", createDemoRoutes(ctx.db));
  }

  // Read-only session enforcement (#229). Applies to all /v1/* writes
  // and the chat-completions hot path — demo sessions can browse the
  // seeded data freely but can't create, mutate, or burn LLM tokens.
  const readOnly = createReadOnlyMiddleware();
  app.use("/v1/*", readOnly);
  app.use("/v1/chat/completions", readOnly);

  // Self-service profile (#251). No role gate — any authenticated user
  // manages their own profile, sessions, and can delete their account.
  app.route("/v1/me", createMeRoutes(ctx.db));

  // Mount A/B test CRUD routes
  app.route("/v1/ab-tests", createAbTestRoutes(ctx.db));
  app.route("/v1/billing", createBillingRoutes(ctx.db));
  app.route("/v1/audit-logs", createAuditRoutes(ctx.db));
  app.route("/v1/spend", createSpendRoutes(ctx.db));

  // Intelligence-tier routes (#168): gate behind PROVARA_CLOUD + subscription
  // tier check. Self-host deployments get a 402 with an explanation. Cloud
  // tenants without a Pro+ subscription get the same 402 with an upgrade CTA
  // payload the dashboard can use to render an Upgrade card in place of the
  // feature UI.
  const tierGate = requireIntelligenceTier(ctx.db);
  app.use("/v1/regression/*", tierGate);
  app.use("/v1/cost-migrations/*", tierGate);
  app.use("/v1/evals/*", tierGate);
  app.route("/v1/regression", createRegressionRoutes(ctx.db, routingEngine.regressionCellTable));
  app.route("/v1/cost-migrations", createMigrationRoutes(ctx.db, routingEngine.boostTable));

  // Mount analytics routes
  app.route("/v1/analytics", createAnalyticsRoutes(ctx.db, ctx.registry));

  // Mount evals routes (#262)
  app.route("/v1/evals", createEvalRoutes(ctx.db, ctx.registry));

  // Mount prompt rollout routes (#264). Weighted-pick resolve lives under
  // /v1/rollouts/resolve/:templateId to avoid a route-shadow collision with
  // the existing /v1/prompts/* sub-app.
  app.route("/v1/rollouts", createRolloutRoutes(ctx.db));

  // Mount API key management routes
  app.route("/v1/api-keys", createApiKeyRoutes(ctx.db));

  // Mount feedback routes
  app.route("/v1/feedback", createFeedbackRoutes(ctx.db, routingEngine.adaptive));
  app.route("/v1/conversations", createConversationRoutes(ctx.db));
  app.route("/v1/routing/config", createRoutingConfigRoutes(ctx.db));
  app.route("/v1/routing/isolation", createRoutingIsolationRoutes(ctx.db));

  // Mount token management routes (owner only)
  app.route("/v1/admin/tokens", createTokenRoutes(ctx.db));

  // Mount custom provider CRUD routes (owner only)
  app.route("/v1/admin/providers", createProviderCrudRoutes(ctx.db));

  // Mount team management routes (owner only, multi_tenant mode)
  app.route("/v1/admin/team", createTeamRoutes(ctx.db));

  // Mount model stats routes (public — no admin auth needed)
  app.route("/v1/models", createModelRoutes({ db: ctx.db, registry: ctx.registry }));

  // Mount guardrail management routes (admin)
  app.route("/v1/admin/guardrails", createGuardrailRoutes(ctx.db, ctx.registry));

  // Mount alert management routes (admin)
  app.route("/v1/admin/alerts", createAlertRoutes(ctx.db));

  // Mount prompt management routes (admin)
  app.route("/v1/admin/prompts", createPromptRoutes(ctx.db));

  // Reload providers endpoint (call after adding/removing API keys)
  app.post("/v1/providers/reload", async (c) => {
    await ctx.registry.reload();
    const providers = ctx.registry.list().map((p) => ({
      name: p.name,
      models: p.models,
      capabilities: Object.fromEntries(
        p.models.map((m) => [m, { supportsTools: modelSupportsTools(p.name, m) }]),
      ),
    }));
    return c.json({ reloaded: true, providers });
  });

  // Refresh models by querying each provider's API
  app.post("/v1/providers/refresh-models", async (c) => {
    const results = await ctx.registry.refreshModels();
    return c.json({ results });
  });

  // Free-tier quota gate (#170). Sits specifically on /v1/chat/completions
  // so it runs after auth + tenant middleware (which have already
  // resolved the tenant) but before the provider call. Self-host
  // bypasses via the isCloudDeployment() check inside the middleware.
  app.use("/v1/chat/completions", requireQuota(ctx.db));

  // OpenAI-compatible chat completions endpoint
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<CompletionRequest & {
      provider?: string;
      cache?: boolean;
      complexity_hint?: "simple" | "medium" | "complex";
      /** Prompt-template version id threaded through from `/v1/rollouts/resolve/:templateId`
       *  so canary vs stable feedback can be tracked per version (#264). */
      prompt_version_id?: string;
      /**
       * Explicit opt-in to structured-output routing filter (#233).
       * Auto-detected from `response_format: { type: "json_schema" }`
       * or a non-empty `tools` array — callers don't need to set this
       * unless they want to override a negative auto-detection.
       */
      requires_structured_output?: boolean;
      response_format?: { type?: string };
    }>();
    const {
      provider: providerName,
      routing_hint: rawRoutingHint,
      complexity_hint: rawComplexityHint,
      cache: cacheParam,
      requires_structured_output,
      response_format,
      prompt_version_id: promptVersionId,
      ...rest
    } = body;
    // `rest` carries `tools`, `tool_choice`, `parallel_tool_calls` through to
    // the provider adapter untouched. Do not destructure them out.
    const request = rest as CompletionRequest;

    // Validate hints at the edge. The TypeScript types constrain these to
    // enums, but the HTTP body is just parsed JSON — at runtime a caller
    // can send any string. Invalid values previously wrote straight to
    // `requests.complexity` / `requests.task_type` and broke the adaptive
    // heatmap (cells are keyed on the enum values, so e.g. "moderate"
    // landed nowhere on the grid — see Ampline vision traffic).
    // Drop invalid values silently so a typo'd hint falls through to the
    // classifier instead of 400-ing the request.
    const VALID_ROUTING_HINTS = new Set([
      "coding", "creative", "summarization", "qa", "general", "vision",
    ] as const);
    const VALID_COMPLEXITIES = new Set(["simple", "medium", "complex"] as const);
    const routing_hint =
      typeof rawRoutingHint === "string" && VALID_ROUTING_HINTS.has(rawRoutingHint as "coding")
        ? (rawRoutingHint as "coding" | "creative" | "summarization" | "qa" | "general" | "vision")
        : undefined;
    const complexity_hint =
      typeof rawComplexityHint === "string" && VALID_COMPLEXITIES.has(rawComplexityHint as "simple")
        ? (rawComplexityHint as "simple" | "medium" | "complex")
        : undefined;

    // Auto-detect structured-output intent (#233). Explicit flag wins
    // when set; otherwise any standard JSON-schema / tool-use marker
    // flips it on.
    const autoDetectStructured =
      response_format?.type === "json_schema" ||
      response_format?.type === "json_object" ||
      (Array.isArray(request.tools) && request.tools.length > 0);
    const requiresStructuredOutput =
      typeof requires_structured_output === "boolean"
        ? requires_structured_output
        : autoDetectStructured;
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

      // Check each message individually so we can redact in-place. Guardrails
      // scan text only — image parts are passed through unchanged. If the text
      // requires redaction we replace each text part with the redacted copy
      // and leave image parts intact.
      for (let i = 0; i < request.messages.length; i++) {
        const msg = request.messages[i];
        // Skip role: "tool" messages. Their content is structured JSON output
        // from a tool execution; regex-based redaction can corrupt that JSON
        // and break the next turn of the assistant. Assistant messages that
        // carry tool_calls still get their string content redacted, but the
        // spread-preserve of `...msg` below keeps tool_calls arguments intact.
        if (msg.role === "tool") continue;
        const textForScan = typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join("\n");
        const inputCheck = checkContent(textForScan, guardrailRulesList, "input");

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
          if (typeof msg.content === "string") {
            request.messages[i] = { ...msg, content: inputCheck.content };
          } else {
            // Drop the original text parts, emit one redacted text part at
            // the front; keep image parts in their original order.
            const imageParts = msg.content.filter((p) => p.type !== "text");
            const redactedPart = { type: "text" as const, text: inputCheck.content };
            request.messages[i] = { ...msg, content: [redactedPart, ...imageParts] };
          }
        }
      }
    }

    // Determine if caching is eligible. Image-bearing requests skip caching
    // entirely (#256): exact-match would never hit on unique image bytes
    // and the semantic layer's embedding provider is text-only.
    const noCache = c.req.header("x-provara-no-cache") === "true" || cacheParam === false;
    const hasImageContent = messagesHaveImage(request.messages);
    const isCacheable = !noCache && !hasImageContent && (!request.temperature || request.temperature === 0);

    // Route the request through the intelligent routing engine
    const tokenInfo = getTokenInfo(c.req.raw);
    const tenantId = tokenInfo?.tenant || getTenantId(c.req.raw) || null;
    // Spend-attribution (#219): resolved once per request and threaded
    // through every `requests` insert + cost-log write.
    const attribution = getRequestAttribution(c.req.raw);

    // Spend-budget hard stop (#219/T7). One SELECT + aggregate on every
    // chat completion for tenants that have opted in — cheap on the
    // tenant-scoped spend index, skipped entirely for tenants without a
    // budget row (the early return in `checkBudgetHardStop`).
    if (tenantId) {
      const budget = await checkBudgetHardStop(ctx.db, tenantId);
      if (budget.blocked) {
        return c.json(
          {
            error: {
              message: `Spend budget exceeded: ${budget.spend?.toFixed(2)} / ${budget.cap?.toFixed(2)} USD (${budget.period}).`,
              type: "budget_exceeded",
            },
          },
          402,
        );
      }
    }
    let routingResult;
    try {
      routingResult = await routingEngine.route({
        messages: request.messages,
        provider: providerName,
        model: request.model !== "" ? request.model : undefined,
        routingHint: routing_hint,
        complexityHint: complexity_hint,
        requiresStructuredOutput,
        routingProfile: (tokenInfo?.routingProfile as RoutingProfile) || undefined,
        routingWeights: tokenInfo?.routingWeights || undefined,
        tenantId,
      });
    } catch (err) {
      if (err instanceof NoCapableProviderError) {
        return c.json(
          {
            error: {
              message: err.message,
              type: "no_capable_provider",
            },
          },
          502,
        );
      }
      throw err;
    }

    // Tool-calling capability gate (#301). Fails fast with a clear error when
    // the resolved model does not support tool calling but the request carries
    // tools. Better than letting the upstream provider return an opaque 400.
    if (
      Array.isArray(request.tools) &&
      request.tools.length > 0 &&
      !modelSupportsTools(routingResult.provider, routingResult.model)
    ) {
      return c.json(
        {
          error: {
            code: "tools_unsupported",
            message: `Model ${routingResult.model} on provider ${routingResult.provider} does not support tool calling. Pick a tool-capable model or drop the tools field.`,
            type: "model_capability_error",
          },
        },
        400,
      );
    }

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
      toolCalls?: CompletionResponse["tool_calls"],
      finishReason?: CompletionResponse["finish_reason"],
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
          userId: attribution.userId,
          apiTokenId: attribution.apiTokenId,
          abTestId: routingResult.abTestId || null,
          promptVersionId: promptVersionId || null,
        })
        .run();
      publishLive({
        id: hitId,
        provider: providerForResp,
        model: modelForResp,
        taskType: routingResult.taskType,
        complexity: routingResult.complexity,
        routedBy: routingResult.routedBy,
        cached: true,
        usedFallback: false,
        latencyMs: 0,
        inputTokens,
        outputTokens,
        cost: 0,
        tenantId,
        userId: attribution.userId,
        apiTokenId: attribution.apiTokenId,
        promptPreview: buildPromptPreview(promptJson),
        createdAt: new Date().toISOString(),
      });
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
            message: {
              role: "assistant",
              content,
              ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason ?? (toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop"),
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
      const cached = getCached(
        request.messages,
        routingResult.provider,
        routingResult.model,
        request.tools,
        request.tool_choice,
      );
      if (cached) {
        return returnCachedHit(
          cached.content,
          cached.provider,
          cached.model,
          "exact",
          cached.usage.inputTokens,
          cached.usage.outputTokens,
          nanoid(),
          cached.tool_calls,
          cached.finish_reason,
        );
      }

      // Semantic cache is best-effort: any error (embedding API down, quota,
      // timeout) falls through to the LLM path silently. Skip it entirely
      // when the request carries tools — semantic similarity of the prompt
      // does not imply identical tool contracts, and the DB row does not
      // preserve tool_calls, so a "hit" would silently strip the tool call
      // the client actually asked for.
      const requestHasTools = Array.isArray(request.tools) && request.tools.length > 0;
      if (semanticCache && !requestHasTools) {
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

    // First-chunk timeout for adaptive/ab-test routing, where we want to fail
    // over fast if the primary is dead. When the user explicitly pinned the
    // provider (user-override → empty fallbacks), there's nothing to fail
    // over to — honor the pin with a generous timeout that covers cold
    // model-load on self-hosted Ollama/vLLM (Qwen3-36B etc. can take 30-60s
    // to stream a first chunk on a cold start).
    const CONNECT_TIMEOUT_MS = routingResult.routedBy === "user-override" ? 120_000 : 10_000;
    const COMPLETION_TIMEOUT_MS = 120_000; // For full non-streaming response
    const failedProviders = new Set<string>();
    const attemptErrors: { provider: string; model: string; error: string }[] = [];

    // --- Streaming path (user-pinned, single attempt) ---
    // Open the SSE response immediately and emit keepalive comments while
    // waiting for the provider's first chunk. Non-pinned routes use the
    // fail-fast pattern below, which delays the response until we know the
    // primary works so we can swap providers on failure. For a user-pinned
    // route there's no fallback to swap to (#282 → empty fallbacks), and
    // cloud ingress proxies close idle HTTPS connections after ~30s —
    // self-hosted inference (cold Qwen3-36B, DeepSeek-R1) can easily take
    // 60s+ for the first byte. Keepalives let the cold-start complete
    // instead of failing with a browser "network error".
    if (
      request.stream &&
      routingResult.routedBy === "user-override" &&
      attempts.length === 1
    ) {
      const attempt = attempts[0];
      const provider = ctx.registry.get(attempt.provider);
      if (!provider) {
        return c.json(
          { error: { message: `Pinned provider "${attempt.provider}" not registered`, type: "provider_error" } },
          502,
        );
      }

      const usedProvider = attempt.provider;
      const usedModel = attempt.model;
      const usedFallback = false;
      const requestId = nanoid();
      const start = performance.now();

      const sseStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let fullContent = "";
          let usage = { inputTokens: 0, outputTokens: 0 };
          // Track unique tool-call indexes surfaced across chunks so the
          // final `requests` row can record how many tool calls the model
          // emitted on this turn. Deltas for the same index arrive across
          // multiple chunks as the `function.arguments` JSON streams in.
          const streamToolCallIndexes = new Set<number>();

          // SSE comments ":..." are legal keepalives ignored by parsers.
          // Cleared on the first real chunk or in finally{}.
          const keepalive = setInterval(() => {
            try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* stream closed */ }
          }, 10_000);

          const emitChunk = (chunk: StreamChunk) => {
            fullContent += chunk.content;
            if (chunk.usage) usage = chunk.usage;
            if (chunk.tool_calls) {
              for (const d of chunk.tool_calls) streamToolCallIndexes.add(d.index);
            }
            // Forward the provider's real finish_reason when it arrives so
            // OpenAI-SDK clients see "tool_calls" vs "stop" correctly. Fall
            // back to "stop" only when a chunk signals done without an
            // explicit reason (defensive — all adapters should set one).
            const sseDelta: Record<string, unknown> = chunk.done ? {} : {};
            if (!chunk.done && chunk.content) sseDelta.content = chunk.content;
            if (chunk.tool_calls && chunk.tool_calls.length > 0) {
              sseDelta.tool_calls = chunk.tool_calls;
            }
            const finishReasonForSse = chunk.done
              ? chunk.finish_reason ?? "stop"
              : null;
            const sseData = JSON.stringify({
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: usedModel,
              choices: [{
                index: 0,
                delta: sseDelta,
                finish_reason: finishReasonForSse,
              }],
            });
            controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
          };

          try {
            // Immediate byte so the client sees the stream is alive even
            // before the provider warms up.
            controller.enqueue(encoder.encode(": connecting\n\n"));

            let firstReceived = false;
            for await (const chunk of provider.stream({ ...request, model: attempt.model })) {
              if (!firstReceived) {
                clearInterval(keepalive);
                firstReceived = true;
              }
              emitChunk(chunk);
            }

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

            await ctx.db.insert(requests).values({
              id: requestId,
              provider: usedProvider,
              model: usedModel,
              prompt: promptJson,
              response: fullContent,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              latencyMs: streamLatencyMs,
              taskType: routingResult.taskType,
              complexity: routingResult.complexity,
              routedBy: routingResult.routedBy,
              usedFallback,
              fallbackErrors: null,
              tenantId,
              userId: attribution.userId,
              apiTokenId: attribution.apiTokenId,
              abTestId: routingResult.abTestId || null,
              promptVersionId: promptVersionId || null,
              toolCallsCount: streamToolCallIndexes.size,
            }).run();

            if (routingResult.taskType && routingResult.complexity) {
              routingEngine.adaptive.updateLatency(
                routingResult.taskType,
                routingResult.complexity,
                usedProvider,
                usedModel,
                streamLatencyMs,
              );
            }

            logCost(ctx.db, {
              requestId,
              provider: usedProvider,
              model: usedModel,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              tenantId,
              userId: attribution.userId,
              apiTokenId: attribution.apiTokenId,
            }).then((streamCost2) => {
              publishLive({
                id: requestId,
                provider: usedProvider,
                model: usedModel,
                taskType: routingResult.taskType,
                complexity: routingResult.complexity,
                routedBy: routingResult.routedBy,
                cached: false,
                usedFallback,
                latencyMs: streamLatencyMs,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cost: streamCost2,
                tenantId,
                userId: attribution.userId,
                apiTokenId: attribution.apiTokenId,
                promptPreview: buildPromptPreview(promptJson),
                createdAt: new Date().toISOString(),
              });
            }).catch(() => {});

            if (!skipCache) {
              const completedResponse: CompletionResponse = {
                id: requestId,
                provider: usedProvider,
                model: usedModel,
                content: fullContent,
                usage,
                latencyMs: streamLatencyMs,
              };
              putCache(
                request.messages,
                usedProvider,
                usedModel,
                completedResponse,
                undefined,
                request.tools,
                request.tool_choice,
              );
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
            // The response headers are already committed, so we can't 502
            // — instead emit a structured error event in the stream that
            // the client renders as a real error message. Without this
            // the browser sees only an abrupt close ("network error").
            const msg = describeProviderError(err);
            console.warn(`Provider ${usedProvider}/${usedModel} pinned stream failed:`, msg);
            logProviderErrorStack(err, `${usedProvider}/${usedModel} pinned stream`);
            try {
              const errorEvent = JSON.stringify({ error: { message: msg, type: "provider_error" } });
              controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch { /* stream already closed */ }
            try { controller.close(); } catch { /* already closed */ }
          } finally {
            clearInterval(keepalive);
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
        // Disable intermediate buffering so SSE events stream in real time.
        // Nginx honors this; Cloudflare Enterprise does too. Harmless where
        // unrecognized.
        "X-Accel-Buffering": "no",
      };
      if (guardrailViolations.size > 0) {
        streamHeaders["X-Provara-Guardrail"] = JSON.stringify([...guardrailViolations]);
      }
      return new Response(sseStream, { headers: streamHeaders });
    }

    // --- Streaming path (fail-fast for adaptive / multi-attempt routes) ---
    if (request.stream) {
      let usedProvider = routingResult.provider;
      let usedModel = routingResult.model;
      let usedFallback = routingResult.usedFallback;
      let lastError: unknown;

      for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
        const attempt = attempts[attemptIndex];
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

          const firstChunkRefused = !first.done && isRetryableStreamRefusal(first.value);
          if (firstChunkRefused && attemptIndex < attempts.length - 1) {
            const msg = describeModelRefusal(first.value.finish_reason);
            attemptErrors.push({ provider: attempt.provider, model: attempt.model, error: msg });
            console.warn(`Provider ${attempt.provider}/${attempt.model} refused:`, msg);
            continue;
          }

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

              const emitChunk = (chunk: StreamChunk) => {
                fullContent += chunk.content;
                if (chunk.usage) usage = chunk.usage;
                const sseDelta: Record<string, unknown> = chunk.done ? {} : {};
                if (!chunk.done && chunk.content) sseDelta.content = chunk.content;
                if (chunk.tool_calls && chunk.tool_calls.length > 0) {
                  sseDelta.tool_calls = chunk.tool_calls;
                }
                const sseData = JSON.stringify({
                  id: `chatcmpl-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: usedModel,
                  choices: [{
                    index: 0,
                    delta: sseDelta,
                    finish_reason: chunk.done ? chunk.finish_reason ?? "stop" : null,
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
                    userId: attribution.userId,
                    apiTokenId: attribution.apiTokenId,
                    abTestId: routingResult.abTestId || null,
                    promptVersionId: promptVersionId || null,
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
                  userId: attribution.userId,
                  apiTokenId: attribution.apiTokenId,
                }).then((streamCost) => {
                  publishLive({
                    id: requestId,
                    provider: usedProvider,
                    model: usedModel,
                    taskType: routingResult.taskType,
                    complexity: routingResult.complexity,
                    routedBy: routingResult.routedBy,
                    cached: false,
                    usedFallback,
                    latencyMs,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cost: streamCost,
                    tenantId,
                    userId: attribution.userId,
                    apiTokenId: attribution.apiTokenId,
                    promptPreview: buildPromptPreview(promptJson),
                    createdAt: new Date().toISOString(),
                  });
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
                  putCache(
                    request.messages,
                    usedProvider,
                    usedModel,
                    completedResponse,
                    undefined,
                    request.tools,
                    request.tool_choice,
                  );
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
          const msg = describeProviderError(err);
          attemptErrors.push({ provider: attempt.provider, model: attempt.model, error: msg });
          console.warn(`Provider ${attempt.provider}/${attempt.model} stream failed:`, msg);
          logProviderErrorStack(err, `${attempt.provider}/${attempt.model} stream`);
          continue;
        }
      }

      const errMsg = lastError ? describeProviderError(lastError) : "All providers failed";
      return c.json({ error: { message: errMsg, type: "provider_error" } }, 502);
    }

    // --- Non-streaming path ---
    let response: CompletionResponse | undefined;
    let usedProvider: string = routingResult.provider;
    let usedModel: string = routingResult.model;
    let usedFallback = routingResult.usedFallback;
    let lastError: unknown;
    let latencyMs = 0;

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
      const attempt = attempts[attemptIndex];
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
        if (isRetryableModelRefusal(result) && attemptIndex < attempts.length - 1) {
          const msg = describeModelRefusal(result.finish_reason);
          attemptErrors.push({ provider: attempt.provider, model: attempt.model, error: msg });
          console.warn(`Provider ${attempt.provider}/${attempt.model} refused:`, msg);
          continue;
        }
        response = result;
        latencyMs = Math.round(performance.now() - start);
        usedProvider = attempt.provider;
        usedModel = attempt.model;
        if (attempt !== attempts[0]) usedFallback = true;
        break;
      } catch (err) {
        lastError = err;
        failedProviders.add(attempt.provider);
        const msg = describeProviderError(err);
        attemptErrors.push({ provider: attempt.provider, model: attempt.model, error: msg });
        console.warn(`Provider ${attempt.provider}/${attempt.model} failed:`, msg);
        logProviderErrorStack(err, `${attempt.provider}/${attempt.model}`);
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
    const toolCallAlignment = checkToolCallAlignment({
      messages: request.messages,
      tools: request.tools,
      toolCalls: response.tool_calls,
    });
    for (const violation of toolCallAlignment.violations) {
      await ctx.db.insert(guardrailLogs).values({
        id: nanoid(),
        requestId,
        tenantId: tenantIdForGuardrails,
        ruleId: null,
        ruleName: "Tool-call alignment",
        target: "output",
        action: violation.action,
        matchedContent: `${violation.toolName}: ${violation.matchedSnippet}`.slice(0, 120),
      }).run();
    }
    if (!toolCallAlignment.passed) {
      return c.json(
        {
          error: {
            code: "tool_call_alignment_blocked",
            message: `Tool call blocked by guardrail: ${toolCallAlignment.violations
              .filter((violation) => violation.action === "block")
              .map((violation) => violation.reason)
              .join("; ")}`,
            type: "guardrail_error",
            violations: toolCallAlignment.violations,
          },
        },
        400,
      );
    }

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
        userId: attribution.userId,
        apiTokenId: attribution.apiTokenId,
        abTestId: routingResult.abTestId || null,
        promptVersionId: promptVersionId || null,
        toolCallsCount: response.tool_calls?.length ?? 0,
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

    const costUsd = await logCost(ctx.db, {
      requestId,
      provider: usedProvider,
      model: usedModel,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      tenantId,
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
    });

    publishLive({
      id: requestId,
      provider: usedProvider,
      model: usedModel,
      taskType: routingResult.taskType,
      complexity: routingResult.complexity,
      routedBy: routingResult.routedBy,
      cached: false,
      usedFallback,
      latencyMs,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cost: costUsd,
      tenantId,
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      promptPreview: buildPromptPreview(promptJson),
      createdAt: new Date().toISOString(),
    });

    // Cache the response for future identical requests
    if (!skipCache) {
      putCache(
        request.messages,
        usedProvider,
        usedModel,
        response,
        undefined,
        request.tools,
        request.tool_choice,
      );
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
          message: {
            role: "assistant",
            content: responseContent,
            ...(response.tool_calls && response.tool_calls.length > 0
              ? { tool_calls: response.tool_calls }
              : {}),
          },
          finish_reason:
            response.finish_reason ??
            (response.tool_calls && response.tool_calls.length > 0
              ? "tool_calls"
              : "stop"),
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
        ...(toolCallAlignment.decision !== "allow"
          ? { guardrails: { toolCallAlignment } }
          : {}),
        ...(usedFallback && attemptErrors.length > 0 ? { errors: attemptErrors } : {}),
      },
    });
  });

  // List available providers and models
  app.get("/v1/providers", (c) => {
    const providers = ctx.registry.list().map((p) => ({
      name: p.name,
      models: p.models,
      // Per-model capability map (#301). Sibling field (not inside `models`)
      // so existing consumers that treat `models` as `string[]` keep working.
      capabilities: Object.fromEntries(
        p.models.map((m) => [m, { supportsTools: modelSupportsTools(p.name, m) }]),
      ),
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

  // Low-scoring-cell detection + manual challenger probe (Track 3).
  // Free-tier capability: the heuristic and challenger picker run
  // server-side regardless of subscription so every operator can see
  // the matrix gap and act on it. Tier-gating happens one layer down
  // in `routing/adaptive/exploration.ts` (Track 2 — automatic boosted
  // exploration on low-score cells). See `routes/adaptive-admin.ts`.
  app.route("/v1/admin/adaptive", createAdaptiveAdminRoutes(ctx.db, () => ctx.registry));

  // Live traffic tap (#263). SSE stream of completed requests, scoped to the
  // caller's tenant. In-process pub/sub — the router publishes to an emitter
  // after writing each `requests` row, this handler subscribes and forwards.
  // Stream is ephemeral; historical logs stay in `/dashboard/logs`.
  app.get("/v1/analytics/live", (c) => {
    const tenantId = getTenantId(c.req.raw);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": shiplog-live-connected\n\n"));

        const unsubscribe = subscribeLive((event) => {
          // Tenant isolation — anonymous tenant (null) only receives its own null events.
          if (tenantId !== null && event.tenantId !== tenantId) return;
          if (tenantId === null && event.tenantId !== null) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            unsubscribe();
          }
        });

        // Keep-alive comment every 20s so proxies don't close the stream
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            clearInterval(keepAlive);
          }
        }, 20_000);

        const abort = () => {
          clearInterval(keepAlive);
          unsubscribe();
          try { controller.close(); } catch {}
        };
        c.req.raw.signal.addEventListener("abort", abort);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
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
