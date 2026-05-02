import { Hono } from "hono";
import type { Db } from "@provara/db";
import {
  compressContextOptimizationResult,
  estimateContextTokens,
  optimizeContextChunks,
  rankContextOptimizationResultLexically,
  rankContextOptimizationResultWithEmbeddings,
  type ContextChunk,
  type ContextOptimizationOptions,
  type ContextOptimizationResult,
  type OptimizedContextChunk,
  type RiskyContextChunk,
} from "../context/optimizer.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../embeddings/index.js";
import {
  listContextOptimizationEvents,
  recordContextOptimizationEvent,
  summarizeContextOptimizationEvents,
} from "../context/events.js";
import {
  evaluateContextQuality,
  listContextQualityEvents,
  summarizeContextQualityEvents,
} from "../context/quality.js";
import {
  listContextRetrievalEvents,
  recordContextRetrievalEvent,
  summarizeContextRetrievalEvents,
} from "../context/retrieval.js";
import {
  createContextCollection,
  distillContextCollection,
  exportApprovedContextBlocks,
  getContextCanonicalBlock,
  ingestContextDocument,
  listContextCanonicalBlocks,
  listContextCanonicalReviewEvents,
  listContextCollections,
  recordContextCanonicalPolicyCheck,
  updateContextCanonicalBlockReview,
  validateCreateCollectionBody,
  validateIngestDocumentBody,
  validateReviewStatusBody,
} from "../context/store.js";
import { getSessionUserId, getTenantId } from "../auth/tenant.js";
import { ensureBuiltInRules, loadRules, scanContent } from "../guardrails/engine.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { Provider } from "../providers/types.js";

type CanonicalReviewStatus = "draft" | "approved" | "rejected";

const MAX_CHUNKS = 200;
const MAX_CHUNK_CHARS = 100_000;
const ABSTRACTIVE_COMPRESSION_BATCH_SIZE = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateChunks(value: unknown): { chunks?: ContextChunk[]; error?: string } {
  if (!Array.isArray(value)) return { error: "chunks must be an array" };
  if (value.length === 0) return { error: "chunks must contain at least one item" };
  if (value.length > MAX_CHUNKS) return { error: `chunks must contain at most ${MAX_CHUNKS} items` };

  const chunks: ContextChunk[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { error: `chunks[${index}] must be an object` };
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      return { error: `chunks[${index}].id is required` };
    }
    if (typeof item.content !== "string" || item.content.length === 0) {
      return { error: `chunks[${index}].content is required` };
    }
    if (item.content.length > MAX_CHUNK_CHARS) {
      return { error: `chunks[${index}].content exceeds ${MAX_CHUNK_CHARS} characters` };
    }
    if (item.source !== undefined && typeof item.source !== "string") {
      return { error: `chunks[${index}].source must be a string` };
    }
    if (item.metadata !== undefined && !isRecord(item.metadata)) {
      return { error: `chunks[${index}].metadata must be an object` };
    }

    chunks.push({
      id: item.id,
      content: item.content,
      source: typeof item.source === "string" ? item.source : undefined,
      metadata: isRecord(item.metadata) ? item.metadata : undefined,
    });
  }

  return { chunks };
}

function validateScanRisk(value: unknown): { scanRisk?: boolean; error?: string } {
  if (value === undefined) return { scanRisk: false };
  if (typeof value !== "boolean") return { error: "scanRisk must be a boolean" };
  return { scanRisk: value };
}

function validateDedupeOptions(value: Record<string, unknown>): { options?: ContextOptimizationOptions; error?: string } {
  const mode = value.dedupeMode;
  if (mode !== undefined && mode !== "exact" && mode !== "semantic") {
    return { error: "dedupeMode must be either exact or semantic" };
  }
  const threshold = value.semanticThreshold;
  if (
    threshold !== undefined &&
    (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 1)
  ) {
    return { error: "semanticThreshold must be a number between 0.5 and 1" };
  }

  const rankMode = value.rankMode;
  if (rankMode !== undefined && rankMode !== "none" && rankMode !== "lexical" && rankMode !== "embedding") {
    return { error: "rankMode must be either none, lexical, or embedding" };
  }
  const query = value.query;
  if (query !== undefined && (typeof query !== "string" || query.length > 2000)) {
    return { error: "query must be a string with at most 2000 characters" };
  }
  const minRelevanceScore = value.minRelevanceScore;
  if (
    minRelevanceScore !== undefined &&
    (typeof minRelevanceScore !== "number" || !Number.isFinite(minRelevanceScore) || minRelevanceScore < 0 || minRelevanceScore > 1)
  ) {
    return { error: "minRelevanceScore must be a number between 0 and 1" };
  }
  const freshnessMode = value.freshnessMode;
  if (freshnessMode !== undefined && freshnessMode !== "off" && freshnessMode !== "metadata") {
    return { error: "freshnessMode must be either off or metadata" };
  }
  const maxContextAgeDays = value.maxContextAgeDays;
  if (
    maxContextAgeDays !== undefined &&
    (
      typeof maxContextAgeDays !== "number" ||
      !Number.isFinite(maxContextAgeDays) ||
      maxContextAgeDays < 1 ||
      maxContextAgeDays > 3650
    )
  ) {
    return { error: "maxContextAgeDays must be a number between 1 and 3650" };
  }
  const referenceTime = value.referenceTime;
  let parsedReferenceTime: Date | undefined;
  if (referenceTime !== undefined) {
    if (typeof referenceTime !== "string" || referenceTime.length > 64) {
      return { error: "referenceTime must be an ISO timestamp string" };
    }
    const millis = Date.parse(referenceTime);
    if (!Number.isFinite(millis)) {
      return { error: "referenceTime must be an ISO timestamp string" };
    }
    parsedReferenceTime = new Date(millis);
  }
  const conflictMode = value.conflictMode;
  if (conflictMode !== undefined && conflictMode !== "off" && conflictMode !== "heuristic" && conflictMode !== "scored") {
    return { error: "conflictMode must be either off, heuristic, or scored" };
  }
  const compressionMode = value.compressionMode;
  if (
    compressionMode !== undefined &&
    compressionMode !== "off" &&
    compressionMode !== "extractive" &&
    compressionMode !== "abstractive"
  ) {
    return { error: "compressionMode must be either off, extractive, or abstractive" };
  }
  const maxSentencesPerChunk = value.maxSentencesPerChunk;
  if (
    maxSentencesPerChunk !== undefined &&
    (
      typeof maxSentencesPerChunk !== "number" ||
      !Number.isFinite(maxSentencesPerChunk) ||
      maxSentencesPerChunk < 1 ||
      maxSentencesPerChunk > 8
    )
  ) {
    return { error: "maxSentencesPerChunk must be a number between 1 and 8" };
  }

  return {
    options: {
      dedupeMode: mode === "semantic" ? "semantic" : "exact",
      semanticThreshold: typeof threshold === "number" ? threshold : undefined,
      rankMode: rankMode === "lexical" || rankMode === "embedding" ? rankMode : "none",
      query: typeof query === "string" ? query : undefined,
      minRelevanceScore: typeof minRelevanceScore === "number" ? minRelevanceScore : undefined,
      freshnessMode: freshnessMode === "metadata" ? "metadata" : "off",
      maxContextAgeDays: typeof maxContextAgeDays === "number" ? maxContextAgeDays : undefined,
      referenceTime: parsedReferenceTime,
      conflictMode: conflictMode === "heuristic" || conflictMode === "scored" ? conflictMode : "off",
      compressionMode: compressionMode === "extractive" || compressionMode === "abstractive" ? compressionMode : "off",
      maxSentencesPerChunk: typeof maxSentencesPerChunk === "number" ? maxSentencesPerChunk : undefined,
    },
  };
}

function validateStringArray(value: unknown, field: string): { values?: string[]; error?: string } {
  if (value === undefined) return { values: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array` };
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { error: `${field}[${index}] must be a non-empty string` };
    }
    values.push(item);
  }
  return { values };
}

function validateQualityBody(value: unknown): {
  input?: {
    prompt: string;
    rawAnswer: string;
    optimizedAnswer: string;
    rawSourceIds: string[];
    optimizedSourceIds: string[];
    regressionThreshold?: number;
  };
  error?: string;
} {
  if (!isRecord(value)) return { error: "body must be an object" };
  const prompt = value.prompt;
  const rawAnswer = value.rawAnswer;
  const optimizedAnswer = value.optimizedAnswer;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { error: "prompt is required" };
  }
  if (typeof rawAnswer !== "string" || rawAnswer.trim().length === 0) {
    return { error: "rawAnswer is required" };
  }
  if (typeof optimizedAnswer !== "string" || optimizedAnswer.trim().length === 0) {
    return { error: "optimizedAnswer is required" };
  }
  const rawSourceIds = validateStringArray(value.rawSourceIds, "rawSourceIds");
  if (!rawSourceIds.values) return { error: rawSourceIds.error };
  const optimizedSourceIds = validateStringArray(value.optimizedSourceIds, "optimizedSourceIds");
  if (!optimizedSourceIds.values) return { error: optimizedSourceIds.error };
  if (
    value.regressionThreshold !== undefined &&
    (typeof value.regressionThreshold !== "number" || !Number.isFinite(value.regressionThreshold))
  ) {
    return { error: "regressionThreshold must be a number" };
  }

  return {
    input: {
      prompt,
      rawAnswer,
      optimizedAnswer,
      rawSourceIds: rawSourceIds.values,
      optimizedSourceIds: optimizedSourceIds.values,
      regressionThreshold: typeof value.regressionThreshold === "number" ? value.regressionThreshold : undefined,
    },
  };
}

function conflictSeverityFromScore(score: number): "low" | "medium" | "high" {
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium";
  return "low";
}

function recalculateMetrics(result: ContextOptimizationResult): ContextOptimizationResult {
  const outputTokens = result.optimized.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const savedTokens = Math.max(0, result.metrics.inputTokens - outputTokens);
  const relevanceScores = result.optimized
    .map((chunk) => chunk.relevanceScore)
    .filter((score): score is number => typeof score === "number");
  const avgRelevanceScore = relevanceScores.length === 0
    ? null
    : Number((relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length).toFixed(4));
  const freshnessScores = result.optimized
    .map((chunk) => chunk.freshnessScore)
    .filter((score): score is number => typeof score === "number");
  const avgFreshnessScore = freshnessScores.length === 0
    ? null
    : Number((freshnessScores.reduce((sum, score) => sum + score, 0) / freshnessScores.length).toFixed(4));
  const safeIds = new Set(result.optimized.map((chunk) => chunk.id));
  const conflicts = result.conflicts.filter((conflict) => (
    conflict.chunkIds.every((chunkId) => safeIds.has(chunkId))
  ));
  const conflictChunkIds = new Set(conflicts.flatMap((conflict) => conflict.chunkIds));
  const conflictGroupIds = new Map<string, string[]>();
  const conflictScores = new Map<string, number>();
  for (const conflict of conflicts) {
    for (const chunkId of conflict.chunkIds) {
      conflictGroupIds.set(chunkId, [...(conflictGroupIds.get(chunkId) ?? []), conflict.id]);
      conflictScores.set(chunkId, Math.max(conflictScores.get(chunkId) ?? 0, conflict.score ?? 0));
    }
  }
  const optimized = result.optimized.map((chunk) => {
    const groupIds = conflictGroupIds.get(chunk.id);
    if (!groupIds) {
      return {
        ...chunk,
        conflict: undefined,
        conflictGroupIds: undefined,
        conflictSeverity: undefined,
      };
    }
    return {
      ...chunk,
      conflict: true,
      conflictGroupIds: groupIds,
      conflictSeverity: conflictSeverityFromScore(conflictScores.get(chunk.id) ?? 0),
    };
  });
  const compressionSavedTokens = result.optimized.reduce(
    (sum, chunk) => sum + Math.max(0, (chunk.originalTokens ?? chunk.inputTokens) - chunk.outputTokens),
    0,
  );
  const preCompressionTokens = outputTokens + compressionSavedTokens;
  return {
    ...result,
    optimized,
    conflicts,
    metrics: {
      ...result.metrics,
      outputChunks: result.optimized.length,
      flaggedChunks: result.flagged.length,
      quarantinedChunks: result.quarantined.length,
      outputTokens,
      savedTokens,
      reductionPct: result.metrics.inputTokens === 0
        ? 0
        : Number(((savedTokens / result.metrics.inputTokens) * 100).toFixed(2)),
      avgRelevanceScore,
      lowRelevanceChunks: relevanceScores.length === 0
        ? 0
        : result.optimized.filter((chunk) => (chunk.relevanceScore ?? 0) < 0.2).length,
      avgFreshnessScore,
      staleChunks: result.optimized.filter((chunk) => chunk.stale).length,
      conflictChunks: optimized.filter((chunk) => conflictChunkIds.has(chunk.id)).length,
      conflictGroups: conflicts.length,
      compressedChunks: result.optimized.filter((chunk) => chunk.compressed).length,
      compressionSavedTokens,
      compressionRatePct: preCompressionTokens === 0
        ? 0
        : Number(((compressionSavedTokens / preCompressionTokens) * 100).toFixed(2)),
    },
  };
}

async function applyRiskScan(
  db: Db,
  tenantId: string | null,
  result: ContextOptimizationResult,
): Promise<ContextOptimizationResult> {
  await ensureBuiltInRules(db, tenantId);
  const rules = await loadRules(db, tenantId);
  if (rules.length === 0) return result;

  const safe: OptimizedContextChunk[] = [];
  const flagged: RiskyContextChunk[] = [];
  const quarantined: RiskyContextChunk[] = [];

  for (const chunk of result.optimized) {
    const scan = scanContent(chunk.content, rules, "retrieved_context");
    if (scan.decision === "allow") {
      safe.push(chunk);
      continue;
    }

    const risky: RiskyContextChunk = {
      ...chunk,
      decision: scan.decision === "block" ? "quarantine" : scan.decision,
      ruleName: scan.violations[0]?.ruleName ?? null,
      matchedContent: scan.violations[0]?.matchedSnippet ?? null,
    };

    if (risky.decision === "flag" || risky.decision === "redact") {
      flagged.push(risky);
    } else {
      quarantined.push(risky);
    }
  }

  return recalculateMetrics({
    ...result,
    optimized: safe,
    flagged,
    quarantined,
  });
}

export interface ContextRouteOptions {
  embeddings?: EmbeddingProvider | null;
  dbKeys?: Record<string, string>;
}

async function applyRequestedRanking(
  result: ContextOptimizationResult,
  options: ContextOptimizationOptions,
  routeOptions: ContextRouteOptions,
): Promise<ContextOptimizationResult> {
  if (options.rankMode === "lexical") {
    return result;
  }
  if (options.rankMode !== "embedding") {
    return result;
  }

  const embeddings = routeOptions.embeddings !== undefined
    ? routeOptions.embeddings
    : createEmbeddingProvider({ dbKeys: routeOptions.dbKeys });
  if (!embeddings) {
    return rankContextOptimizationResultLexically(result, {
      query: options.query,
      minRelevanceScore: options.minRelevanceScore,
    });
  }

  try {
    return await rankContextOptimizationResultWithEmbeddings(result, embeddings, {
      query: options.query,
      minRelevanceScore: options.minRelevanceScore,
    });
  } catch {
    return rankContextOptimizationResultLexically(result, {
      query: options.query,
      minRelevanceScore: options.minRelevanceScore,
    });
  }
}

function resolveCompressionTarget(registry?: ProviderRegistry): { provider: Provider; model: string } | null {
  if (!registry) return null;
  const providerName = process.env.PROVARA_CONTEXT_COMPRESSION_PROVIDER;
  const modelName = process.env.PROVARA_CONTEXT_COMPRESSION_MODEL;
  if (providerName && modelName) {
    const provider = registry.get(providerName);
    return provider && provider.models.includes(modelName) ? { provider, model: modelName } : null;
  }
  if (modelName) {
    const provider = registry.getForModel(modelName);
    return provider ? { provider, model: modelName } : null;
  }
  for (const provider of registry.list()) {
    const model = provider.models[0];
    if (model) return { provider, model };
  }
  return null;
}

function stripSummaryScaffolding(content: string): string {
  return content
    .replace(/^```(?:text|markdown)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function buildCompressionPrompt(chunk: OptimizedContextChunk, query: string | undefined): string {
  const sourceIds = chunk.sourceIds.join(", ");
  return [
    "Compress the retrieved context below for model input.",
    "Keep only facts supported by the source text. Do not add new facts.",
    "Preserve names, numbers, dates, statuses, policy limits, and caveats.",
    "Return plain text only. No bullets unless the source text requires them.",
    query ? `User query: ${query}` : "",
    `Source IDs: ${sourceIds}`,
    "",
    "Retrieved context:",
    chunk.content,
  ].filter(Boolean).join("\n");
}

async function summarizeChunk(
  chunk: OptimizedContextChunk,
  target: { provider: Provider; model: string },
  query: string | undefined,
): Promise<OptimizedContextChunk | null> {
  const response = await target.provider.complete({
    model: target.model,
    routing_hint: "summarization",
    temperature: 0,
    max_tokens: Math.max(64, Math.min(512, Math.ceil(chunk.outputTokens * 0.7))),
    messages: [
      {
        role: "system",
        content: "You compress retrieved context for downstream model calls. You only preserve supported facts.",
      },
      {
        role: "user",
        content: buildCompressionPrompt(chunk, query),
      },
    ],
  });

  if (response.finish_reason === "content_filter") return null;
  const content = stripSummaryScaffolding(response.content);
  if (!content) return null;
  const compressedTokens = estimateContextTokens(content);
  if (compressedTokens >= chunk.outputTokens) return null;

  return {
    ...chunk,
    content,
    outputTokens: compressedTokens,
    compressed: true,
    originalTokens: chunk.originalTokens ?? chunk.outputTokens,
    compressedTokens,
  };
}

async function compressContextOptimizationResultAbstractively(
  result: ContextOptimizationResult,
  registry: ProviderRegistry | undefined,
  options: { query?: string; maxSentencesPerChunk?: number },
): Promise<ContextOptimizationResult> {
  const fallback = compressContextOptimizationResult(result, options);
  const target = resolveCompressionTarget(registry);
  if (!target) return fallback;

  const compressed: OptimizedContextChunk[] = [];
  for (let index = 0; index < fallback.optimized.length; index += ABSTRACTIVE_COMPRESSION_BATCH_SIZE) {
    const batch = fallback.optimized.slice(index, index + ABSTRACTIVE_COMPRESSION_BATCH_SIZE);
    compressed.push(...await Promise.all(batch.map(async (chunk) => {
      try {
        return await summarizeChunk(chunk, target, options.query) ?? chunk;
      } catch {
        return chunk;
      }
    })));
  }

  const outputTokens = compressed.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const savedTokens = Math.max(0, result.metrics.inputTokens - outputTokens);
  const compressionSavedTokens = compressed.reduce(
    (sum, chunk) => sum + Math.max(0, (chunk.originalTokens ?? chunk.inputTokens) - chunk.outputTokens),
    0,
  );
  const preCompressionTokens = outputTokens + compressionSavedTokens;

  return {
    ...fallback,
    optimized: compressed,
    metrics: {
      ...fallback.metrics,
      outputTokens,
      savedTokens,
      reductionPct: result.metrics.inputTokens === 0
        ? 0
        : Number(((savedTokens / result.metrics.inputTokens) * 100).toFixed(2)),
      compressedChunks: compressed.filter((chunk) => chunk.compressed).length,
      compressionSavedTokens,
      compressionRatePct: preCompressionTokens === 0
        ? 0
        : Number(((compressionSavedTokens / preCompressionTokens) * 100).toFixed(2)),
    },
  };
}

export function createContextRoutes(db: Db, registry?: ProviderRegistry, routeOptions: ContextRouteOptions = {}) {
  const app = new Hono();

  app.post("/optimize", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) {
      return c.json(
        { error: { message: "Invalid JSON body", type: "validation_error" } },
        400,
      );
    }

    const parsed = validateChunks(body.chunks);
    if (!parsed.chunks) {
      return c.json(
        { error: { message: parsed.error || "invalid chunks", type: "validation_error" } },
        400,
      );
    }

    const scanRisk = validateScanRisk(body.scanRisk);
    if (scanRisk.error) {
      return c.json(
        { error: { message: scanRisk.error, type: "validation_error" } },
        400,
      );
    }

    const dedupe = validateDedupeOptions(body);
    if (!dedupe.options) {
      return c.json(
        { error: { message: dedupe.error || "invalid dedupe options", type: "validation_error" } },
        400,
      );
    }

    const deferAsyncRanking = dedupe.options.rankMode === "embedding";
    const deferCompression = dedupe.options.compressionMode !== "off" && (
      scanRisk.scanRisk ||
      deferAsyncRanking ||
      dedupe.options.compressionMode === "abstractive"
    );
    const baseOptions = deferCompression
      ? { ...dedupe.options, rankMode: deferAsyncRanking ? "none" as const : dedupe.options.rankMode, compressionMode: "off" as const }
      : deferAsyncRanking
        ? { ...dedupe.options, rankMode: "none" as const }
      : dedupe.options;
    const baseOptimization = optimizeContextChunks(parsed.chunks, baseOptions);
    const scannedOptimization = scanRisk.scanRisk
      ? await applyRiskScan(db, tenantId, baseOptimization)
      : baseOptimization;
    const rankedOptimization = await applyRequestedRanking(scannedOptimization, dedupe.options, routeOptions);
    const compressionOptions = {
      query: dedupe.options.query,
      maxSentencesPerChunk: dedupe.options.maxSentencesPerChunk,
    };
    const optimization = dedupe.options.compressionMode === "abstractive"
      ? await compressContextOptimizationResultAbstractively(rankedOptimization, registry, compressionOptions)
      : deferCompression
      ? compressContextOptimizationResult(rankedOptimization, {
        query: dedupe.options.query,
        maxSentencesPerChunk: dedupe.options.maxSentencesPerChunk,
      })
      : rankedOptimization;
    const event = await recordContextOptimizationEvent(db, tenantId, optimization, {
      riskScanned: scanRisk.scanRisk ?? false,
    });
    const retrieval = await recordContextRetrievalEvent(db, tenantId, optimization, {
      optimizationEventId: event.id,
    });

    return c.json({ optimization, event, retrieval });
  });

  app.get("/collections", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const collections = await listContextCollections(db, tenantId);
    return c.json({ collections });
  });

  app.post("/collections", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = validateCreateCollectionBody(body);
    if (!parsed.value) {
      return c.json(
        { error: { message: parsed.error || "invalid collection body", type: "validation_error" } },
        400,
      );
    }

    try {
      const collection = await createContextCollection(db, tenantId, parsed.value);
      return c.json({ collection }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create context collection";
      return c.json(
        { error: { message, type: message.includes("already exists") ? "conflict_error" : "store_error" } },
        message.includes("already exists") ? 409 : 500,
      );
    }
  });

  app.post("/collections/:id/documents", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const collectionId = c.req.param("id");
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = validateIngestDocumentBody(body);
    if (!parsed.value) {
      return c.json(
        { error: { message: parsed.error || "invalid document body", type: "validation_error" } },
        400,
      );
    }

    try {
      const result = await ingestContextDocument(db, tenantId, collectionId, parsed.value);
      return c.json({
        collection: result.collection,
        document: result.document,
        blocks: result.blocks.map((block) => ({
          id: block.id,
          tenantId: block.tenantId,
          collectionId: block.collectionId,
          documentId: block.documentId,
          ordinal: block.ordinal,
          contentHash: block.contentHash,
          tokenCount: block.tokenCount,
          source: block.source,
          metadata: block.metadata,
          createdAt: block.createdAt,
        })),
      }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to ingest context document";
      const notFound = message.includes("not found");
      return c.json(
        { error: { message, type: notFound ? "not_found" : "store_error" } },
        notFound ? 404 : 500,
      );
    }
  });

  app.post("/collections/:id/distill", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const collectionId = c.req.param("id");

    try {
      const result = await distillContextCollection(db, tenantId, collectionId);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to distill context collection";
      const notFound = message.includes("not found");
      return c.json(
        { error: { message, type: notFound ? "not_found" : "store_error" } },
        notFound ? 404 : 500,
      );
    }
  });

  app.get("/collections/:id/canonical-blocks", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const collectionId = c.req.param("id");
    const reviewStatus = c.req.query("reviewStatus");
    const parsedReviewStatus: CanonicalReviewStatus | undefined =
      reviewStatus === "draft" || reviewStatus === "approved" || reviewStatus === "rejected"
      ? reviewStatus
      : undefined;
    const options = parsedReviewStatus
      ? { reviewStatus: parsedReviewStatus }
      : {};

    try {
      const canonicalBlocks = await listContextCanonicalBlocks(db, tenantId, collectionId, options);
      return c.json({ canonicalBlocks });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list canonical blocks";
      const notFound = message.includes("not found");
      return c.json(
        { error: { message, type: notFound ? "not_found" : "store_error" } },
        notFound ? 404 : 500,
      );
    }
  });

  app.post("/canonical-blocks/:id/policy-check", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const blockId = c.req.param("id");

    try {
      const block = await getContextCanonicalBlock(db, tenantId, blockId);
      await ensureBuiltInRules(db, tenantId);
      const rules = await loadRules(db, tenantId);
      const scan = scanContent(block.content, rules, "retrieved_context");
      const canonicalBlock = await recordContextCanonicalPolicyCheck(db, tenantId, blockId, scan);
      return c.json({
        canonicalBlock,
        policy: {
          status: canonicalBlock.policyStatus,
          decision: scan.decision,
          violations: scan.violations,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to check canonical block policy";
      const notFound = message.includes("not found");
      return c.json(
        { error: { message, type: notFound ? "not_found" : "store_error" } },
        notFound ? 404 : 500,
      );
    }
  });

  app.patch("/canonical-blocks/:id/review", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const blockId = c.req.param("id");
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = validateReviewStatusBody(body);
    if (!parsed.value) {
      return c.json(
        { error: { message: parsed.error || "invalid review body", type: "validation_error" } },
        400,
      );
    }

    try {
      const canonicalBlock = await updateContextCanonicalBlockReview(db, tenantId, blockId, parsed.value.reviewStatus, {
        note: parsed.value.note,
        actorUserId: getSessionUserId(c.req.raw),
      });
      return c.json({ canonicalBlock });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update canonical block";
      const notFound = message.includes("not found");
      const policyError = message.includes("policy check");
      return c.json(
        { error: { message, type: notFound ? "not_found" : policyError ? "policy_error" : "store_error" } },
        notFound ? 404 : policyError ? 409 : 500,
      );
    }
  });

  app.get("/canonical-review-events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const collectionId = c.req.query("collectionId") || undefined;
    const events = await listContextCanonicalReviewEvents(db, tenantId, { collectionId, limit });
    return c.json({ events });
  });

  app.get("/collections/:id/export", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const collectionId = c.req.param("id");

    try {
      const blocks = await exportApprovedContextBlocks(db, tenantId, collectionId);
      return c.json({
        format: "jsonl",
        reviewStatus: "approved",
        blocks: blocks.map((block) => ({
          id: block.id,
          content: block.content,
          contentHash: block.contentHash,
          tokenCount: block.tokenCount,
          sourceBlockIds: block.sourceBlockIds,
          sourceDocumentIds: block.sourceDocumentIds,
          metadata: block.metadata,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to export canonical blocks";
      const notFound = message.includes("not found");
      return c.json(
        { error: { message, type: notFound ? "not_found" : "store_error" } },
        notFound ? 404 : 500,
      );
    }
  });

  app.get("/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    const events = await listContextOptimizationEvents(db, tenantId, { limit });

    return c.json({ events });
  });

  app.get("/summary", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const summary = await summarizeContextOptimizationEvents(db, tenantId);

    return c.json({ summary });
  });

  app.post("/evaluate", async (c) => {
    if (!registry) {
      return c.json(
        { error: { message: "Judge registry is not configured", type: "configuration_error" } },
        503,
      );
    }
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = validateQualityBody(body);
    if (!parsed.input) {
      return c.json(
        { error: { message: parsed.error || "invalid evaluation body", type: "validation_error" } },
        400,
      );
    }

    try {
      const result = await evaluateContextQuality(db, registry, tenantId, parsed.input);
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : "Context quality evaluation failed",
            type: "judge_error",
          },
        },
        502,
      );
    }
  });

  app.get("/quality/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const regressedOnly = c.req.query("regressedOnly") === "true";
    const events = await listContextQualityEvents(db, tenantId, { limit, regressedOnly });

    return c.json({ events });
  });

  app.get("/quality/summary", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const summary = await summarizeContextQualityEvents(db, tenantId);

    return c.json({ summary });
  });

  app.get("/retrieval/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const events = await listContextRetrievalEvents(db, tenantId, { limit });

    return c.json({ events });
  });

  app.get("/retrieval/summary", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const summary = await summarizeContextRetrievalEvents(db, tenantId);

    return c.json({ summary });
  });

  return app;
}
