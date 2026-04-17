"use client";

import { useCallback, useEffect, useState } from "react";
import { gatewayClientFetch } from "../../lib/gateway-client";
import type { ChatMessage } from "./types";

export interface SavedConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface SavedConversationDetail extends SavedConversationSummary {
  messages: ChatMessage[];
}

/**
 * Persistent conversation list for the current tenant, backed by
 * /v1/conversations. The list is fetched on mount and refreshed after
 * every mutating call so the sidebar stays consistent with the server
 * without fighting with optimistic UI.
 *
 * Auto-save contract: callers own when to call `save` — typically after
 * an assistant turn completes. We dedupe internally: if the conversation
 * already exists, we PATCH; if not, we POST and capture the new id.
 */
export function useSavedConversations() {
  const [list, setList] = useState<SavedConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gatewayClientFetch<{ conversations: SavedConversationSummary[] }>(
        "/v1/conversations",
      );
      setList(data.conversations || []);
    } catch {
      // Silent — sidebar handles the empty case.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const load = useCallback(async (id: string): Promise<SavedConversationDetail | null> => {
    try {
      return await gatewayClientFetch<SavedConversationDetail>(`/v1/conversations/${id}`);
    } catch {
      return null;
    }
  }, []);

  const create = useCallback(
    async (messages: ChatMessage[], title?: string): Promise<string | null> => {
      try {
        const res = await gatewayClientFetch<{ id: string }>("/v1/conversations", {
          method: "POST",
          body: JSON.stringify({ title, messages }),
        });
        await refresh();
        return res.id;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: { title?: string; messages?: ChatMessage[] }) => {
      try {
        await gatewayClientFetch(`/v1/conversations/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        await refresh();
      } catch {
        // Silent; next successful refresh will correct.
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await gatewayClientFetch(`/v1/conversations/${id}`, { method: "DELETE" });
        await refresh();
      } catch {}
    },
    [refresh],
  );

  return { list, loading, refresh, load, create, update, remove };
}
