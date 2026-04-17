import type { ReactNode } from "react";
import type { ChatMessage, MessageAction } from "./types";

interface Props {
  message: ChatMessage;
  index: number;
  actions?: MessageAction[];
  /** Replace the default text renderer with custom markup (e.g. markdown). */
  renderContent?: (msg: ChatMessage) => ReactNode;
}

function defaultContent(msg: ChatMessage): ReactNode {
  return <p className="text-sm whitespace-pre-wrap">{msg.content}</p>;
}

function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function Meta({ message }: { message: ChatMessage }) {
  const parts: string[] = [];
  if (message.cacheSource) parts.push(`cache: ${message.cacheSource}`);
  if (message.latencyMs !== undefined) parts.push(formatLatency(message.latencyMs));
  if (message.cost !== undefined && message.cost > 0) parts.push(formatCost(message.cost));
  const tokenParts: string[] = [];
  if (message.inputTokens !== undefined) tokenParts.push(`${message.inputTokens} in`);
  if (message.outputTokens !== undefined) tokenParts.push(`${message.outputTokens} out`);
  if (tokenParts.length > 0) parts.push(tokenParts.join(" / "));
  if (parts.length === 0) return null;
  return <p className="text-xs text-zinc-500 mt-1 ml-1 font-mono">{parts.join(" · ")}</p>;
}

export function MessageBubble({ message, index, actions, renderContent }: Props) {
  const isGuardrail =
    message.role === "assistant" && message.content.startsWith("Guardrail triggered:");
  const render = renderContent ?? defaultContent;

  return (
    <div
      className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}
    >
      <div
        className={`max-w-2xl rounded-xl px-4 py-3 ${
          isGuardrail
            ? "bg-amber-900/30 border border-amber-800/50 text-amber-300"
            : message.role === "user"
            ? "bg-blue-600 text-white"
            : "bg-zinc-800 border border-zinc-700 text-zinc-200"
        }`}
      >
        {message.model && !isGuardrail && (
          <p className="text-xs text-zinc-500 mb-1.5 font-mono">{message.model}</p>
        )}
        {render(message)}
      </div>
      {message.role === "assistant" && !isGuardrail && <Meta message={message} />}
      {!isGuardrail && actions && actions.length > 0 && (
        <div className="mt-1.5 ml-1 flex items-center gap-2">
          {actions
            .filter((a) => (a.showFor ? a.showFor(message) : message.role === "assistant"))
            .map((a) => (
              <span key={a.id}>{a.render(message, index)}</span>
            ))}
        </div>
      )}
    </div>
  );
}
