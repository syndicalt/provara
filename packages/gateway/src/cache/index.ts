import type { CompletionResponse, ToolChoice, ToolDefinition } from "../providers/types.js";
import type { ChatMessage } from "../providers/types.js";
import { messageText } from "../providers/types.js";

interface CacheEntry {
  response: CompletionResponse;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 1000;

const cache = new Map<string, CacheEntry>();

/** Canonical JSON with sorted object keys. Two requests with equivalent tools
 *  but different JSON key orderings must map to the same cache entry. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function hashKey(
  messages: ChatMessage[],
  provider: string,
  model: string,
  tools?: ToolDefinition[],
  toolChoice?: ToolChoice,
): string {
  const toolsSig = tools && tools.length > 0 ? stableStringify(tools) : "";
  const choiceSig = toolChoice !== undefined ? stableStringify(toolChoice) : "";
  const raw =
    `${provider}::${model}::${toolsSig}::${choiceSig}::` +
    messages.map((m) => `${m.role}:${messageText(m)}`).join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function getCached(
  messages: ChatMessage[],
  provider: string,
  model: string,
  tools?: ToolDefinition[],
  toolChoice?: ToolChoice,
): CompletionResponse | null {
  const key = hashKey(messages, provider, model, tools, toolChoice);
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
  provider: string,
  model: string,
  response: CompletionResponse,
  ttlMs: number = DEFAULT_TTL_MS,
  tools?: ToolDefinition[],
  toolChoice?: ToolChoice,
): void {
  const key = hashKey(messages, provider, model, tools, toolChoice);

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
