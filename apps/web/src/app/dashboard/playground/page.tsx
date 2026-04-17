"use client";

import { useEffect, useRef, useState } from "react";
import { gatewayClientFetch } from "../../../lib/gateway-client";
import { ChatInput, type ChatInputHandle } from "../../../components/chat/ChatInput";
import { MessageList } from "../../../components/chat/MessageList";
import { SettingsPanel } from "../../../components/chat/SettingsPanel";
import { StarRating } from "../../../components/chat/StarRating";
import { CopyButton } from "../../../components/chat/CopyButton";
import { MarkdownMessage } from "../../../components/chat/MarkdownMessage";
import { ModelInfoPopover } from "../../../components/chat/ModelInfoPopover";
import { ConversationSidebar } from "../../../components/chat/ConversationSidebar";
import { PromptPresetPicker } from "../../../components/chat/PromptPresetPicker";
import { useChatSession } from "../../../components/chat/use-chat-session";
import { useSessionPersist } from "../../../components/chat/use-session-persist";
import { useSavedConversations } from "../../../components/chat/use-saved-conversations";
import type { ChatMessage, MessageAction } from "../../../components/chat/types";
import type { PromptPreset } from "../../../components/chat/presets";

interface ProviderInfo {
  name: string;
  models: string[];
}

export default function PlaygroundPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedModel, setSelectedModel] = useSessionPersist("pg:model", "");
  const [selectedProvider, setSelectedProvider] = useSessionPersist("pg:provider", "");
  const [systemPrompt, setSystemPrompt] = useSessionPersist("pg:system", "");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [apiToken, setApiToken] = useState("");
  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showConversations, setShowConversations] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const inputRef = useRef<ChatInputHandle>(null);

  const session = useChatSession();
  const saved = useSavedConversations();

  useEffect(() => {
    gatewayClientFetch<{ providers: ProviderInfo[] }>("/v1/providers")
      .then((data) => setProviders(data.providers || []))
      .catch(console.error);
  }, []);

  // Auto-save when messages change and streaming has completed. Creates on the
  // first assistant turn of an unsaved session; otherwise PATCHes the active
  // conversation. Small debounce to avoid a write per keystroke during
  // streaming (we already skip via `session.streaming`, but defensive).
  useEffect(() => {
    if (session.streaming) return;
    if (session.messages.length === 0) return;
    const hasAssistant = session.messages.some((m) => m.role === "assistant");
    if (!hasAssistant) return; // don't save conversations with only a user prompt typed but no reply

    const handle = setTimeout(async () => {
      if (activeConversationId) {
        await saved.update(activeConversationId, { messages: session.messages });
      } else {
        const id = await saved.create(session.messages);
        if (id) setActiveConversationId(id);
      }
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.messages, session.streaming]);

  async function handleSelectConversation(id: string) {
    const detail = await saved.load(id);
    if (!detail) return;
    session.loadMessages(detail.messages);
    setActiveConversationId(id);
  }

  function handleNewConversation() {
    session.clear();
    setActiveConversationId(null);
  }

  async function handleDeleteConversation(id: string) {
    await saved.remove(id);
    if (id === activeConversationId) {
      session.clear();
      setActiveConversationId(null);
    }
  }

  async function handleFork(messageIndex: number) {
    // Take messages up through (inclusive) the chosen turn and create a new
    // conversation from them. Load it as the active session so the user can
    // continue from the branch point without losing the original.
    const slice = session.messages.slice(0, messageIndex + 1);
    if (slice.length === 0) return;
    const firstUser = slice.find((m) => m.role === "user")?.content?.trim() || "Forked conversation";
    const truncated = firstUser.replace(/\s+/g, " ").slice(0, 59);
    const title = `${truncated}… (fork)`;
    const id = await saved.create(slice, title);
    if (!id) return;
    session.loadMessages(slice);
    setActiveConversationId(id);
  }

  async function handleShare() {
    if (!activeConversationId) {
      // Auto-save first so there's something to share.
      if (session.messages.length === 0) return;
      const id = await saved.create(session.messages);
      if (!id) return;
      setActiveConversationId(id);
      // Small wait so the server has committed; then share.
      await new Promise((r) => setTimeout(r, 200));
      return doShare(id);
    }
    return doShare(activeConversationId);
  }

  async function doShare(id: string) {
    try {
      const res = await gatewayClientFetch<{ token: string }>(`/v1/conversations/${id}/share`, {
        method: "POST",
      });
      const url = `${window.location.origin}/shared/${res.token}`;
      try {
        await navigator.clipboard.writeText(url);
        alert(`Share link copied to clipboard:\n\n${url}`);
      } catch {
        // Clipboard blocked — show the URL directly so the user can copy manually.
        prompt("Share link:", url);
      }
    } catch {
      alert("Failed to create share link.");
    }
  }

  function handlePresetPick(preset: PromptPreset) {
    if (preset.systemPrompt) setSystemPrompt(preset.systemPrompt);
    setInput(preset.body);
  }

  async function handleSend() {
    const text = input;
    setInput("");
    await session.send(text, {
      selectedModel,
      selectedProvider,
      systemPrompt,
      temperature,
      maxTokens,
      apiToken: apiToken || undefined,
    });
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

  const ratingAction: MessageAction = {
    id: "rating",
    showFor: (msg) => msg.role === "assistant" && !!msg.requestId,
    render: (msg, i) => (
      <StarRating
        value={msg.feedbackScore}
        onChange={(v) => session.rate(i, v, apiToken || undefined)}
      />
    ),
  };

  const copyAction: MessageAction = {
    id: "copy",
    // Show on every message, user and assistant alike — "copy what I said" is useful too.
    showFor: () => true,
    render: (msg) => <CopyButton text={msg.content} />,
  };

  const forkAction: MessageAction = {
    id: "fork",
    showFor: (msg) => msg.role === "assistant",
    render: (_msg, i) => (
      <button
        type="button"
        onClick={() => handleFork(i)}
        className="px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 border border-transparent hover:border-zinc-700 rounded transition-colors"
        title="Fork conversation from here"
      >
        Fork
      </button>
    ),
  };

  // Render assistant messages as markdown; user prompts stay as plain text so
  // their exact input is preserved visually (no surprise auto-formatting).
  function renderContent(msg: ChatMessage) {
    if (msg.role === "assistant") {
      return <MarkdownMessage content={msg.content} />;
    }
    return <p className="text-sm whitespace-pre-wrap">{msg.content}</p>;
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] gap-3 p-3">
      <ConversationSidebar
        open={showConversations}
        list={saved.list}
        activeId={activeConversationId}
        onSelect={handleSelectConversation}
        onNew={handleNewConversation}
        onDelete={handleDeleteConversation}
        loading={saved.loading}
      />
      <div className="flex-1 flex flex-col min-w-0 gap-3">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg">
          <button
            onClick={() => setShowConversations((v) => !v)}
            title={showConversations ? "Hide conversations" : "Show conversations"}
            aria-label={showConversations ? "Hide conversations" : "Show conversations"}
            className="w-8 h-8 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            ☰
          </button>
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
          <ModelInfoPopover selectedProvider={selectedProvider} selectedModel={selectedModel} />

          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
            >
              Settings
            </button>
            {session.messages.length > 0 && (
              <button
                onClick={session.startNewTopic}
                title="Draws a divider and stops sending prior messages to the model — saves tokens when you change subject without wanting to lose the transcript."
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
              >
                New Topic
              </button>
            )}
            {session.messages.some((m) => m.role === "assistant") && (
              <button
                onClick={handleShare}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
                title="Create a public share link"
              >
                Share
              </button>
            )}
            <button
              onClick={handleNewConversation}
              title="Start a fresh conversation. The current chat stays saved in the sidebar."
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        <MessageList
          messages={session.messages}
          streaming={session.streaming}
          streamingContent={session.streamingContent}
          topicStartIndex={session.topicStartIndex}
          actions={[copyAction, forkAction, ratingAction]}
          renderContent={renderContent}
          emptyState={
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <h2 className="text-xl font-semibold mb-2">Playground</h2>
                <p className="text-sm text-zinc-400">
                  Test models interactively. Select a model above or leave it blank to let the router pick the best one.
                </p>
              </div>
            </div>
          }
        />

        <ChatInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={session.streaming}
          leftAddon={<PromptPresetPicker onPick={handlePresetPick} />}
          rightAddon={
            session.streaming ? (
              <button
                type="button"
                onClick={session.stop}
                className="px-3 h-[44px] bg-red-600 hover:bg-red-500 rounded-xl text-sm font-medium text-white transition-colors shrink-0"
              >
                Stop
              </button>
            ) : undefined
          }
        />
      </div>

      <SettingsPanel open={showSettings}>
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
            Required if API tokens are enabled and you&apos;re not signed in via OAuth. Paste a token from the Tokens page.
          </p>
        </div>

        <div className="pt-2 border-t border-zinc-800">
          <p className="text-xs text-zinc-500">
            Requests use your configured API keys and go through the routing pipeline.
            {selectedModel ? ` Using ${selectedProvider}/${selectedModel}.` : " Auto-routing enabled."}
          </p>
        </div>
      </SettingsPanel>
    </div>
  );
}
