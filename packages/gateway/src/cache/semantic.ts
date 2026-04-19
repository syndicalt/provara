import { nanoid } from "nanoid";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@provara/db";
import { semanticCache } from "@provara/db";
import type { ChatMessage, CompletionResponse } from "../providers/types.js";
import { messageText } from "../providers/types.js";
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  type EmbeddingProvider,
} from "../embeddings/index.js";

/**
 * Default similarity threshold. Errs toward false negatives — a miss means
 * we call the LLM (correctness preserved); a false positive returns a
 * similar-but-wrong answer. Tune via PROVARA_SEMANTIC_CACHE_THRESHOLD.
 */
const DEFAULT_THRESHOLD = 0.97;

const MAX_ENTRIES_PER_TENANT = 10_000;

/**
 * Single cache row held in memory for fast cosine scan. DB is source of
 * truth; memory is rehydrated on boot and updated on every write.
 */
interface CacheRow {
  id: string;
  tenantKey: string;
  provider: string;
  model: string;
  systemPromptHash: string | null;
  embedding: number[];
  embeddingDim: number;
  embeddingModel: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
}

/** Key groups cache entries that can possibly match each other. */
function tenantKey(tenantId: string | null, provider: string, model: string): string {
  return `${tenantId ?? "anon"}::${provider}::${model}`;
}

/** Deterministic hash of a system prompt (or empty string if none). */
export function hashSystemPrompt(messages: ChatMessage[]): string {
  const sys = messages
    .filter((m) => m.role === "system")
    .map(messageText)
    .join("\n");
  let hash = 0;
  for (let i = 0; i < sys.length; i++) {
    hash = ((hash << 5) - hash + sys.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * The cache is eligible only for single-turn user requests. Multi-turn
 * semantics (does the whole history have to match? what about summarization
 * drift?) are out of scope for the MVP — we miss cleanly rather than guess.
 */
export function isCacheEligible(messages: ChatMessage[]): boolean {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length !== 1) return false;
  // System messages are allowed; assistant turns are not (means history).
  const hasAssistant = messages.some((m) => m.role === "assistant");
  return !hasAssistant;
}

/**
 * Soft heuristic: skip semantic matching when the prompt looks personalized
 * ("my …", "our …", emails, phone numbers). We still write to cache (the
 * exact-match path handles replays), but we don't risk cross-user
 * semantic collision. This is a safety net, not a security boundary —
 * documented accordingly in the README.
 */
const PERSONAL_SIGNALS = [
  /\bmy\s/i,
  /\bour\s/i,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
];
export function looksPersonalized(text: string): boolean {
  return PERSONAL_SIGNALS.some((r) => r.test(text));
}

export type SemanticCache = Awaited<ReturnType<typeof createSemanticCache>>;

export async function createSemanticCache(db: Db, embeddings: EmbeddingProvider) {
  const threshold = parseFloat(
    process.env.PROVARA_SEMANTIC_CACHE_THRESHOLD || String(DEFAULT_THRESHOLD),
  );

  /** In-memory mirror, grouped by tenantKey for fast per-cell scan. */
  const memory = new Map<string, CacheRow[]>();

  async function hydrate(): Promise<void> {
    const rows = await db.select().from(semanticCache).all();
    for (const row of rows) {
      const key = tenantKey(row.tenantId, row.provider, row.model);
      const embedding = decodeEmbedding(row.embedding as Buffer);
      const existing = memory.get(key) ?? [];
      existing.push({
        id: row.id,
        tenantKey: key,
        provider: row.provider,
        model: row.model,
        systemPromptHash: row.systemPromptHash,
        embedding,
        embeddingDim: row.embeddingDim,
        embeddingModel: row.embeddingModel,
        response: row.response,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      });
      memory.set(key, existing);
    }
  }

  await hydrate();

  /**
   * Returns the best semantic match at or above threshold, or null. Rejects
   * vectors whose embedding_model differs from the caller's — a model change
   * produces embeddings in a different space and comparing across them is
   * nonsense.
   */
  async function get(
    messages: ChatMessage[],
    tenantId: string | null,
    provider: string,
    model: string,
  ): Promise<{ row: CacheRow; similarity: number } | null> {
    if (!isCacheEligible(messages)) return null;
    const userMessage = messages.find((m) => m.role === "user");
    const userMsg = userMessage ? messageText(userMessage) : "";
    if (looksPersonalized(userMsg)) return null;

    const key = tenantKey(tenantId, provider, model);
    const bucket = memory.get(key);
    if (!bucket || bucket.length === 0) return null;

    const systemHash = hashSystemPrompt(messages);
    const queryVec = await embeddings.embed(userMsg);

    let best: { row: CacheRow; similarity: number } | null = null;
    for (const row of bucket) {
      if (row.embeddingModel !== embeddings.model) continue;
      if (row.systemPromptHash !== systemHash) continue;
      if (row.embeddingDim !== queryVec.length) continue;
      const sim = cosineSimilarity(queryVec, row.embedding);
      if (sim >= threshold && (!best || sim > best.similarity)) {
        best = { row, similarity: sim };
      }
    }

    if (best) {
      // Fire-and-forget hit tracking; don't block the response.
      const hitId = best.row.id;
      void db
        .update(semanticCache)
        .set({ hitCount: sql`${semanticCache.hitCount} + 1`, lastHitAt: new Date() })
        .where(eq(semanticCache.id, hitId))
        .run()
        .catch(() => {});
    }
    return best;
  }

  /**
   * Write a completed LLM response into the cache. Called after a successful
   * non-cache path. Non-blocking from the caller's perspective — embedding
   * happens here, so callers should `void` the promise.
   */
  async function put(
    messages: ChatMessage[],
    tenantId: string | null,
    provider: string,
    model: string,
    response: CompletionResponse,
  ): Promise<void> {
    if (!isCacheEligible(messages)) return;
    const userMessage = messages.find((m) => m.role === "user");
    const userMsg = userMessage ? messageText(userMessage) : "";
    if (!userMsg) return;

    const vec = await embeddings.embed(userMsg);
    const systemHash = hashSystemPrompt(messages);
    const id = nanoid();

    const row: CacheRow = {
      id,
      tenantKey: tenantKey(tenantId, provider, model),
      provider,
      model,
      systemPromptHash: systemHash,
      embedding: vec,
      embeddingDim: vec.length,
      embeddingModel: embeddings.model,
      response: response.content,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };

    const key = row.tenantKey;
    const bucket = memory.get(key) ?? [];
    bucket.push(row);
    // LRU-ish: oldest first out when bucket gets big.
    if (bucket.length > MAX_ENTRIES_PER_TENANT) {
      const evicted = bucket.shift();
      if (evicted) {
        void db.delete(semanticCache).where(eq(semanticCache.id, evicted.id)).run().catch(() => {});
      }
    }
    memory.set(key, bucket);

    await db
      .insert(semanticCache)
      .values({
        id,
        tenantId,
        provider,
        model,
        systemPromptHash: systemHash,
        promptText: userMsg,
        embedding: encodeEmbedding(vec),
        embeddingDim: vec.length,
        embeddingModel: embeddings.model,
        response: response.content,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      })
      .run();
  }

  function stats(): { entries: number; threshold: number; buckets: number } {
    let total = 0;
    for (const bucket of memory.values()) total += bucket.length;
    return { entries: total, threshold, buckets: memory.size };
  }

  return { get, put, stats };
}
