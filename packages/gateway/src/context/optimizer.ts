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
  reason: "duplicate";
  duplicateOf: string;
  inputTokens: number;
}

export interface ContextOptimizationResult {
  optimized: OptimizedContextChunk[];
  dropped: DroppedContextChunk[];
  metrics: {
    inputChunks: number;
    outputChunks: number;
    droppedChunks: number;
    inputTokens: number;
    outputTokens: number;
    savedTokens: number;
    reductionPct: number;
  };
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

export function optimizeContextChunks(chunks: ContextChunk[]): ContextOptimizationResult {
  const seen = new Map<string, OptimizedContextChunk>();
  const optimized: OptimizedContextChunk[] = [];
  const dropped: DroppedContextChunk[] = [];
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
    optimized.push(kept);
  }

  const outputTokens = optimized.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const savedTokens = Math.max(0, inputTokens - outputTokens);
  const reductionPct = inputTokens === 0 ? 0 : Number(((savedTokens / inputTokens) * 100).toFixed(2));

  return {
    optimized,
    dropped,
    metrics: {
      inputChunks: chunks.length,
      outputChunks: optimized.length,
      droppedChunks: dropped.length,
      inputTokens,
      outputTokens,
      savedTokens,
      reductionPct,
    },
  };
}

