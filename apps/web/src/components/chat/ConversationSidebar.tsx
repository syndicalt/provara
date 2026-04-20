"use client";

import type { SavedConversationSummary } from "./use-saved-conversations";

interface Props {
  open: boolean;
  list: SavedConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  loading: boolean;
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - d);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ConversationSidebar({
  open,
  list,
  activeId,
  onSelect,
  onNew,
  onDelete,
  loading,
}: Props) {
  if (!open) return null;
  return (
    <div className="w-60 bg-zinc-900 border border-zinc-800 rounded-lg flex flex-col overflow-hidden">
      <div className="p-2 border-b border-zinc-800">
        <button
          type="button"
          onClick={onNew}
          className="w-full px-3 py-2 text-xs text-zinc-300 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-700 transition-colors"
        >
          + New conversation
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading && list.length === 0 && (
          <p className="text-xs text-zinc-500 p-3">Loading…</p>
        )}
        {!loading && list.length === 0 && (
          <p className="text-xs text-zinc-500 p-3 leading-relaxed">
            No saved conversations yet. Start chatting — your session will auto-save
            after the first response.
          </p>
        )}
        {list.map((c) => {
          const isActive = c.id === activeId;
          return (
            <div
              key={c.id}
              className={`group px-3 py-2 cursor-pointer border-l-2 transition-colors ${
                isActive
                  ? "border-blue-500 bg-zinc-800/60"
                  : "border-transparent hover:bg-zinc-800/40"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <div className="flex items-start justify-between gap-1">
                <p className="text-xs text-zinc-200 truncate leading-snug flex-1 min-w-0 pt-1">{c.title}</p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${c.title}"?`)) onDelete(c.id);
                  }}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded opacity-30 group-hover:opacity-100 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-opacity"
                  aria-label="Delete conversation"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="text-[10px] text-zinc-500 mt-0.5">{relativeTime(c.updatedAt)}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
