import type { EmbeddingProvider } from "../embeddings/index.js";
import { cosineSimilarity } from "../embeddings/index.js";

export interface ContextChunk {
  id: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface OptimizedContextChunk {
  id: string;
  sourceIds: string[];
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  relevanceScore?: number;
  freshnessScore?: number;
  stale?: boolean;
  conflict?: boolean;
  conflictGroupIds?: string[];
  conflictSeverity?: ConflictSeverity;
  compressed?: boolean;
  originalTokens?: number;
  compressedTokens?: number;
}

export interface DroppedContextChunk {
  id: string;
  reason: "duplicate" | "near_duplicate";
  duplicateOf: string;
  similarity?: number;
  inputTokens: number;
}

export interface RiskyContextChunk {
  id: string;
  sourceIds: string[];
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  decision: "flag" | "quarantine" | "redact" | "block";
  ruleName: string | null;
  matchedContent: string | null;
}

export interface ContextOptimizationResult {
  optimized: OptimizedContextChunk[];
  dropped: DroppedContextChunk[];
  conflicts: ContextConflict[];
  flagged: RiskyContextChunk[];
  quarantined: RiskyContextChunk[];
  metrics: {
    inputChunks: number;
    outputChunks: number;
    droppedChunks: number;
    nearDuplicateChunks: number;
    flaggedChunks: number;
    quarantinedChunks: number;
    inputTokens: number;
    outputTokens: number;
    savedTokens: number;
    reductionPct: number;
    avgRelevanceScore: number | null;
    lowRelevanceChunks: number;
    rerankedChunks: number;
    avgFreshnessScore: number | null;
    staleChunks: number;
    conflictChunks: number;
    conflictGroups: number;
    compressedChunks: number;
    compressionSavedTokens: number;
    compressionRatePct: number;
  };
}

export interface ContextOptimizationOptions {
  dedupeMode?: "exact" | "semantic";
  semanticThreshold?: number;
  rankMode?: "none" | "lexical" | "embedding";
  query?: string;
  minRelevanceScore?: number;
  freshnessMode?: "off" | "metadata";
  maxContextAgeDays?: number;
  referenceTime?: Date;
  conflictMode?: "off" | "heuristic" | "scored";
  compressionMode?: "off" | "extractive";
  maxSentencesPerChunk?: number;
}

export interface ContextConflict {
  id: string;
  kind: "status" | "numeric" | "metadata";
  chunkIds: [string, string];
  sourceIds: string[];
  topicTokens: string[];
  leftValue: string;
  rightValue: string;
  score?: number;
  severity?: ConflictSeverity;
}

export type ConflictSeverity = "low" | "medium" | "high";

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeForExactDedupe(content: string): string {
  return content
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "with", "within", "you", "your",
]);

function normalizeToken(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokenizeForSimilarity(content: string): string[] {
  return content
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(normalizeToken)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token)) ?? [];
}

function tokenSet(content: string): Set<string> {
  return new Set(tokenizeForSimilarity(content));
}

function boundedTokenSet(content: string, maxTokens: number): Set<string> {
  const tokens = tokenizeForSimilarity(content);
  const set = new Set<string>();
  for (let i = 0; i < tokens.length && set.size < maxTokens; i += 1) {
    set.add(tokens[i]);
  }
  return set;
}

function semanticSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  if (intersection < 3) return 0;
  const union = left.size + right.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const overlap = intersection / Math.min(left.size, right.size);
  return Number(Math.max(jaccard, overlap).toFixed(4));
}

function lexicalRelevanceScore(queryTokens: Set<string>, content: string): number {
  if (queryTokens.size === 0) return 0;
  const chunkTokens = tokenSet(content);
  if (chunkTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) matches += 1;
  }
  const coverage = matches / queryTokens.size;
  const density = matches / Math.min(chunkTokens.size, queryTokens.size * 4);
  return Number(((coverage * 0.75) + (density * 0.25)).toFixed(4));
}

function applyLexicalRanking(
  chunks: OptimizedContextChunk[],
  query: string | undefined,
  minRelevanceScore: number,
): { chunks: OptimizedContextChunk[]; avgRelevanceScore: number | null; lowRelevanceChunks: number; rerankedChunks: number } {
  const queryTokens = query ? boundedTokenSet(query, 32) : new Set<string>();
  if (queryTokens.size === 0 || chunks.length === 0) {
    return { chunks, avgRelevanceScore: null, lowRelevanceChunks: 0, rerankedChunks: 0 };
  }

  let total = 0;
  let lowRelevanceChunks = 0;
  const scored = chunks.map((chunk, index) => {
    const relevanceScore = lexicalRelevanceScore(queryTokens, chunk.content);
    total += relevanceScore;
    if (relevanceScore < minRelevanceScore) lowRelevanceChunks += 1;
    return { chunk: { ...chunk, relevanceScore }, index };
  });

  scored.sort((left, right) => {
    if (right.chunk.relevanceScore !== left.chunk.relevanceScore) {
      return (right.chunk.relevanceScore ?? 0) - (left.chunk.relevanceScore ?? 0);
    }
    return left.index - right.index;
  });

  let rerankedChunks = 0;
  const ranked = scored.map((item, newIndex) => {
    if (item.index !== newIndex) rerankedChunks += 1;
    return item.chunk;
  });

  return {
    chunks: ranked,
    avgRelevanceScore: Number((total / chunks.length).toFixed(4)),
    lowRelevanceChunks,
    rerankedChunks,
  };
}

function applyScoredRanking(
  chunks: OptimizedContextChunk[],
  scores: number[],
  minRelevanceScore: number,
): { chunks: OptimizedContextChunk[]; avgRelevanceScore: number | null; lowRelevanceChunks: number; rerankedChunks: number } {
  if (chunks.length === 0 || scores.length !== chunks.length) {
    return { chunks, avgRelevanceScore: null, lowRelevanceChunks: 0, rerankedChunks: 0 };
  }

  let total = 0;
  let lowRelevanceChunks = 0;
  const scored = chunks.map((chunk, index) => {
    const relevanceScore = Number(Math.max(0, Math.min(1, scores[index] ?? 0)).toFixed(4));
    total += relevanceScore;
    if (relevanceScore < minRelevanceScore) lowRelevanceChunks += 1;
    return { chunk: { ...chunk, relevanceScore }, index };
  });

  scored.sort((left, right) => {
    if (right.chunk.relevanceScore !== left.chunk.relevanceScore) {
      return (right.chunk.relevanceScore ?? 0) - (left.chunk.relevanceScore ?? 0);
    }
    return left.index - right.index;
  });

  let rerankedChunks = 0;
  const ranked = scored.map((item, newIndex) => {
    if (item.index !== newIndex) rerankedChunks += 1;
    return item.chunk;
  });

  return {
    chunks: ranked,
    avgRelevanceScore: Number((total / chunks.length).toFixed(4)),
    lowRelevanceChunks,
    rerankedChunks,
  };
}

function withRanking(
  result: ContextOptimizationResult,
  ranking: { chunks: OptimizedContextChunk[]; avgRelevanceScore: number | null; lowRelevanceChunks: number; rerankedChunks: number },
): ContextOptimizationResult {
  return {
    ...result,
    optimized: ranking.chunks,
    metrics: {
      ...result.metrics,
      avgRelevanceScore: ranking.avgRelevanceScore,
      lowRelevanceChunks: ranking.lowRelevanceChunks,
      rerankedChunks: ranking.rerankedChunks,
    },
  };
}

export function rankContextOptimizationResultLexically(
  result: ContextOptimizationResult,
  options: { query?: string; minRelevanceScore?: number },
): ContextOptimizationResult {
  const minRelevanceScore = Math.max(0, Math.min(1, options.minRelevanceScore ?? 0.2));
  return withRanking(result, applyLexicalRanking(result.optimized, options.query, minRelevanceScore));
}

const MAX_EMBEDDING_INPUT_CHARS = 6_000;
const EMBEDDING_BATCH_SIZE = 8;

function boundedEmbeddingInput(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

export async function rankContextOptimizationResultWithEmbeddings(
  result: ContextOptimizationResult,
  embeddings: EmbeddingProvider,
  options: { query?: string; minRelevanceScore?: number },
): Promise<ContextOptimizationResult> {
  const query = boundedEmbeddingInput(options.query ?? "");
  if (!query || result.optimized.length === 0) {
    return withRanking(result, {
      chunks: result.optimized,
      avgRelevanceScore: null,
      lowRelevanceChunks: 0,
      rerankedChunks: 0,
    });
  }

  const queryVector = await embeddings.embed(query);
  const scores: number[] = [];
  for (let index = 0; index < result.optimized.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = result.optimized.slice(index, index + EMBEDDING_BATCH_SIZE);
    const vectors = await Promise.all(
      batch.map((chunk) => embeddings.embed(boundedEmbeddingInput(chunk.content))),
    );
    for (const vector of vectors) {
      scores.push(cosineSimilarity(queryVector, vector));
    }
  }

  const minRelevanceScore = Math.max(0, Math.min(1, options.minRelevanceScore ?? 0.2));
  return withRanking(result, applyScoredRanking(result.optimized, scores, minRelevanceScore));
}

const DAY_MS = 86_400_000;

function readMetadataDate(metadata: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const millis = value > 10_000_000_000 ? value : value * 1000;
      if (millis > 0) return millis;
    }
    if (typeof value === "string" && value.length > 0 && value.length <= 64) {
      const millis = Date.parse(value);
      if (Number.isFinite(millis)) return millis;
    }
  }
  return null;
}

function scoreFreshness(
  chunk: OptimizedContextChunk,
  referenceMs: number,
  maxAgeDays: number,
): { freshnessScore: number; stale: boolean } | null {
  const expiresAt = readMetadataDate(chunk.metadata, ["expiresAt", "expires_at", "validUntil", "valid_until"]);
  if (expiresAt !== null && expiresAt < referenceMs) {
    return { freshnessScore: 0, stale: true };
  }

  const updatedAt = readMetadataDate(chunk.metadata, [
    "updatedAt",
    "updated_at",
    "lastModified",
    "last_modified",
    "publishedAt",
    "published_at",
    "createdAt",
    "created_at",
  ]);
  if (updatedAt === null) return null;

  const ageDays = Math.max(0, (referenceMs - updatedAt) / DAY_MS);
  const freshnessScore = Number(Math.max(0, 1 - (ageDays / maxAgeDays)).toFixed(4));
  return { freshnessScore, stale: ageDays > maxAgeDays };
}

function applyFreshnessScoring(
  chunks: OptimizedContextChunk[],
  options: { enabled: boolean; maxAgeDays: number; referenceTime?: Date },
): { chunks: OptimizedContextChunk[]; avgFreshnessScore: number | null; staleChunks: number } {
  if (!options.enabled || chunks.length === 0) {
    return { chunks, avgFreshnessScore: null, staleChunks: 0 };
  }

  const referenceMs = options.referenceTime?.getTime() ?? Date.now();
  let scoredCount = 0;
  let total = 0;
  let staleChunks = 0;
  const scoredChunks = chunks.map((chunk) => {
    const freshness = scoreFreshness(chunk, referenceMs, options.maxAgeDays);
    if (!freshness) return chunk;
    scoredCount += 1;
    total += freshness.freshnessScore;
    if (freshness.stale) staleChunks += 1;
    return { ...chunk, freshnessScore: freshness.freshnessScore, stale: freshness.stale };
  });

  return {
    chunks: scoredChunks,
    avgFreshnessScore: scoredCount === 0 ? null : Number((total / scoredCount).toFixed(4)),
    staleChunks,
  };
}

const STATUS_CONFLICTS: Array<[string, string]> = [
  ["active", "inactive"],
  ["enabled", "disabled"],
  ["available", "unavailable"],
  ["current", "deprecated"],
  ["current", "legacy"],
  ["supported", "unsupported"],
  ["allowed", "blocked"],
  ["public", "private"],
];

const CLAIM_STOPWORDS = new Set([
  ...STOPWORDS,
  "account", "accounts", "customer", "customers", "doc", "docs", "document", "policy", "policies",
  "support", "user", "users",
]);

interface NumericClaim {
  value: number;
  unit: string;
  raw: string;
}

interface ConflictSignals {
  topicTokens: Set<string>;
  metadataKey: string | null;
  metadataStatus: string | null;
  statusTerms: Set<string>;
  numericClaims: NumericClaim[];
}

function readMetadataString(metadata: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 128) return value.toLowerCase();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  return null;
}

function normalizeUnit(unit: string): string {
  const normalized = unit.toLowerCase();
  if (normalized === "day" || normalized === "days") return "days";
  if (normalized === "hour" || normalized === "hours") return "hours";
  if (normalized === "%" || normalized === "percent") return "percent";
  if (normalized === "dollar" || normalized === "dollars" || normalized === "usd" || normalized === "$") return "usd";
  return normalized;
}

function extractNumericClaims(content: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  const pattern = /(\$?\d+(?:\.\d+)?)\s*(days?|hours?|%|percent|usd|dollars?)/gi;
  for (const match of content.matchAll(pattern)) {
    if (claims.length >= 8) break;
    const rawValue = match[1] ?? "";
    const value = Number(rawValue.replace("$", ""));
    if (!Number.isFinite(value)) continue;
    claims.push({
      value,
      unit: normalizeUnit(match[2] ?? ""),
      raw: `${rawValue}${match[2] ? ` ${match[2]}` : ""}`,
    });
  }
  return claims;
}

function extractConflictSignals(chunk: OptimizedContextChunk): ConflictSignals {
  const topicTokens = new Set<string>();
  for (const token of tokenizeForSimilarity(chunk.content)) {
    if (topicTokens.size >= 24) break;
    if (!CLAIM_STOPWORDS.has(token)) topicTokens.add(token);
  }

  const metadataKey = readMetadataString(chunk.metadata, [
    "conflictKey",
    "conflict_key",
    "entity",
    "topic",
    "policyId",
    "policy_id",
    "canonicalId",
    "canonical_id",
  ]);
  if (metadataKey) {
    for (const token of tokenizeForSimilarity(metadataKey)) {
      if (topicTokens.size >= 24) break;
      topicTokens.add(token);
    }
  }

  const contentTokens = tokenSet(chunk.content);
  const statusTerms = new Set<string>();
  for (const [left, right] of STATUS_CONFLICTS) {
    if (contentTokens.has(left)) statusTerms.add(left);
    if (contentTokens.has(right)) statusTerms.add(right);
  }

  return {
    topicTokens,
    metadataKey,
    metadataStatus: readMetadataString(chunk.metadata, ["status", "state", "availability"]),
    statusTerms,
    numericClaims: extractNumericClaims(chunk.content),
  };
}

function sharedTopicTokens(left: ConflictSignals, right: ConflictSignals): string[] {
  if (left.metadataKey && right.metadataKey && left.metadataKey === right.metadataKey) {
    return [...left.topicTokens].slice(0, 5);
  }
  const shared: string[] = [];
  for (const token of left.topicTokens) {
    if (right.topicTokens.has(token)) {
      shared.push(token);
      if (shared.length >= 5) break;
    }
  }
  return shared;
}

function conflictSeverity(score: number): ConflictSeverity {
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium";
  return "low";
}

function boundedConflictScore(score: number): number {
  return Number(Math.max(0, Math.min(1, score)).toFixed(4));
}

function scoredConflict(
  conflict: Omit<ContextConflict, "id" | "chunkIds" | "sourceIds" | "score" | "severity">,
  score: number,
): Omit<ContextConflict, "id" | "chunkIds" | "sourceIds"> {
  const normalized = boundedConflictScore(score);
  return {
    ...conflict,
    score: normalized,
    severity: conflictSeverity(normalized),
  };
}

function findPairConflict(
  leftChunk: OptimizedContextChunk,
  leftSignals: ConflictSignals,
  rightChunk: OptimizedContextChunk,
  rightSignals: ConflictSignals,
  mode: "heuristic" | "scored",
): Omit<ContextConflict, "id" | "chunkIds" | "sourceIds"> | null {
  const topicTokens = sharedTopicTokens(leftSignals, rightSignals);
  const sameMetadataKey = Boolean(leftSignals.metadataKey && leftSignals.metadataKey === rightSignals.metadataKey);
  const minSharedTopics = mode === "scored" ? 1 : 2;
  if (!sameMetadataKey && topicTokens.length < minSharedTopics) return null;

  if (
    sameMetadataKey &&
    leftSignals.metadataStatus &&
    rightSignals.metadataStatus &&
    leftSignals.metadataStatus !== rightSignals.metadataStatus
  ) {
    return scoredConflict({
      kind: "metadata",
      topicTokens,
      leftValue: `status:${leftSignals.metadataStatus}`,
      rightValue: `status:${rightSignals.metadataStatus}`,
    }, 0.94);
  }

  for (const [leftStatus, rightStatus] of STATUS_CONFLICTS) {
    if (leftSignals.statusTerms.has(leftStatus) && rightSignals.statusTerms.has(rightStatus)) {
      return scoredConflict({
        kind: "status",
        topicTokens,
        leftValue: leftStatus,
        rightValue: rightStatus,
      }, sameMetadataKey ? 0.88 : 0.72 + Math.min(0.12, topicTokens.length * 0.03));
    }
    if (leftSignals.statusTerms.has(rightStatus) && rightSignals.statusTerms.has(leftStatus)) {
      return scoredConflict({
        kind: "status",
        topicTokens,
        leftValue: rightStatus,
        rightValue: leftStatus,
      }, sameMetadataKey ? 0.88 : 0.72 + Math.min(0.12, topicTokens.length * 0.03));
    }
  }

  for (const leftClaim of leftSignals.numericClaims) {
    for (const rightClaim of rightSignals.numericClaims) {
      if (leftClaim.unit === rightClaim.unit && leftClaim.value !== rightClaim.value) {
        const maxValue = Math.max(Math.abs(leftClaim.value), Math.abs(rightClaim.value), 1);
        const relativeDelta = Math.abs(leftClaim.value - rightClaim.value) / maxValue;
        const score = 0.55 +
          Math.min(0.25, relativeDelta * 0.35) +
          (sameMetadataKey ? 0.12 : 0) +
          Math.min(0.08, topicTokens.length * 0.02);
        return scoredConflict({
          kind: "numeric",
          topicTokens,
          leftValue: leftClaim.raw,
          rightValue: rightClaim.raw,
        }, score);
      }
    }
  }

  return null;
}

function applyConflictDetection(
  chunks: OptimizedContextChunk[],
  mode: "off" | "heuristic" | "scored",
): { chunks: OptimizedContextChunk[]; conflicts: ContextConflict[]; conflictChunks: number; conflictGroups: number } {
  if (mode === "off" || chunks.length < 2) {
    return { chunks, conflicts: [], conflictChunks: 0, conflictGroups: 0 };
  }

  const signals = chunks.map(extractConflictSignals);
  const conflicts: ContextConflict[] = [];
  const conflictedIds = new Set<string>();
  const conflictGroupIds = new Map<string, string[]>();
  const maxPairs = Math.min(20_000, (chunks.length * (chunks.length - 1)) / 2);
  let checkedPairs = 0;

  for (let i = 0; i < chunks.length - 1 && checkedPairs < maxPairs; i += 1) {
    for (let j = i + 1; j < chunks.length && checkedPairs < maxPairs; j += 1) {
      checkedPairs += 1;
      const conflict = findPairConflict(chunks[i], signals[i], chunks[j], signals[j], mode);
      if (!conflict) continue;
      const id = `conflict-${conflicts.length + 1}`;
      conflicts.push({
        id,
        kind: conflict.kind,
        chunkIds: [chunks[i].id, chunks[j].id],
        sourceIds: [...new Set([...chunks[i].sourceIds, ...chunks[j].sourceIds])],
        topicTokens: conflict.topicTokens,
        leftValue: conflict.leftValue,
        rightValue: conflict.rightValue,
        score: conflict.score,
        severity: conflict.severity,
      });
      conflictedIds.add(chunks[i].id);
      conflictedIds.add(chunks[j].id);
      conflictGroupIds.set(chunks[i].id, [...(conflictGroupIds.get(chunks[i].id) ?? []), id]);
      conflictGroupIds.set(chunks[j].id, [...(conflictGroupIds.get(chunks[j].id) ?? []), id]);
    }
  }

  if (conflicts.length === 0) {
    return { chunks, conflicts, conflictChunks: 0, conflictGroups: 0 };
  }

  return {
    chunks: chunks.map((chunk) => {
      const groupIds = conflictGroupIds.get(chunk.id);
      if (!groupIds) return chunk;
      const maxScore = conflicts
        .filter((conflict) => conflict.chunkIds.includes(chunk.id))
        .reduce((max, conflict) => Math.max(max, conflict.score ?? 0), 0);
      return {
        ...chunk,
        conflict: true,
        conflictGroupIds: groupIds,
        conflictSeverity: conflictSeverity(maxScore),
      };
    }),
    conflicts,
    conflictChunks: conflictedIds.size,
    conflictGroups: conflicts.length,
  };
}

interface SentenceCandidate {
  text: string;
  index: number;
  tokens: Set<string>;
}

function splitSentences(content: string): SentenceCandidate[] {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const raw = normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized];
  const sentences: SentenceCandidate[] = [];
  for (const sentence of raw) {
    const text = sentence.trim();
    if (text.length < 12) continue;
    sentences.push({
      text,
      index: sentences.length,
      tokens: tokenSet(text),
    });
    if (sentences.length >= 64) break;
  }
  return sentences;
}

function sentenceScore(
  sentence: SentenceCandidate,
  queryTokens: Set<string>,
  chunk: OptimizedContextChunk,
): number {
  let matches = 0;
  for (const token of queryTokens) {
    if (sentence.tokens.has(token)) matches += 1;
  }
  const queryScore = queryTokens.size === 0 ? 0 : matches / queryTokens.size;
  const density = sentence.tokens.size === 0 ? 0 : matches / sentence.tokens.size;
  const relevanceBonus = chunk.relevanceScore ? chunk.relevanceScore * 0.08 : 0;
  const freshnessPenalty = chunk.stale ? 0.08 : 0;
  const conflictPenalty = chunk.conflict ? 0.04 : 0;
  const leadBonus = sentence.index === 0 ? 0.03 : 0;
  return queryTokens.size === 0
    ? leadBonus - freshnessPenalty - conflictPenalty
    : queryScore * 0.8 + density * 0.2 + relevanceBonus + leadBonus - freshnessPenalty - conflictPenalty;
}

function compressChunkExtractively(
  chunk: OptimizedContextChunk,
  queryTokens: Set<string>,
  maxSentences: number,
): OptimizedContextChunk {
  const sentences = splitSentences(chunk.content);
  if (sentences.length <= maxSentences) return chunk;

  const ranked = sentences
    .map((sentence) => ({ sentence, score: sentenceScore(sentence, queryTokens, chunk) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.sentence.index - right.sentence.index;
    })
    .slice(0, maxSentences)
    .sort((left, right) => left.sentence.index - right.sentence.index);

  const compressedContent = ranked.map((item) => item.sentence.text).join(" ");
  const compressedTokens = estimateContextTokens(compressedContent);
  if (compressedTokens >= chunk.outputTokens) return chunk;

  return {
    ...chunk,
    content: compressedContent,
    outputTokens: compressedTokens,
    compressed: true,
    originalTokens: chunk.outputTokens,
    compressedTokens,
  };
}

function applyExtractiveCompression(
  chunks: OptimizedContextChunk[],
  options: { enabled: boolean; query?: string; maxSentences: number },
): {
  chunks: OptimizedContextChunk[];
  compressedChunks: number;
  compressionSavedTokens: number;
  compressionRatePct: number;
} {
  if (!options.enabled || chunks.length === 0) {
    return { chunks, compressedChunks: 0, compressionSavedTokens: 0, compressionRatePct: 0 };
  }

  const queryTokens = options.query ? boundedTokenSet(options.query, 32) : new Set<string>();
  const preCompressionTokens = chunks.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  let compressedChunks = 0;
  let outputTokens = 0;
  const compressed = chunks.map((chunk) => {
    const next = compressChunkExtractively(chunk, queryTokens, options.maxSentences);
    if (next.compressed) compressedChunks += 1;
    outputTokens += next.outputTokens;
    return next;
  });
  const compressionSavedTokens = Math.max(0, preCompressionTokens - outputTokens);
  return {
    chunks: compressed,
    compressedChunks,
    compressionSavedTokens,
    compressionRatePct: preCompressionTokens === 0
      ? 0
      : Number(((compressionSavedTokens / preCompressionTokens) * 100).toFixed(2)),
  };
}

export function optimizeContextChunks(
  chunks: ContextChunk[],
  options: ContextOptimizationOptions = {},
): ContextOptimizationResult {
  const dedupeMode = options.dedupeMode ?? "exact";
  const semanticThreshold = Math.max(0.5, Math.min(1, options.semanticThreshold ?? 0.72));
  const rankMode = options.rankMode ?? "none";
  const minRelevanceScore = Math.max(0, Math.min(1, options.minRelevanceScore ?? 0.2));
  const freshnessMode = options.freshnessMode ?? "off";
  const maxContextAgeDays = Math.max(1, Math.min(3650, options.maxContextAgeDays ?? 180));
  const conflictMode = options.conflictMode ?? "off";
  const compressionMode = options.compressionMode ?? "off";
  const maxSentencesPerChunk = Math.max(1, Math.min(8, Math.floor(options.maxSentencesPerChunk ?? 3)));
  const seen = new Map<string, OptimizedContextChunk>();
  const optimized: OptimizedContextChunk[] = [];
  const dropped: DroppedContextChunk[] = [];
  const semanticFingerprints = new Map<string, Set<string>>();
  let inputTokens = 0;

  for (const chunk of chunks) {
    const tokenEstimate = estimateContextTokens(chunk.content);
    inputTokens += tokenEstimate;

    const key = normalizeForExactDedupe(chunk.content);
    const existing = seen.get(key);
    if (existing) {
      existing.sourceIds.push(chunk.id);
      dropped.push({
        id: chunk.id,
        reason: "duplicate",
        duplicateOf: existing.id,
        inputTokens: tokenEstimate,
      });
      continue;
    }

    if (dedupeMode === "semantic") {
      const candidateTokens = tokenSet(chunk.content);
      let bestMatch: { chunk: OptimizedContextChunk; similarity: number } | null = null;
      for (const kept of optimized) {
        const keptTokens = semanticFingerprints.get(kept.id);
        if (!keptTokens) continue;
        const similarity = semanticSimilarity(candidateTokens, keptTokens);
        if (similarity >= semanticThreshold && (!bestMatch || similarity > bestMatch.similarity)) {
          bestMatch = { chunk: kept, similarity };
        }
      }
      if (bestMatch) {
        bestMatch.chunk.sourceIds.push(chunk.id);
        dropped.push({
          id: chunk.id,
          reason: "near_duplicate",
          duplicateOf: bestMatch.chunk.id,
          similarity: bestMatch.similarity,
          inputTokens: tokenEstimate,
        });
        continue;
      }
      semanticFingerprints.set(chunk.id, candidateTokens);
    }

    const kept: OptimizedContextChunk = {
      id: chunk.id,
      sourceIds: [chunk.id],
      content: chunk.content,
      source: chunk.source,
      metadata: chunk.metadata,
      inputTokens: tokenEstimate,
      outputTokens: tokenEstimate,
    };
    seen.set(key, kept);
    if (dedupeMode === "semantic") {
      semanticFingerprints.set(kept.id, tokenSet(chunk.content));
    }
    optimized.push(kept);
  }

  const ranking = rankMode === "lexical"
    ? applyLexicalRanking(optimized, options.query, minRelevanceScore)
    : { chunks: optimized, avgRelevanceScore: null, lowRelevanceChunks: 0, rerankedChunks: 0 };
  const freshness = applyFreshnessScoring(ranking.chunks, {
    enabled: freshnessMode === "metadata",
    maxAgeDays: maxContextAgeDays,
    referenceTime: options.referenceTime,
  });
  const conflict = applyConflictDetection(freshness.chunks, conflictMode);
  const outputTokens = conflict.chunks.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const savedTokens = Math.max(0, inputTokens - outputTokens);
  const reductionPct = inputTokens === 0 ? 0 : Number(((savedTokens / inputTokens) * 100).toFixed(2));
  const nearDuplicateChunks = dropped.filter((chunk) => chunk.reason === "near_duplicate").length;

  const result: ContextOptimizationResult = {
    optimized: conflict.chunks,
    dropped,
    conflicts: conflict.conflicts,
    flagged: [],
    quarantined: [],
    metrics: {
      inputChunks: chunks.length,
      outputChunks: optimized.length,
      droppedChunks: dropped.length,
      nearDuplicateChunks,
      flaggedChunks: 0,
      quarantinedChunks: 0,
      inputTokens,
      outputTokens,
      savedTokens,
      reductionPct,
      avgRelevanceScore: ranking.avgRelevanceScore,
      lowRelevanceChunks: ranking.lowRelevanceChunks,
      rerankedChunks: ranking.rerankedChunks,
      avgFreshnessScore: freshness.avgFreshnessScore,
      staleChunks: freshness.staleChunks,
      conflictChunks: conflict.conflictChunks,
      conflictGroups: conflict.conflictGroups,
      compressedChunks: 0,
      compressionSavedTokens: 0,
      compressionRatePct: 0,
    },
  };

  return compressionMode === "extractive"
    ? compressContextOptimizationResult(result, {
      query: options.query,
      maxSentencesPerChunk,
    })
    : result;
}

export function compressContextOptimizationResult(
  result: ContextOptimizationResult,
  options: { query?: string; maxSentencesPerChunk?: number } = {},
): ContextOptimizationResult {
  const maxSentences = Math.max(1, Math.min(8, Math.floor(options.maxSentencesPerChunk ?? 3)));
  const compression = applyExtractiveCompression(result.optimized, {
    enabled: true,
    query: options.query,
    maxSentences,
  });
  const outputTokens = compression.chunks.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const savedTokens = Math.max(0, result.metrics.inputTokens - outputTokens);

  return {
    ...result,
    optimized: compression.chunks,
    metrics: {
      ...result.metrics,
      outputTokens,
      savedTokens,
      reductionPct: result.metrics.inputTokens === 0
        ? 0
        : Number(((savedTokens / result.metrics.inputTokens) * 100).toFixed(2)),
      compressedChunks: compression.compressedChunks,
      compressionSavedTokens: compression.compressionSavedTokens,
      compressionRatePct: compression.compressionRatePct,
    },
  };
}
