"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { gatewayClientFetch } from "../../../lib/gateway-client";
import { MessageList } from "../../../components/chat/MessageList";
import { MarkdownMessage } from "../../../components/chat/MarkdownMessage";
import type { ChatMessage } from "../../../components/chat/types";

interface SharedConversation {
  token: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  conversationCreatedAt: string;
}

export default function SharedConversationPage() {
  const params = useParams();
  const token = (params?.token as string) || "";
  const [data, setData] = useState<SharedConversation | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!token) return;
    gatewayClientFetch<SharedConversation>(`/v1/shared/${token}`)
      .then(setData)
      .catch(() => setNotFound(true));
  }, [token]);

  function renderContent(msg: ChatMessage) {
    if (msg.role === "assistant") {
      return <MarkdownMessage content={msg.content} />;
    }
    return <p className="text-sm whitespace-pre-wrap">{msg.content}</p>;
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="text-center">
          <h1 className="text-xl font-semibold mb-2">Link expired</h1>
          <p className="text-sm text-zinc-400">This share link has been revoked or never existed.</p>
          <a href="/" className="inline-block mt-4 text-blue-400 hover:text-blue-300 underline text-sm">
            Go to Provara
          </a>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-widest">Shared conversation</p>
          <h1 className="text-sm font-medium text-zinc-200">{data.title}</h1>
        </div>
        <a
          href="/"
          className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg px-3 py-1.5 transition-colors"
        >
          Try Provara →
        </a>
      </div>
      <MessageList
        messages={data.messages}
        streaming={false}
        streamingContent=""
        topicStartIndex={0}
        renderContent={renderContent}
        emptyState={<p className="text-center text-zinc-500 mt-8">This conversation is empty.</p>}
      />
    </div>
  );
}
