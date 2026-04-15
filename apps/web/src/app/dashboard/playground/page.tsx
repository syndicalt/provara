"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { gatewayClientFetch, gatewayUrl, adminHeaders } from "../../../lib/gateway-client";

interface ProviderInfo {
  name: string;
  models: string[];
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
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
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({ provider: p.name, model: m }))
  );

  async function handleSend() {
    if (!input.trim() || streaming) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setStreaming(true);
    setStreamingContent("");
    setLastMeta(null);

    const apiMessages = systemPrompt
      ? [{ role: "system" as const, content: systemPrompt }, ...newMessages]
      : newMessages;

    try {
      const headers: Record<string, string> = { ...adminHeaders() };
      if (apiToken) {
        headers["Authorization"] = `Bearer ${apiToken}`;
      }

      const res = await fetch(gatewayUrl("/v1/chat/completions"), {
        method: "POST",
        credentials: "include",
        headers,
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
        setMessages([...newMessages, { role: "assistant", content: `Error: ${error.error?.message || res.statusText}` }]);
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let fullContent = "";

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
              const content = parsed.choices?.[0]?.delta?.content || "";
              fullContent += content;
              setStreamingContent(fullContent);
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      setMessages([...newMessages, { role: "assistant", content: fullContent }]);
      setStreamingContent("");

      // Fetch the last request to get _provara metadata
      // (streaming doesn't include it in the SSE events)
    } catch (err) {
      setMessages([
        ...newMessages,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Request failed"}` },
      ]);
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
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
            <button
              onClick={handleClear}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-6 space-y-6">
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

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-2xl rounded-xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-800 border border-zinc-700 text-zinc-200"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}

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
