"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { gatewayClientFetch, gatewayUrl, adminHeaders } from "../../../lib/gateway-client";

function StarRating({
  value,
  onChange,
}: {
  value?: number;
  onChange: (v: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const displayed = hover ?? value ?? 0;
  return (
    <div className="flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= displayed;
        return (
          <button
            key={star}
            type="button"
            onClick={() => onChange(star)}
            onMouseEnter={() => setHover(star)}
            title={`Rate ${star} of 5`}
            aria-label={`Rate ${star} of 5`}
            className={`w-6 h-6 flex items-center justify-center text-base leading-none transition-colors ${
              filled ? "text-amber-400 hover:text-amber-300" : "text-zinc-700 hover:text-zinc-500"
            }`}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}

interface ProviderInfo {
  name: string;
  models: string[];
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  model?: string;
  requestId?: string;
  /** 1-5 star rating; undefined = not rated yet */
  feedbackScore?: number;
}

interface ProvaraMetadata {
  provider: string;
  latencyMs: number;
  cached: boolean;
  routing: {
    taskType: string;
    complexity: string;
    routedBy: string;
    usedFallback: boolean;
  };
}

export default function PlaygroundPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => {
    if (typeof window !== "undefined") return sessionStorage.getItem("pg:model") || "";
    return "";
  });
  const [selectedProvider, setSelectedProvider] = useState(() => {
    if (typeof window !== "undefined") return sessionStorage.getItem("pg:provider") || "";
    return "";
  });
  const [systemPrompt, setSystemPrompt] = useState(() => {
    if (typeof window !== "undefined") return sessionStorage.getItem("pg:system") || "";
    return "";
  });
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [messages, setMessages] = useState<Message[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = sessionStorage.getItem("pg:messages");
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });
  const [input, setInput] = useState("");
  const [topicStartIndex, setTopicStartIndex] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [lastMeta, setLastMeta] = useState<ProvaraMetadata | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    gatewayClientFetch<{ providers: ProviderInfo[] }>("/v1/providers")
      .then((data) => {
        setProviders(data.providers || []);
      })
      .catch(console.error);
  }, []);

  // Persist to sessionStorage (skip during streaming — background function handles it)
  useEffect(() => { if (!streaming) sessionStorage.setItem("pg:messages", JSON.stringify(messages)); }, [messages, streaming]);
  useEffect(() => { sessionStorage.setItem("pg:model", selectedModel); }, [selectedModel]);
  useEffect(() => { sessionStorage.setItem("pg:provider", selectedProvider); }, [selectedProvider]);
  useEffect(() => { sessionStorage.setItem("pg:system", systemPrompt); }, [systemPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  // The textarea is disabled while `streaming` is true, which blurs it. When
  // streaming flips back to false, React re-enables the element on the next
  // commit — refocus here so the user can keep typing without clicking back in.
  // Also fires once on mount (streaming starts false) to give the page focus.
  useEffect(() => {
    if (!streaming) inputRef.current?.focus();
  }, [streaming]);

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ provider: p.name, model: m }))
  );

  async function handleSend() {
    if (!input.trim() || streaming) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    let newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);
    setStreamingContent("");
    setLastMeta(null);

    // Only send messages from the current topic to the API
    const activeMessages = newMessages.slice(topicStartIndex);
    const apiMessages = systemPrompt
      ? [{ role: "system" as const, content: systemPrompt }, ...activeMessages]
      : activeMessages;

    // Persist immediately so navigating away preserves the user message
    sessionStorage.setItem("pg:messages", JSON.stringify(newMessages));
    sessionStorage.setItem("pg:streaming", "true");

    // Run the stream in a detached async context so it completes even
    // if the component unmounts during navigation
    streamInBackground(newMessages, apiMessages);
  }

  async function streamInBackground(newMessages: Message[], apiMessages: { role: string; content: string }[]) {
    try {
      const hdrs: Record<string, string> = { ...adminHeaders() };
      if (apiToken) {
        hdrs["Authorization"] = `Bearer ${apiToken}`;
      }

      const res = await fetch(gatewayUrl("/v1/chat/completions"), {
        method: "POST",
        credentials: "include",
        headers: hdrs,
        body: JSON.stringify({
          model: selectedModel,
          provider: selectedProvider || undefined,
          messages: apiMessages,
          stream: true,
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        const final = [...newMessages, { role: "assistant" as const, content: `Error: ${error.error?.message || res.statusText}` }];
        setMessages(final);
        sessionStorage.setItem("pg:messages", JSON.stringify(final));
        setStreaming(false);
        sessionStorage.removeItem("pg:streaming");
        return;
      }

      // Read model info from response headers
      const headerModel = res.headers.get("X-Provara-Model") || "";
      const requestId = res.headers.get("X-Provara-Request-Id") || undefined;

      // Check for guardrail violations
      const guardrailHeader = res.headers.get("X-Provara-Guardrail");
      if (guardrailHeader) {
        try {
          const violations: string[] = JSON.parse(guardrailHeader);
          if (violations.length > 0) {
            newMessages = [...newMessages, {
              role: "assistant" as const,
              content: `Guardrail triggered: ${violations.join(", ")}. Your input was redacted before being sent to the model.`,
            }];
            setMessages(newMessages);
            sessionStorage.setItem("pg:messages", JSON.stringify(newMessages));
          }
        } catch {}
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let fullContent = "";
      let responseModel = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (!responseModel && parsed.model) {
                responseModel = parsed.model;
              }
              const content = parsed.choices?.[0]?.delta?.content || "";
              fullContent += content;
              setStreamingContent(fullContent);
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      const finalMessages = [...newMessages, { role: "assistant" as const, content: fullContent, model: headerModel || responseModel || undefined, requestId }];
      setMessages(finalMessages);
      setStreamingContent("");
      // Persist completed messages so they survive navigation
      sessionStorage.setItem("pg:messages", JSON.stringify(finalMessages));
    } catch (err) {
      const finalMessages = [
        ...newMessages,
        { role: "assistant" as const, content: `Error: ${err instanceof Error ? err.message : "Request failed"}` },
      ];
      setMessages(finalMessages);
      sessionStorage.setItem("pg:messages", JSON.stringify(finalMessages));
    } finally {
      setStreaming(false);
      sessionStorage.removeItem("pg:streaming");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleClear() {
    setMessages([]);
    setStreamingContent("");
    setLastMeta(null);
    setTopicStartIndex(0);
    sessionStorage.removeItem("pg:messages");
  }

  async function handleRate(messageIndex: number, score: number) {
    const msg = messages[messageIndex];
    if (!msg?.requestId || score < 1 || score > 5) return;
    if (msg.feedbackScore === score) return; // no-op on re-click of same star

    // Optimistic update — flip the UI immediately, roll back if the POST fails
    const previousScore = msg.feedbackScore;
    const optimistic = messages.map((m, i) => (i === messageIndex ? { ...m, feedbackScore: score } : m));
    setMessages(optimistic);
    sessionStorage.setItem("pg:messages", JSON.stringify(optimistic));

    try {
      const hdrs: Record<string, string> = { "Content-Type": "application/json", ...adminHeaders() };
      if (apiToken) hdrs["Authorization"] = `Bearer ${apiToken}`;
      const res = await fetch(gatewayUrl("/v1/feedback"), {
        method: "POST",
        credentials: "include",
        headers: hdrs,
        body: JSON.stringify({ requestId: msg.requestId, score }),
      });
      if (!res.ok) {
        // Roll back
        const rolled = messages.map((m, i) => (i === messageIndex ? { ...m, feedbackScore: previousScore } : m));
        setMessages(rolled);
        sessionStorage.setItem("pg:messages", JSON.stringify(rolled));
      }
    } catch {
      const rolled = messages.map((m, i) => (i === messageIndex ? { ...m, feedbackScore: previousScore } : m));
      setMessages(rolled);
      sessionStorage.setItem("pg:messages", JSON.stringify(rolled));
    }
  }

  function handleModelChange(value: string) {
    if (!value) {
      setSelectedProvider("");
      setSelectedModel("");
      return;
    }
    const [provider, ...modelParts] = value.split("/");
    setSelectedProvider(provider);
    setSelectedModel(modelParts.join("/"));
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <select
            value={selectedModel ? `${selectedProvider}/${selectedModel}` : ""}
            onChange={(e) => handleModelChange(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-blue-500 max-w-md"
          >
            <option value="">Auto-routing (let Provara choose)</option>
            {providers.map((p) => (
              <optgroup key={p.name} label={p.name}>
                {p.models.map((m) => (
                  <option key={`${p.name}/${m}`} value={`${p.name}/${m}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
            >
              Settings
            </button>
            {messages.length > 0 && (
              <button
                onClick={() => { setTopicStartIndex(messages.length); }}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
              >
                New Topic
              </button>
            )}
            <button
              onClick={handleClear}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-6">
          <div className="max-w-4xl mx-auto space-y-6">
          {messages.length === 0 && !streamingContent && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <h2 className="text-xl font-semibold mb-2">Playground</h2>
                <p className="text-sm text-zinc-400">
                  Test models interactively. Select a model above or leave it blank to let the router pick the best one.
                </p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const isGuardrail = msg.role === "assistant" && msg.content.startsWith("Guardrail triggered:");
            const showDivider = topicStartIndex > 0 && i === topicStartIndex;
            return (
              <>{showDivider && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex-1 h-px bg-zinc-800" />
                  <span className="text-xs text-zinc-600 uppercase tracking-widest">New topic</span>
                  <div className="flex-1 h-px bg-zinc-800" />
                </div>
              )}
              <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                <div
                  className={`max-w-2xl rounded-xl px-4 py-3 ${
                    isGuardrail
                      ? "bg-amber-900/30 border border-amber-800/50 text-amber-300"
                      : msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-800 border border-zinc-700 text-zinc-200"
                  }`}
                >
                  {msg.model && !isGuardrail && (
                    <p className="text-xs text-zinc-500 mb-1.5 font-mono">{msg.model}</p>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
                {msg.role === "assistant" && !isGuardrail && msg.requestId && (
                  <div className="mt-1.5 ml-1">
                    <StarRating
                      value={msg.feedbackScore}
                      onChange={(v) => handleRate(i, v)}
                    />
                  </div>
                )}
              </div>
              </>
            );
          })}

          {streaming && !streamingContent && (
            <div className="flex justify-start">
              <div className="max-w-2xl rounded-xl px-4 py-3 bg-zinc-800 border border-zinc-700 text-zinc-200">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}

          {streamingContent && (
            <div className="flex justify-start">
              <div className="max-w-2xl rounded-xl px-4 py-3 bg-zinc-800 border border-zinc-700 text-zinc-200">
                <p className="text-sm whitespace-pre-wrap">{streamingContent}</p>
                <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse ml-0.5" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="flex gap-3 items-end max-w-4xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
              disabled={streaming}
              rows={1}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50 overflow-hidden"
              style={{ minHeight: "44px", maxHeight: "200px" }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "44px";
                target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
              }}
            />
            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              className="px-4 h-[44px] bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-xl text-sm font-medium transition-colors shrink-0"
            >
              {streaming ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="w-72 border-l border-zinc-800 bg-zinc-900/50 p-4 space-y-5 overflow-y-auto">
          <h3 className="text-sm font-semibold text-zinc-300">Settings</h3>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={4}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs text-zinc-400">Temperature</label>
              <span className="text-xs text-zinc-300">{temperature}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-xs text-zinc-600">
              <span>Precise</span>
              <span>Creative</span>
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs text-zinc-400">Max Tokens</label>
              <span className="text-xs text-zinc-300">{maxTokens}</span>
            </div>
            <input
              type="range"
              min={64}
              max={4096}
              step={64}
              value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">API Token</label>
            <input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="pvra_... (optional if signed in)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 font-mono placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-zinc-500 mt-1">
              Required if API tokens are enabled and you're not signed in via OAuth. Paste a token from the Tokens page.
            </p>
          </div>

          <div className="pt-2 border-t border-zinc-800">
            <p className="text-xs text-zinc-500">
              Requests use your configured API keys and go through the routing pipeline.
              {selectedModel ? ` Using ${selectedProvider}/${selectedModel}.` : " Auto-routing enabled."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
