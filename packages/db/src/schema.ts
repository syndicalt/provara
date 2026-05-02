import { sqliteTable, text, integer, real, blob, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  // `name` is kept for back-compat with OAuth flow reads; new code should
  // read `firstName` / `lastName` and rely on server-side concatenation
  // at insert time. Magic-link (#204) added the split fields; OAuth
  // `upsertUser` still populates `name` the same way.
  name: text("name"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  avatarUrl: text("avatar_url"),
  tenantId: text("tenant_id").notNull(),
  role: text("role", { enum: ["owner", "admin", "developer", "viewer"] }).notNull().default("owner"),
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
  /**
   * Demo-tenant sessions (#229) are marked read-only so the hot path can
   * refuse writes without tearing the tenant-scoping code apart. When
   * set, every POST/PUT/PATCH/DELETE under `/v1/*` returns 403
   * `demo_read_only` — the rest of the dashboard experience (reads,
   * exports, chart renders) remains functional. Null = regular session.
   */
  readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Magic-link sign-in / signup tokens (#204).
 *
 * Token lifecycle: created by POST /auth/magic-link/request, consumed by
 * GET /auth/magic/verify. Single-use (consumedAt stamp) with a 15-minute
 * TTL. SHA-256 hashed at rest — plain token only exists in the email.
 *
 * Signup carriers: when the request comes from an email with no existing
 * user row, the client resubmits /request with firstName + lastName. We
 * stash those on the token row so the verify endpoint has everything it
 * needs to create the user atomically on click — no intermediate "pending
 * signup" state anywhere else in the system.
 *
 * Rate limit: the request handler counts rows for a given email where
 * createdAt > now - 15min; rejects at 3.
 */
export const magicLinkTokens = sqliteTable("magic_link_tokens", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  pendingFirstName: text("pending_first_name"),
  pendingLastName: text("pending_last_name"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp" }),
}, (t) => [
  index("magic_link_tokens_email_idx").on(t.email),
  index("magic_link_tokens_hash_idx").on(t.tokenHash),
]);

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
  /** JSON array of modalities the model accepts as input. `["text"]` for
   *  text-only, `["text","image"]` for vision-capable. Used by the routing
   *  engine to filter candidate models when a request carries image parts. */
  modalities: text("modalities").notNull().default('["text"]'),
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
  /**
   * Attribution for spend intelligence (#219). Populated at ingest from
   * the authenticated request context; nullable for historical rows and
   * for request paths that don't resolve a user or token (system /
   * scheduled callers). User and token are not mutually exclusive in
   * principle, but in practice dashboard calls set userId and bearer-
   * token calls set apiTokenId.
   */
  userId: text("user_id"),
  apiTokenId: text("api_token_id"),
  abTestId: text("ab_test_id").references(() => abTests.id),
  /** Prompt version id when the request was resolved from a prompt template
   *  via `/v1/prompts/:id/resolve` (#264). Enables canary vs stable EMA
   *  tracking for prompt rollouts. Null for ad-hoc chat completions. */
  promptVersionId: text("prompt_version_id"),
  /** Number of tool_calls in the response. Zero for non-tool responses, null
   *  for historical rows predating #298. Populated on successful uncached
   *  completions so analytics can slice agentic traffic without parsing JSON. */
  toolCallsCount: integer("tool_calls_count"),
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
  autoGenerated: integer("auto_generated", { mode: "boolean" }).notNull().default(false),
  /** For auto-generated tests: the cell this experiment was spawned from. Null for manual tests. */
  sourceTaskType: text("source_task_type"),
  sourceComplexity: text("source_complexity"),
  /** Human-readable reason for auto-creation, e.g. "EMA tie between X and Y". */
  sourceReason: text("source_reason"),
  /** Winner decided by auto-stop, in "provider/model" form. Null until resolved. */
  resolvedWinner: text("resolved_winner"),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
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
  // Creator attribution (#247). Nullable because historical tokens
  // predate the column. Developer-role users CRUD only where this
  // matches their user id; Owner/Admin see all.
  createdByUserId: text("created_by_user_id").references(() => users.id),
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
  type: text("type", { enum: ["pii", "content", "regex", "token_limit", "jailbreak"] }).notNull(),
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

export const firewallEvents = sqliteTable("firewall_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  requestId: text("request_id"),
  surface: text("surface", { enum: ["scan", "tool_call_alignment"] }).notNull(),
  source: text("source", { enum: ["user_input", "retrieved_context", "tool_output", "model_output"] }),
  mode: text("mode", { enum: ["signature", "semantic", "hybrid"] }),
  decision: text("decision", { enum: ["allow", "flag", "redact", "block", "quarantine"] }).notNull(),
  action: text("action", { enum: ["allow", "flag", "redact", "block", "quarantine"] }).notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  confidence: real("confidence"),
  riskLevel: text("risk_level"),
  category: text("category"),
  toolName: text("tool_name"),
  ruleName: text("rule_name"),
  matchedContent: text("matched_content"),
  details: text("details"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("firewall_events_tenant_created_idx").on(table.tenantId, table.createdAt),
  index("firewall_events_request_idx").on(table.requestId),
]);

export const firewallSettings = sqliteTable("firewall_settings", {
  tenantId: text("tenant_id").primaryKey(),
  defaultScanMode: text("default_scan_mode", { enum: ["signature", "semantic", "hybrid"] })
    .notNull()
    .default("signature"),
  toolCallAlignment: text("tool_call_alignment", { enum: ["off", "flag", "block"] })
    .notNull()
    .default("block"),
  streamingEnforcement: integer("streaming_enforcement", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const contextOptimizationEvents = sqliteTable("context_optimization_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  inputChunks: integer("input_chunks").notNull(),
  outputChunks: integer("output_chunks").notNull(),
  droppedChunks: integer("dropped_chunks").notNull(),
  nearDuplicateChunks: integer("near_duplicate_chunks").notNull().default(0),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  savedTokens: integer("saved_tokens").notNull(),
  reductionPct: real("reduction_pct").notNull(),
  avgRelevanceScore: real("avg_relevance_score"),
  lowRelevanceChunks: integer("low_relevance_chunks").notNull().default(0),
  rerankedChunks: integer("reranked_chunks").notNull().default(0),
  avgFreshnessScore: real("avg_freshness_score"),
  staleChunks: integer("stale_chunks").notNull().default(0),
  conflictChunks: integer("conflict_chunks").notNull().default(0),
  conflictGroups: integer("conflict_groups").notNull().default(0),
  compressedChunks: integer("compressed_chunks").notNull().default(0),
  compressionSavedTokens: integer("compression_saved_tokens").notNull().default(0),
  compressionRatePct: real("compression_rate_pct").notNull().default(0),
  conflictSourceIds: text("conflict_source_ids").notNull().default("[]"),
  conflictDetails: text("conflict_details").notNull().default("[]"),
  duplicateSourceIds: text("duplicate_source_ids").notNull().default("[]"),
  nearDuplicateSourceIds: text("near_duplicate_source_ids").notNull().default("[]"),
  riskScanned: integer("risk_scanned", { mode: "boolean" }).notNull().default(false),
  flaggedChunks: integer("flagged_chunks").notNull().default(0),
  quarantinedChunks: integer("quarantined_chunks").notNull().default(0),
  riskySourceIds: text("risky_source_ids").notNull().default("[]"),
  riskDetails: text("risk_details").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_optimization_events_tenant_created_idx").on(table.tenantId, table.createdAt),
]);

export const contextQualityEvents = sqliteTable("context_quality_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  rawScore: real("raw_score").notNull(),
  optimizedScore: real("optimized_score").notNull(),
  delta: real("delta").notNull(),
  regressed: integer("regressed", { mode: "boolean" }).notNull().default(false),
  regressionThreshold: real("regression_threshold").notNull(),
  judgeProvider: text("judge_provider").notNull(),
  judgeModel: text("judge_model").notNull(),
  promptHash: text("prompt_hash").notNull(),
  rawSourceIds: text("raw_source_ids").notNull().default("[]"),
  optimizedSourceIds: text("optimized_source_ids").notNull().default("[]"),
  rationale: text("rationale"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_quality_events_tenant_created_idx").on(table.tenantId, table.createdAt),
  index("context_quality_events_tenant_regressed_idx").on(table.tenantId, table.regressed, table.createdAt),
]);

export const contextRetrievalEvents = sqliteTable("context_retrieval_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  optimizationEventId: text("optimization_event_id"),
  retrievedChunks: integer("retrieved_chunks").notNull(),
  usedChunks: integer("used_chunks").notNull(),
  unusedChunks: integer("unused_chunks").notNull(),
  duplicateChunks: integer("duplicate_chunks").notNull(),
  nearDuplicateChunks: integer("near_duplicate_chunks").notNull().default(0),
  riskyChunks: integer("risky_chunks").notNull(),
  retrievedTokens: integer("retrieved_tokens").notNull(),
  usedTokens: integer("used_tokens").notNull(),
  unusedTokens: integer("unused_tokens").notNull(),
  avgRelevanceScore: real("avg_relevance_score"),
  lowRelevanceChunks: integer("low_relevance_chunks").notNull().default(0),
  rerankedChunks: integer("reranked_chunks").notNull().default(0),
  avgFreshnessScore: real("avg_freshness_score"),
  staleChunks: integer("stale_chunks").notNull().default(0),
  conflictChunks: integer("conflict_chunks").notNull().default(0),
  conflictGroups: integer("conflict_groups").notNull().default(0),
  compressedChunks: integer("compressed_chunks").notNull().default(0),
  compressionSavedTokens: integer("compression_saved_tokens").notNull().default(0),
  compressionRatePct: real("compression_rate_pct").notNull().default(0),
  efficiencyPct: real("efficiency_pct").notNull(),
  duplicateRatePct: real("duplicate_rate_pct").notNull(),
  nearDuplicateRatePct: real("near_duplicate_rate_pct").notNull().default(0),
  riskyRatePct: real("risky_rate_pct").notNull(),
  conflictRatePct: real("conflict_rate_pct").notNull().default(0),
  usedSourceIds: text("used_source_ids").notNull().default("[]"),
  unusedSourceIds: text("unused_source_ids").notNull().default("[]"),
  riskySourceIds: text("risky_source_ids").notNull().default("[]"),
  conflictSourceIds: text("conflict_source_ids").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_retrieval_events_tenant_created_idx").on(table.tenantId, table.createdAt),
  index("context_retrieval_events_optimization_idx").on(table.optimizationEventId),
]);

export const contextCollections = sqliteTable("context_collections", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  documentCount: integer("document_count").notNull().default(0),
  blockCount: integer("block_count").notNull().default(0),
  canonicalBlockCount: integer("canonical_block_count").notNull().default(0),
  approvedBlockCount: integer("approved_block_count").notNull().default(0),
  tokenCount: integer("token_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_collections_tenant_updated_idx").on(table.tenantId, table.updatedAt),
  uniqueIndex("context_collections_tenant_name_idx").on(table.tenantId, table.name),
]);

export const contextDocuments = sqliteTable("context_documents", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  collectionId: text("collection_id")
    .notNull()
    .references(() => contextCollections.id),
  title: text("title").notNull(),
  source: text("source"),
  sourceUri: text("source_uri"),
  contentHash: text("content_hash").notNull(),
  metadata: text("metadata").notNull().default("{}"),
  blockCount: integer("block_count").notNull(),
  tokenCount: integer("token_count").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_documents_tenant_collection_idx").on(table.tenantId, table.collectionId),
  index("context_documents_hash_idx").on(table.contentHash),
]);

export const contextSources = sqliteTable("context_sources", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  collectionId: text("collection_id")
    .notNull()
    .references(() => contextCollections.id),
  name: text("name").notNull(),
  type: text("type", { enum: ["manual", "github_repository", "file_upload", "s3_bucket", "confluence_space"] }).notNull().default("manual"),
  externalId: text("external_id"),
  sourceUri: text("source_uri"),
  content: text("content").notNull().default(""),
  contentHash: text("content_hash").notNull(),
  syncStatus: text("sync_status", { enum: ["pending", "synced", "failed"] }).notNull().default("pending"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  lastDocumentId: text("last_document_id").references(() => contextDocuments.id),
  documentCount: integer("document_count").notNull().default(0),
  lastError: text("last_error"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_sources_tenant_collection_idx").on(table.tenantId, table.collectionId),
  index("context_sources_sync_idx").on(table.tenantId, table.syncStatus, table.updatedAt),
  uniqueIndex("context_sources_collection_external_idx").on(table.collectionId, table.externalId),
]);

export const contextConnectorCredentials = sqliteTable("context_connector_credentials", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  type: text("type", { enum: ["github_token", "aws_access_key", "confluence_api_token"] }).notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_connector_credentials_tenant_idx").on(table.tenantId, table.updatedAt),
  uniqueIndex("context_connector_credentials_tenant_name_idx").on(table.tenantId, table.name),
]);

export const contextBlocks = sqliteTable("context_blocks", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  collectionId: text("collection_id")
    .notNull()
    .references(() => contextCollections.id),
  documentId: text("document_id")
    .notNull()
    .references(() => contextDocuments.id),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  tokenCount: integer("token_count").notNull(),
  source: text("source"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_blocks_tenant_collection_idx").on(table.tenantId, table.collectionId),
  index("context_blocks_document_ordinal_idx").on(table.documentId, table.ordinal),
  uniqueIndex("context_blocks_document_ordinal_unique_idx").on(table.documentId, table.ordinal),
]);

export const contextCanonicalBlocks = sqliteTable("context_canonical_blocks", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  collectionId: text("collection_id")
    .notNull()
    .references(() => contextCollections.id),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  tokenCount: integer("token_count").notNull(),
  sourceBlockIds: text("source_block_ids").notNull().default("[]"),
  sourceDocumentIds: text("source_document_ids").notNull().default("[]"),
  sourceCount: integer("source_count").notNull().default(0),
  reviewStatus: text("review_status", { enum: ["draft", "approved", "rejected"] }).notNull().default("draft"),
  reviewNote: text("review_note"),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
  policyStatus: text("policy_status", { enum: ["unchecked", "passed", "failed"] }).notNull().default("unchecked"),
  policyCheckedAt: integer("policy_checked_at", { mode: "timestamp" }),
  policyDetails: text("policy_details").notNull().default("[]"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_canonical_blocks_tenant_collection_idx").on(table.tenantId, table.collectionId),
  index("context_canonical_blocks_review_idx").on(table.tenantId, table.collectionId, table.reviewStatus),
  index("context_canonical_blocks_policy_idx").on(table.tenantId, table.collectionId, table.policyStatus),
  uniqueIndex("context_canonical_blocks_collection_hash_idx").on(table.collectionId, table.contentHash),
]);

export const contextCanonicalReviewEvents = sqliteTable("context_canonical_review_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  collectionId: text("collection_id")
    .notNull()
    .references(() => contextCollections.id),
  canonicalBlockId: text("canonical_block_id")
    .notNull()
    .references(() => contextCanonicalBlocks.id),
  fromStatus: text("from_status", { enum: ["draft", "approved", "rejected"] }).notNull(),
  toStatus: text("to_status", { enum: ["draft", "approved", "rejected"] }).notNull(),
  note: text("note"),
  actorUserId: text("actor_user_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("context_canonical_review_events_tenant_created_idx").on(table.tenantId, table.createdAt),
  index("context_canonical_review_events_block_idx").on(table.canonicalBlockId, table.createdAt),
]);

export const alertRules = sqliteTable("alert_rules", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  metric: text("metric", { enum: ["spend", "latency_p95", "latency_avg", "error_rate", "request_count", "context_policy_failures", "context_stale_drafts", "context_approved_export_delta"] }).notNull(),
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

/**
 * Prompt canary rollouts (#264). A rollout serves a canary version to a
 * percentage of `/v1/prompts/:id/resolve` calls, with the remainder served
 * by the current stable version. Quality feedback on canary traffic is
 * tracked via `requests.prompt_version_id`, and the scheduler evaluates
 * promotion criteria hourly.
 *
 * Lifecycle: active → (promoted | reverted). Exactly one active rollout
 * per prompt template at a time; the API rejects a second start while
 * another is active.
 *
 * `criteria` JSON shape: `{ min_samples: number, max_avg_score_delta: number,
 * window_hours: number }`. A rollout is auto-promoted when both canary
 * samples >= min_samples AND (avg_canary_score - avg_stable_score) >=
 * max_avg_score_delta (i.e. the canary didn't drop more than the threshold).
 */
export const promptRollouts = sqliteTable("prompt_rollouts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  templateId: text("template_id")
    .notNull()
    .references(() => promptTemplates.id),
  canaryVersionId: text("canary_version_id")
    .notNull()
    .references(() => promptVersions.id),
  stableVersionId: text("stable_version_id")
    .notNull()
    .references(() => promptVersions.id),
  rolloutPct: integer("rollout_pct").notNull(),
  criteria: text("criteria", { mode: "json" })
    .$type<{ min_samples: number; max_avg_score_delta: number; window_hours: number }>()
    .notNull(),
  status: text("status", { enum: ["active", "promoted", "reverted"] })
    .notNull()
    .default("active"),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  completionReason: text("completion_reason"),
});

export const modelScores = sqliteTable("model_scores", {
  tenantId: text("tenant_id").notNull().default(""),
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
  primaryKey({ columns: [table.tenantId, table.taskType, table.complexity, table.provider, table.model] }),
]);

/**
 * Per-tenant adaptive isolation toggles (#176 / #195). Rows exist only for
 * tenants that have ever had their toggles touched — absence means "tier
 * defaults apply". The live policy is computed by
 * `tenantAdaptiveIsolationPolicy(db, tenantId)` which layers defaults +
 * this row.
 *
 * Boolean semantics (SQLite ints 0/1). Toggles are valid only for Team
 * and Enterprise tiers; API-side enforcement rejects writes from Free
 * and Pro tenants.
 */
export const tenantAdaptiveIsolation = sqliteTable("tenant_adaptive_isolation", {
  tenantId: text("tenant_id").primaryKey(),
  consumesPool: integer("consumes_pool", { mode: "boolean" }).notNull().default(false),
  contributesPool: integer("contributes_pool", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Append-only audit log of every change to a tenant's isolation toggles.
 * Supports Enterprise "when was I contributing to the pool?" audits and
 * our own debugging. `changedBy` is the user id that performed the
 * change, or a literal `"operator"` for admin overrides.
 */
export const adaptiveIsolationPreferencesLog = sqliteTable("adaptive_isolation_preferences_log", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  field: text("field").notNull(), // 'consumes_pool' | 'contributes_pool'
  oldValue: integer("old_value", { mode: "boolean" }).notNull(),
  newValue: integer("new_value", { mode: "boolean" }).notNull(),
  changedAt: integer("changed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  changedBy: text("changed_by").notNull(),
});

/**
 * Persistent playground conversations. Sessions are tenant-scoped; the
 * `messages` column stores the full transcript as JSON (serialized
 * `ChatMessage[]`) because turns are a UI grouping, not an analytics
 * primitive — per-turn data already lives in `requests` + `feedback`.
 */
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  title: text("title").notNull(),
  messages: text("messages").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Public share tokens for saved conversations. A row here grants anyone
 * holding the token read access to the referenced conversation without
 * auth. The token is a long random string (nanoid) so guessing is
 * impractical; `revokedAt` lets the owner turn off access after the fact
 * without deleting the row (preserves audit trail).
 */
export const shares = sqliteTable("shares", {
  token: text("token").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  tenantId: text("tenant_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

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

/**
 * Bank of representative historical prompts used for silent-regression
 * detection (#152). One row per `(tenantId, cell, provider/model, prompt)`;
 * populated by a daily job that picks high-signal prompts (user-rated or
 * judge-scored ≥ 4) with embedding-based diversity sampling. The replay
 * job draws from this table and compares re-run output quality against
 * `originalScore`. Embedding is stored so diversity ranking survives a
 * restart and we can reject cross-model vectors on lookup.
 */
export const replayBank = sqliteTable("replay_bank", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  taskType: text("task_type").notNull(),
  complexity: text("complexity").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** Original user prompt (serialized messages JSON). */
  prompt: text("prompt").notNull(),
  /** Original assistant response captured when the prompt was eligible. */
  response: text("response").notNull(),
  /** 1–5 score at capture time — either user-rated or judge-scored. */
  originalScore: real("original_score").notNull(),
  originalScoreSource: text("original_score_source", { enum: ["user", "judge"] }).notNull(),
  /** Source requestId for traceability. */
  sourceRequestId: text("source_request_id"),
  embedding: blob("embedding", { mode: "buffer" }),
  embeddingDim: integer("embedding_dim"),
  embeddingModel: text("embedding_model"),
  lastReplayedAt: integer("last_replayed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Per-cell regression detection events (#152). One row per detection;
 * history is preserved so the UI can show "this cell regressed 3 times
 * in the last 30 days." `resolvedAt` is null while the alert is live;
 * operators flip it when they've actioned the regression (rollback,
 * migration, or explicit dismissal).
 */
export const regressionEvents = sqliteTable("regression_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  taskType: text("task_type").notNull(),
  complexity: text("complexity").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** Number of bank prompts replayed in this batch. */
  replayCount: integer("replay_count").notNull(),
  /** Mean of the captured originalScore values (baseline). */
  originalMean: real("original_mean").notNull(),
  /** Mean of the judge's re-run scores. */
  replayMean: real("replay_mean").notNull(),
  /** replayMean − originalMean. Negative = regression. */
  delta: real("delta").notNull(),
  /** Total API spend this replay cycle cost (USD). */
  costUsd: real("cost_usd").notNull().default(0),
  detectedAt: integer("detected_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  resolutionNote: text("resolution_note"),
});

/**
 * Automated cell-level cost migrations (#153). One row per executed
 * migration — the adaptive router consults this table for a
 * `graceBoost` during the grace window so the newly-selected cheaper
 * model gets time to prove itself under live traffic. `rolledBackAt`
 * stays null unless regression detection (#152) or an operator flips
 * it — we preserve history regardless of outcome so savings claims are
 * auditable.
 */
export const costMigrations = sqliteTable("cost_migrations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  taskType: text("task_type").notNull(),
  complexity: text("complexity").notNull(),
  fromProvider: text("from_provider").notNull(),
  fromModel: text("from_model").notNull(),
  fromCostPer1M: real("from_cost_per_1m").notNull(),
  fromQualityScore: real("from_quality_score").notNull(),
  toProvider: text("to_provider").notNull(),
  toModel: text("to_model").notNull(),
  toCostPer1M: real("to_cost_per_1m").notNull(),
  toQualityScore: real("to_quality_score").notNull(),
  /** Savings floor — projected monthly USD based on traffic pattern at execute time. */
  projectedMonthlySavingsUsd: real("projected_monthly_savings_usd").notNull().default(0),
  /** Grace-period end. Router ends the boost at this timestamp. */
  graceEndsAt: integer("grace_ends_at", { mode: "timestamp" }).notNull(),
  executedAt: integer("executed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  rolledBackAt: integer("rolled_back_at", { mode: "timestamp" }),
  rollbackReason: text("rollback_reason"),
});

/**
 * Pending team invites (#177). One row per invite; token is the PK
 * and doubles as the shareable-link secret — treat with care. When
 * an OAuth signin's email matches an unconsumed, unexpired row, the
 * signup lands in the invite's tenant instead of a fresh one.
 *
 * Atomic claim: `consumed_at` is the lock. The OAuth handler uses
 * UPDATE ... WHERE consumed_at IS NULL so two simultaneous claims of
 * the same invite can't both win.
 *
 * Email matching is case-insensitive (LOWER(email) comparison) since
 * OAuth providers return inconsistent casings.
 */
export const teamInvites = sqliteTable("team_invites", {
  token: text("token").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  invitedEmail: text("invited_email").notNull(),
  invitedRole: text("invited_role", { enum: ["owner", "admin", "developer", "viewer"] }).notNull().default("developer"),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp" }),
  consumedByUserId: text("consumed_by_user_id").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("team_invites_tenant_email_idx").on(table.tenantId, table.invitedEmail),
]);

/**
 * Subscription state mirror for Stripe (#167). The `subscriptions` table
 * is not a source of truth — Stripe is. This table caches enough state
 * for the gateway's feature-gate middleware to answer "what tier is this
 * tenant on?" without hitting the Stripe API on every request.
 *
 * Rows are upserted by the webhook handler when Stripe fires lifecycle
 * events. `tier` and `includes_intelligence` are denormalized from the
 * Stripe Product's metadata at write time so feature-gate reads are one
 * row away from a decision.
 */
export const subscriptions = sqliteTable("subscriptions", {
  stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  stripeProductId: text("stripe_product_id").notNull(),
  /** Denormalized from product.metadata.tier for fast feature-gate reads. */
  tier: text("tier").notNull(),
  includesIntelligence: integer("includes_intelligence", { mode: "boolean" }).notNull().default(false),
  status: text("status", {
    enum: ["active", "past_due", "canceled", "trialing", "unpaid", "incomplete", "incomplete_expired", "paused"],
  }).notNull(),
  currentPeriodStart: integer("current_period_start", { mode: "timestamp" }).notNull(),
  currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }).notNull(),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  trialEnd: integer("trial_end", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("subscriptions_tenant_idx").on(table.tenantId),
  uniqueIndex("subscriptions_customer_idx").on(table.stripeCustomerId),
]);

/**
 * Stripe webhook event dedupe table. Stripe can retry any event up to
 * 3 days on 2xx-non-response; the handler needs to dedupe by event.id
 * to avoid double-processing. Row is written with processedAt only
 * after the handler succeeds; on retry we see the row and skip.
 */
export const stripeWebhookEvents = sqliteTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  /** Raw JSON payload kept for debugging; dropped on a regular schedule. */
  payload: text("payload"),
});

/**
 * Usage report high-water marks (#170). One row per
 * (stripe_subscription_id, period_start) — tracks how much overage has
 * already been pushed to Stripe's metered billing so nightly cycles
 * only report the delta. Primary-key on (sub, period_start) so period
 * rollover automatically produces a fresh row without interfering with
 * the previous period's auditable record.
 *
 * `reported_overage_count` is the cumulative total we've reported to
 * Stripe for this subscription during this period. The delta sent on
 * any given night is `(current_overage - reported_overage_count)`.
 * Stripe dedupes its own side via our `stripe_event_id` (the meter
 * event identifier we set per push).
 *
 * Safe to run the cycle twice: if `current_overage <= reported_count`,
 * no push happens.
 */
export const usageReports = sqliteTable("usage_reports", {
  id: text("id").primaryKey(),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  periodStart: integer("period_start", { mode: "timestamp" }).notNull(),
  periodEnd: integer("period_end", { mode: "timestamp" }).notNull(),
  /** Cumulative overage requests reported to Stripe this period (high-water mark). */
  reportedOverageCount: integer("reported_overage_count").notNull().default(0),
  /** Cumulative billable overage delta pushed to Stripe. Sanity-check field. */
  totalPushedUsd: real("total_pushed_usd").notNull().default(0),
  reportedAt: integer("reported_at", { mode: "timestamp" }),
  /** Most recent meter event identifier sent to Stripe — for dedupe audit. */
  lastEventIdentifier: text("last_event_identifier"),
  /**
   * When the period this row covers was fully reconciled — i.e. a
   * final-delta meter event was pushed to Stripe with a timestamp
   * inside the closed period. Null while the period is still open
   * (current billing cycle) or was never flushed. Self-healing
   * rollover logic reads this to decide whether an old period row
   * needs a final push.
   */
  finalizedAt: integer("finalized_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("usage_reports_sub_period_idx").on(table.stripeSubscriptionId, table.periodStart),
  uniqueIndex("usage_reports_tenant_period_idx").on(table.tenantId, table.periodStart),
]);

/**
 * Persistent state for the in-process scheduler. One row per named job.
 * Survives restart so re-scheduled jobs can resume their cadence and the
 * UI can surface last-run telemetry. The scheduler itself still lives
 * in-memory — this is observability + restart continuity, not a queue.
 */
export const scheduledJobs = sqliteTable("scheduled_jobs", {
  name: text("name").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  intervalMs: integer("interval_ms").notNull(),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  lastStatus: text("last_status", { enum: ["ok", "error", "skipped"] }),
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
  runCount: integer("run_count").notNull().default(0),
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
  /**
   * Denormalized attribution for spend-intelligence aggregations (#219).
   * Mirrors the parent `requests` row so per-user / per-token spend
   * queries hit `cost_logs` alone with a covering index, without a join.
   */
  userId: text("user_id"),
  apiTokenId: text("api_token_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("cost_logs_tenant_user_created_idx").on(table.tenantId, table.userId, table.createdAt),
  index("cost_logs_tenant_token_created_idx").on(table.tenantId, table.apiTokenId, table.createdAt),
]);

/**
 * Audit log (#210). Append-only record of security- and admin-relevant
 * events per tenant. NOT a substitute for the `requests` table — API
 * traffic lives there and has its own retention; audit rows are for
 * things a compliance auditor or security admin would ask about
 * (logins, API-key rotations, subscription changes, admin actions).
 *
 * Immutability invariant is enforced at the app layer: only
 * `emitAudit()` writes; only the retention purge job deletes; nothing
 * issues UPDATE. A future tamper-evidence hash chain can layer on top
 * without schema change (add a `chain_hash` column in a sibling issue).
 *
 * `actor_user_id` is nullable for system-emitted events (scheduled
 * jobs, webhook-driven billing transitions). `actor_email` is
 * denormalized so the display "Alice deleted API key X" survives the
 * user being removed from the tenant.
 *
 * `metadata` is free-form JSON — request IP, user-agent, before/after
 * diff for updates, Stripe subscription ID, etc. Kept flexible on
 * purpose; audit consumers (UI filter, CSV export, SIEM pull) treat it
 * as an opaque blob.
 */
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  actorUserId: text("actor_user_id"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("audit_logs_tenant_created_idx").on(table.tenantId, table.createdAt),
  index("audit_logs_tenant_action_created_idx").on(table.tenantId, table.action, table.createdAt),
]);

/**
 * Spend budgets (#219/T7). One budget per tenant for v1 — the tenant
 * picks a monthly or quarterly cap, a list of alert thresholds (%) and
 * a list of email recipients. The budget-alerts scheduler job re-checks
 * spend daily; when a new threshold is crossed, it appends the threshold
 * to `alerted_thresholds` and sends an email. Thresholds reset when the
 * period rolls over (tracked via `period_started_at`).
 *
 * `hard_stop=true` flips the hot-path chat-completions handler from
 * "warn by email only" to "refuse with 402 when at or over cap" —
 * belt-and-suspenders for tenants that want a genuine ceiling rather
 * than an advisory alarm. Default is off; explicit opt-in.
 *
 * `alert_thresholds` / `alert_emails` / `alerted_thresholds` are stored
 * as JSON arrays to keep the table free of child-row bookkeeping. At
 * most a handful of entries each in practice.
 */
/**
 * Daily routing-weight snapshots (#219/T5). One row per
 * (tenant, task_type, complexity) per captured_at day. Drives the
 * drift-correlation view: "last Thursday you pushed cost-weight from
 * 0.4 to 0.7 and anthropic's spend share dropped 28 points in the
 * week after".
 *
 * For v1 `task_type` and `complexity` are the literal strings
 * `"_all_"` / `"_all_"` — per-tenant weights, not per-cell. The
 * columns exist so that a future per-cell weights feature can populate
 * them without a schema migration.
 *
 * `weights` stores the fully-resolved 3-tuple `{quality, cost, latency}`
 * so readers don't have to reverse-resolve a profile name at read time.
 * Append-only; purged by the same retention policy as audit logs.
 */
export const routingWeightSnapshots = sqliteTable("routing_weight_snapshots", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  taskType: text("task_type").notNull().default("_all_"),
  complexity: text("complexity").notNull().default("_all_"),
  weights: text("weights", { mode: "json" }).$type<{ quality: number; cost: number; latency: number }>().notNull(),
  profile: text("profile"),
  capturedAt: integer("captured_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("rws_tenant_captured_idx").on(table.tenantId, table.capturedAt),
]);

export const spendBudgets = sqliteTable("spend_budgets", {
  tenantId: text("tenant_id").primaryKey(),
  period: text("period", { enum: ["monthly", "quarterly"] }).notNull().default("monthly"),
  capUsd: real("cap_usd").notNull(),
  alertThresholds: text("alert_thresholds", { mode: "json" }).$type<number[]>().notNull(),
  alertEmails: text("alert_emails", { mode: "json" }).$type<string[]>().notNull(),
  hardStop: integer("hard_stop", { mode: "boolean" }).notNull().default(false),
  alertedThresholds: text("alerted_thresholds", { mode: "json" }).$type<number[]>().notNull(),
  periodStartedAt: integer("period_started_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * SAML SSO configuration per tenant (#209). Ops-managed in v1 — seeded
 * by operators via a CLI per Enterprise deal, not self-serve in the
 * dashboard. Exactly one row per tenant (PK on tenant_id).
 *
 * When a row exists with status="active", members of that tenant are
 * forced through the SSO flow and refused magic-link / Google OAuth
 * logins for any email domain in `email_domains`. Operator accounts
 * (PROVARA_OPERATOR_EMAILS) always bypass this gate.
 *
 * `idp_cert` is the IdP's X.509 signing certificate in PEM format
 * (full `-----BEGIN CERTIFICATE-----` block, including newlines).
 * `email_domains` is JSON-encoded `string[]` — e.g. ["acme.com"].
 */
export const ssoConfigs = sqliteTable("sso_configs", {
  tenantId: text("tenant_id").primaryKey(),
  idpEntityId: text("idp_entity_id").notNull(),
  idpSsoUrl: text("idp_sso_url").notNull(),
  idpCert: text("idp_cert").notNull(),
  spEntityId: text("sp_entity_id").notNull(),
  emailDomains: text("email_domains", { mode: "json" }).$type<string[]>().notNull(),
  requireEncryption: integer("require_encryption", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Eval datasets and runs (#262). A dataset is a JSONL-encoded collection
 * of input cases; a run executes every case against a (provider, model)
 * pair and grades each output with the existing judge pipeline.
 *
 * MVP skips per-case expected outputs and pass/fail logic — the judge's
 * 1–5 quality score is the primary signal. A follow-up will add
 * expected-output matching and CI integration.
 */
export const evalDatasets = sqliteTable("eval_datasets", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  name: text("name").notNull(),
  description: text("description"),
  /** JSONL string — one case per line, shape `{input: ChatMessage[], expected?: string, metadata?: object}`. */
  casesJsonl: text("cases_jsonl").notNull(),
  caseCount: integer("case_count").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const evalRuns = sqliteTable("eval_runs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id"),
  datasetId: text("dataset_id")
    .notNull()
    .references(() => evalDatasets.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** Status lifecycle: queued → running → (completed | failed). Set to `failed`
   *  if the executor crashes before finishing; partial results still persist. */
  status: text("status", { enum: ["queued", "running", "completed", "failed"] })
    .notNull()
    .default("queued"),
  /** Aggregate average score across all cases with a non-null score. Recomputed
   *  each time results land so the UI can render a live-updating number. */
  avgScore: real("avg_score"),
  totalCost: real("total_cost"),
  /** Scoring strategy for this run. `llm-judge` preserves the original 1-5
   *  judge-grading behavior. `exact-match` and `regex-match` compare the
   *  target's output against the case's `expected` field and produce 5
   *  (pass) or 1 (fail) — enables golden-label evaluation for classifiers
   *  and structured outputs, where LLM-as-judge is the wrong tool. */
  scorer: text("scorer", { enum: ["llm-judge", "exact-match", "regex-match"] })
    .notNull()
    .default("llm-judge"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const evalResults = sqliteTable("eval_results", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => evalRuns.id),
  caseIndex: integer("case_index").notNull(),
  /** Stored for the run view so we don't re-read the dataset JSONL for display. */
  input: text("input").notNull(),
  output: text("output"),
  score: integer("score"),
  judgeSource: text("judge_source"),
  error: text("error"),
  latencyMs: integer("latency_ms"),
  cost: real("cost"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("eval_results_run_idx").on(table.runId),
]);
