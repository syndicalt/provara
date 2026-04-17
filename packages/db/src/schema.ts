import { sqliteTable, text, integer, real, blob, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  tenantId: text("tenant_id").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("owner"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const oauthAccounts = sqliteTable("oauth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  provider: text("provider", { enum: ["google", "github"] }).notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  email: text("email"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("oauth_provider_account_idx").on(table.provider, table.providerAccountId),
]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // session token
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const customProviders = sqliteTable("custom_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  baseURL: text("base_url").notNull(),
  apiKeyRef: text("api_key_ref"), // name of the key in api_keys table, e.g. "TOGETHER_API_KEY"
  models: text("models").notNull().default("[]"), // JSON array of model names
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  tenantId: text("tenant_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const modelRegistry = sqliteTable("model_registry", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputPricePer1M: real("input_price_per_1m"),
  outputPricePer1M: real("output_price_per_1m"),
  source: text("source", { enum: ["builtin", "custom", "discovered"] })
    .notNull()
    .default("builtin"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  cost: real("cost"),
  taskType: text("task_type"),
  complexity: text("complexity"),
  routedBy: text("routed_by"),
  usedFallback: integer("used_fallback", { mode: "boolean" }).notNull().default(false),
  cached: integer("cached", { mode: "boolean" }).notNull().default(false),
  /** "exact" | "semantic" when cached=true. Null when cached=false. */
  cacheSource: text("cache_source"),
  /** Tokens that would have been billed but weren't, because of a cache hit. */
  tokensSavedInput: integer("tokens_saved_input"),
  tokensSavedOutput: integer("tokens_saved_output"),
  fallbackErrors: text("fallback_errors"),
  tenantId: text("tenant_id"),
  abTestId: text("ab_test_id").references(() => abTests.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const abTests = sqliteTable("ab_tests", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: ["active", "paused", "completed"] })
    .notNull()
    .default("active"),
  tenantId: text("tenant_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const abTestVariants = sqliteTable("ab_test_variants", {
  id: text("id").primaryKey(),
  abTestId: text("ab_test_id")
    .notNull()
    .references(() => abTests.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  weight: real("weight").notNull().default(1),
  taskType: text("task_type"),
  complexity: text("complexity"),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tenant: text("tenant").notNull(),
  hashedToken: text("hashed_token").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(), // first 8 chars for display
  rateLimit: integer("rate_limit"), // requests per minute, null = unlimited
  spendLimit: real("spend_limit"), // USD per billing period, null = unlimited
  spendPeriod: text("spend_period", { enum: ["monthly", "weekly", "daily"] }).default("monthly"),
  routingProfile: text("routing_profile", { enum: ["cost", "balanced", "quality", "custom"] }).default("balanced"),
  routingWeights: text("routing_weights"), // JSON: { quality, cost, latency }
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // e.g. "OPENAI_API_KEY"
  provider: text("provider").notNull(), // e.g. "openai"
  encryptedValue: text("encrypted_value").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  tenantId: text("tenant_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => requests.id),
  tenantId: text("tenant_id"),
  score: integer("score").notNull(), // 1-5
  comment: text("comment"),
  source: text("source", { enum: ["user", "judge"] })
    .notNull()
    .default("user"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const guardrailRules = sqliteTable("guardrail_rules", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  type: text("type", { enum: ["pii", "content", "regex", "token_limit"] }).notNull(),
  target: text("target", { enum: ["input", "output", "both"] }).notNull().default("both"),
  action: text("action", { enum: ["block", "redact", "flag"] }).notNull().default("block"),
  pattern: text("pattern"), // regex pattern or JSON config
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const guardrailLogs = sqliteTable("guardrail_logs", {
  id: text("id").primaryKey(),
  requestId: text("request_id"),
  tenantId: text("tenant_id"),
  ruleId: text("rule_id").references(() => guardrailRules.id),
  ruleName: text("rule_name").notNull(),
  target: text("target", { enum: ["input", "output"] }).notNull(),
  action: text("action", { enum: ["block", "redact", "flag"] }).notNull(),
  matchedContent: text("matched_content"), // truncated snippet of what was matched
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const alertRules = sqliteTable("alert_rules", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  metric: text("metric", { enum: ["spend", "latency_p95", "latency_avg", "error_rate", "request_count"] }).notNull(),
  condition: text("condition", { enum: ["gt", "lt", "gte", "lte"] }).notNull().default("gt"),
  threshold: real("threshold").notNull(),
  window: text("window", { enum: ["1h", "6h", "24h", "7d"] }).notNull().default("1h"),
  channel: text("channel", { enum: ["webhook"] }).notNull().default("webhook"),
  webhookUrl: text("webhook_url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastTriggeredAt: integer("last_triggered_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const alertLogs = sqliteTable("alert_logs", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").references(() => alertRules.id),
  ruleName: text("rule_name").notNull(),
  metric: text("metric").notNull(),
  value: real("value").notNull(),
  threshold: real("threshold").notNull(),
  acknowledged: integer("acknowledged", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const promptTemplates = sqliteTable("prompt_templates", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  description: text("description"),
  publishedVersionId: text("published_version_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const promptVersions = sqliteTable("prompt_versions", {
  id: text("id").primaryKey(),
  templateId: text("template_id")
    .notNull()
    .references(() => promptTemplates.id),
  version: integer("version").notNull(),
  messages: text("messages").notNull(), // JSON array of { role, content }
  variables: text("variables").notNull().default("[]"), // JSON array of variable names
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const modelScores = sqliteTable("model_scores", {
  taskType: text("task_type").notNull(),
  complexity: text("complexity").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  qualityScore: real("quality_score").notNull(),
  sampleCount: integer("sample_count").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.taskType, table.complexity, table.provider, table.model] }),
]);

export const semanticCache = sqliteTable("semantic_cache", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** Hash of the concatenated system prompt (if any). Matches exactly on lookup. */
  systemPromptHash: text("system_prompt_hash"),
  /** Raw user text that was embedded. Stored for debugging / observability. */
  promptText: text("prompt_text").notNull(),
  /** Float32Array packed as bytes. Dim depends on the embedding model at write time. */
  embedding: blob("embedding", { mode: "buffer" }).notNull(),
  /** Dim of the embedding so we can reject cross-model matches after a model change. */
  embeddingDim: integer("embedding_dim").notNull(),
  /** Embedding model that produced this vector. */
  embeddingModel: text("embedding_model").notNull(),
  response: text("response").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastHitAt: integer("last_hit_at", { mode: "timestamp" }),
});

export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const costLogs = sqliteTable("cost_logs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").references(() => requests.id),
  tenantId: text("tenant_id"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cost: real("cost").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
