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
