import type { CompletionResponse } from "../providers/types.js";
import type { ChatMessage } from "../providers/types.js";

interface CacheEntry {
  response: CompletionResponse;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 1000;

const cache = new Map<string, CacheEntry>();

function hashKey(messages: ChatMessage[]): string {
  const raw = messages.map((m) => `${m.role}:${m.content}`).join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function getCached(messages: ChatMessage[]): CompletionResponse | null {
  const key = hashKey(messages);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.response;
}

export function putCache(
  messages: ChatMessage[],
  response: CompletionResponse,
  ttlMs: number = DEFAULT_TTL_MS
): void {
  const key = hashKey(messages);

  // Evict oldest entries if full
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value!;
    cache.delete(firstKey);
  }

  cache.set(key, {
    response,
    expiresAt: Date.now() + ttlMs,
  });
}

export function cacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_ENTRIES };
}
