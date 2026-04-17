"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage, MessageAction } from "./types";

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  streamingContent: string;
  topicStartIndex: number;
  actions?: MessageAction[];
  renderContent?: (msg: ChatMessage) => ReactNode;
  emptyState?: ReactNode;
}

export function MessageList({
  messages,
  streaming,
  streamingContent,
  topicStartIndex,
  actions,
  renderContent,
  emptyState,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg overflow-y-auto scrollbar-thin px-4 py-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {messages.length === 0 && !streamingContent && emptyState}

        {messages.map((msg, i) => {
          const showDivider = topicStartIndex > 0 && i === topicStartIndex;
          return (
            <div key={i}>
              {showDivider && (
                <div className="flex items-center gap-3 py-2 mb-6">
                  <div className="flex-1 h-px bg-zinc-800" />
                  <span className="text-xs text-zinc-600 uppercase tracking-widest">
                    New topic
                  </span>
                  <div className="flex-1 h-px bg-zinc-800" />
                </div>
              )}
              <MessageBubble
                message={msg}
                index={i}
                actions={actions}
                renderContent={renderContent}
              />
            </div>
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

        <div ref={endRef} />
      </div>
    </div>
  );
}
