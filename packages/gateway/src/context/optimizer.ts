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
  };
}

export interface ContextOptimizationOptions {
  dedupeMode?: "exact" | "semantic";
  semanticThreshold?: number;
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

export function optimizeContextChunks(
  chunks: ContextChunk[],
  options: ContextOptimizationOptions = {},
): ContextOptimizationResult {
  const dedupeMode = options.dedupeMode ?? "exact";
  const semanticThreshold = Math.max(0.5, Math.min(1, options.semanticThreshold ?? 0.72));
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
  const savedTokens = Math.max(0, inputTokens - outputTokens);
  const reductionPct = inputTokens === 0 ? 0 : Number(((savedTokens / inputTokens) * 100).toFixed(2));
  const nearDuplicateChunks = dropped.filter((chunk) => chunk.reason === "near_duplicate").length;

  return {
    optimized,
    dropped,
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
    },
  };
}
