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
  };
}

export interface ContextOptimizationOptions {
  dedupeMode?: "exact" | "semantic";
  semanticThreshold?: number;
  rankMode?: "none" | "lexical";
  query?: string;
  minRelevanceScore?: number;
  freshnessMode?: "off" | "metadata";
  maxContextAgeDays?: number;
  referenceTime?: Date;
  conflictMode?: "off" | "heuristic";
}

export interface ContextConflict {
  id: string;
  kind: "status" | "numeric" | "metadata";
  chunkIds: [string, string];
  sourceIds: string[];
  topicTokens: string[];
  leftValue: string;
  rightValue: string;
}

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

function findPairConflict(
  leftChunk: OptimizedContextChunk,
  leftSignals: ConflictSignals,
  rightChunk: OptimizedContextChunk,
  rightSignals: ConflictSignals,
): Omit<ContextConflict, "id" | "chunkIds" | "sourceIds"> | null {
  const topicTokens = sharedTopicTokens(leftSignals, rightSignals);
  const sameMetadataKey = Boolean(leftSignals.metadataKey && leftSignals.metadataKey === rightSignals.metadataKey);
  if (!sameMetadataKey && topicTokens.length < 2) return null;

  if (
    sameMetadataKey &&
    leftSignals.metadataStatus &&
    rightSignals.metadataStatus &&
    leftSignals.metadataStatus !== rightSignals.metadataStatus
  ) {
    return {
      kind: "metadata",
      topicTokens,
      leftValue: `status:${leftSignals.metadataStatus}`,
      rightValue: `status:${rightSignals.metadataStatus}`,
    };
  }

  for (const [leftStatus, rightStatus] of STATUS_CONFLICTS) {
    if (leftSignals.statusTerms.has(leftStatus) && rightSignals.statusTerms.has(rightStatus)) {
      return { kind: "status", topicTokens, leftValue: leftStatus, rightValue: rightStatus };
    }
    if (leftSignals.statusTerms.has(rightStatus) && rightSignals.statusTerms.has(leftStatus)) {
      return { kind: "status", topicTokens, leftValue: rightStatus, rightValue: leftStatus };
    }
  }

  for (const leftClaim of leftSignals.numericClaims) {
    for (const rightClaim of rightSignals.numericClaims) {
      if (leftClaim.unit === rightClaim.unit && leftClaim.value !== rightClaim.value) {
        return {
          kind: "numeric",
          topicTokens,
          leftValue: leftClaim.raw,
          rightValue: rightClaim.raw,
        };
      }
    }
  }

  return null;
}

function applyConflictDetection(
  chunks: OptimizedContextChunk[],
  enabled: boolean,
): { chunks: OptimizedContextChunk[]; conflicts: ContextConflict[]; conflictChunks: number; conflictGroups: number } {
  if (!enabled || chunks.length < 2) {
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
      const conflict = findPairConflict(chunks[i], signals[i], chunks[j], signals[j]);
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
      return groupIds ? { ...chunk, conflict: true, conflictGroupIds: groupIds } : chunk;
    }),
    conflicts,
    conflictChunks: conflictedIds.size,
    conflictGroups: conflicts.length,
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

  const outputTokens = optimized.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const ranking = rankMode === "lexical"
    ? applyLexicalRanking(optimized, options.query, minRelevanceScore)
    : { chunks: optimized, avgRelevanceScore: null, lowRelevanceChunks: 0, rerankedChunks: 0 };
  const freshness = applyFreshnessScoring(ranking.chunks, {
    enabled: freshnessMode === "metadata",
    maxAgeDays: maxContextAgeDays,
    referenceTime: options.referenceTime,
  });
  const conflict = applyConflictDetection(freshness.chunks, conflictMode === "heuristic");
  const savedTokens = Math.max(0, inputTokens - outputTokens);
  const reductionPct = inputTokens === 0 ? 0 : Number(((savedTokens / inputTokens) * 100).toFixed(2));
  const nearDuplicateChunks = dropped.filter((chunk) => chunk.reason === "near_duplicate").length;

  return {
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
    },
  };
}
