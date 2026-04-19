/**
 * In-process pub/sub for the live traffic tap (#263). The gateway writes a
 * `requests` row on every completed chat-completion (live, cached, streaming)
 * and then publishes a compact event to this emitter; the SSE handler at
 * `/v1/analytics/live` subscribes, filters by tenant, and forwards to the
 * browser.
 *
 * Single-process by design — Railway runs one gateway replica in the common
 * case, and the live view is ephemeral (missing a few events on restart is
 * fine, full history is in `/dashboard/logs`). If we go multi-replica the
 * right move is a Redis fan-out, not persisting this stream.
 */

export interface LiveEvent {
  id: string;
  provider: string;
  model: string;
  taskType: string | null;
  complexity: string | null;
  routedBy: string | null;
  cached: boolean;
  usedFallback: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  tenantId: string | null;
  userId: string | null;
  apiTokenId: string | null;
  promptPreview: string;
  createdAt: string;
}

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: LiveEvent): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch (err) {
      console.warn("[live-emitter] listener threw:", err instanceof Error ? err.message : err);
    }
  }
}

/** Truncate a JSON-encoded messages array to a short preview. Handles both
 *  string content and ContentPart[] — images are rendered as `[image]` so the
 *  preview stays text-only and bounded in size. */
export function buildPromptPreview(promptJson: string, maxChars = 200): string {
  try {
    const messages = JSON.parse(promptJson) as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return "";
    const text =
      typeof lastUser.content === "string"
        ? lastUser.content
        : lastUser.content
            .map((p) => (p.type === "text" && p.text ? p.text : p.type === "image_url" ? "[image]" : ""))
            .filter(Boolean)
            .join(" ");
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  } catch {
    return promptJson.slice(0, maxChars);
  }
}
