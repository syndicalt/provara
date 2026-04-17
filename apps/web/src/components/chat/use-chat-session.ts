"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminHeaders, gatewayUrl } from "../../lib/gateway-client";
import type { ChatMessage } from "./types";

export interface ChatSessionConfig {
  /** Provider override, e.g. "openai". Empty means let the router pick. */
  selectedProvider: string;
  /** Model override, e.g. "gpt-4o". Empty means auto-routing. */
  selectedModel: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  /** Optional bearer token when gateway auth is enabled. */
  apiToken?: string;
}

const STORAGE_KEY = "pg:messages";
const STREAMING_FLAG_KEY = "pg:streaming";

/**
 * Chat session state machine + SSE streaming. Ownership:
 * - Messages + streaming status live here.
 * - Callers own model/provider/system-prompt state; they pass it as config
 *   snapshot at send time. (Intentional: lets the same chat session be used
 *   with a multi-model compare later, where config differs per column.)
 * - sessionStorage key `pg:messages` is the persistence contract. Moving to
 *   a DB-backed conversation store will replace the internal writes without
 *   the caller needing to know.
 */
export function useChatSession() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved) as ChatMessage[];
    } catch {}
    return [];
  });
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [topicStartIndex, setTopicStartIndex] = useState(0);

  // AbortController for the active stream. Populated in `send`, cleared in
  // the finally block. Exposed via `stop()` so the caller can abort mid-stream.
  const abortRef = useRef<AbortController | null>(null);

  const persistMessages = useCallback((next: ChatMessage[]) => {
    if (typeof window !== "undefined") {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  }, []);

  // Persist on every change except during streaming — the stream handler
  // writes explicitly at known checkpoints to avoid a thrash loop.
  useEffect(() => {
    if (!streaming) persistMessages(messages);
  }, [messages, streaming, persistMessages]);

  const send = useCallback(
    async (input: string, config: ChatSessionConfig) => {
      if (!input.trim() || streaming) return;

      const userMessage: ChatMessage = { role: "user", content: input.trim() };
      let workingMessages: ChatMessage[] = [...messages, userMessage];
      setMessages(workingMessages);
      setStreaming(true);
      setStreamingContent("");

      // Only send messages from the current topic to the API.
      const activeMessages = workingMessages.slice(topicStartIndex);
      const apiMessages = config.systemPrompt
        ? [{ role: "system" as const, content: config.systemPrompt }, ...activeMessages]
        : activeMessages;

      persistMessages(workingMessages);
      if (typeof window !== "undefined") {
        sessionStorage.setItem(STREAMING_FLAG_KEY, "true");
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const hdrs: Record<string, string> = { ...adminHeaders() };
        if (config.apiToken) hdrs["Authorization"] = `Bearer ${config.apiToken}`;

        const res = await fetch(gatewayUrl("/v1/chat/completions"), {
          method: "POST",
          credentials: "include",
          signal: controller.signal,
          headers: hdrs,
          body: JSON.stringify({
            model: config.selectedModel,
            provider: config.selectedProvider || undefined,
            messages: apiMessages,
            stream: true,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
          }),
        });

        if (!res.ok) {
          const error = await res.json().catch(() => ({}));
          const final: ChatMessage[] = [
            ...workingMessages,
            {
              role: "assistant",
              content: `Error: ${error.error?.message || res.statusText}`,
            },
          ];
          setMessages(final);
          persistMessages(final);
          return;
        }

        const headerModel = res.headers.get("X-Provara-Model") || "";
        const requestId = res.headers.get("X-Provara-Request-Id") || undefined;
        const cacheSource = (res.headers.get("X-Provara-Cache") as "exact" | "semantic" | null) || undefined;
        // Non-streaming cache hits set cost/latency headers directly. Streaming
        // hits can't (headers are already sent by the time we know token
        // counts), so they arrive via the trailing `_provara` SSE event.
        const headerLatency = Number(res.headers.get("X-Provara-Latency")) || undefined;
        const headerCost = Number(res.headers.get("X-Provara-Cost")) || undefined;

        // Guardrails surface as a pre-response message; they abort the stream.
        const guardrailHeader = res.headers.get("X-Provara-Guardrail");
        if (guardrailHeader) {
          try {
            const violations: string[] = JSON.parse(guardrailHeader);
            if (violations.length > 0) {
              workingMessages = [
                ...workingMessages,
                {
                  role: "assistant",
                  content: `Guardrail triggered: ${violations.join(", ")}. Your input was redacted before being sent to the model.`,
                },
              ];
              setMessages(workingMessages);
              persistMessages(workingMessages);
            }
          } catch {}
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No reader");

        const decoder = new TextDecoder();
        let fullContent = "";
        let responseModel = "";
        let streamMeta: { latencyMs?: number; cost?: number; usage?: { inputTokens: number; outputTokens: number } } = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              // The gateway emits a final `{_provara: {...}}` event right
              // before [DONE] with cost/latency/usage so we can attach them
              // to the message without a second round-trip.
              if (parsed._provara) {
                streamMeta = parsed._provara;
                continue;
              }
              if (!responseModel && parsed.model) responseModel = parsed.model;
              const delta = parsed.choices?.[0]?.delta?.content || "";
              fullContent += delta;
              setStreamingContent(fullContent);
            } catch {
              // ignore malformed chunks
            }
          }
        }

        const finalMessages: ChatMessage[] = [
          ...workingMessages,
          {
            role: "assistant",
            content: fullContent,
            model: headerModel || responseModel || undefined,
            requestId,
            cacheSource,
            cost: streamMeta.cost ?? headerCost,
            latencyMs: streamMeta.latencyMs ?? headerLatency,
            inputTokens: streamMeta.usage?.inputTokens,
            outputTokens: streamMeta.usage?.outputTokens,
          },
        ];
        setMessages(finalMessages);
        setStreamingContent("");
        persistMessages(finalMessages);
      } catch (err) {
        // AbortError is a user-initiated stop; don't surface it as an error.
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (!aborted) {
          const final: ChatMessage[] = [
            ...workingMessages,
            {
              role: "assistant",
              content: `Error: ${err instanceof Error ? err.message : "Request failed"}`,
            },
          ];
          setMessages(final);
          persistMessages(final);
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        if (typeof window !== "undefined") sessionStorage.removeItem(STREAMING_FLAG_KEY);
      }
    },
    [messages, streaming, topicStartIndex, persistMessages],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setStreamingContent("");
    setTopicStartIndex(0);
    if (typeof window !== "undefined") sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  /**
   * Replace the active session's messages wholesale — used when loading a
   * saved conversation from the sidebar. Resets the topic boundary so the
   * whole loaded transcript is one topic.
   */
  const loadMessages = useCallback((next: ChatMessage[]) => {
    setMessages(next);
    setStreamingContent("");
    setTopicStartIndex(0);
    persistMessages(next);
  }, [persistMessages]);

  const startNewTopic = useCallback(() => {
    setTopicStartIndex(messages.length);
  }, [messages.length]);

  /**
   * Rate an assistant message by its index. Optimistic; rolls back on server
   * failure. No-ops if the message has no requestId (e.g. cached replies
   * before the ID header existed) or the score is unchanged.
   */
  const rate = useCallback(
    async (messageIndex: number, score: number, apiToken?: string) => {
      const msg = messages[messageIndex];
      if (!msg?.requestId || score < 1 || score > 5) return;
      if (msg.feedbackScore === score) return;

      const previousScore = msg.feedbackScore;
      const optimistic = messages.map((m, i) =>
        i === messageIndex ? { ...m, feedbackScore: score } : m,
      );
      setMessages(optimistic);
      persistMessages(optimistic);

      try {
        const hdrs: Record<string, string> = {
          "Content-Type": "application/json",
          ...adminHeaders(),
        };
        if (apiToken) hdrs["Authorization"] = `Bearer ${apiToken}`;
        const res = await fetch(gatewayUrl("/v1/feedback"), {
          method: "POST",
          credentials: "include",
          headers: hdrs,
          body: JSON.stringify({ requestId: msg.requestId, score }),
        });
        if (!res.ok) {
          const rolled = messages.map((m, i) =>
            i === messageIndex ? { ...m, feedbackScore: previousScore } : m,
          );
          setMessages(rolled);
          persistMessages(rolled);
        }
      } catch {
        const rolled = messages.map((m, i) =>
          i === messageIndex ? { ...m, feedbackScore: previousScore } : m,
        );
        setMessages(rolled);
        persistMessages(rolled);
      }
    },
    [messages, persistMessages],
  );

  return {
    messages,
    streaming,
    streamingContent,
    topicStartIndex,
    send,
    stop,
    clear,
    loadMessages,
    startNewTopic,
    rate,
  };
}

export type ChatSession = ReturnType<typeof useChatSession>;
