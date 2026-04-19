"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { gatewayUrl } from "../../../lib/gateway-client";
import { formatCost, formatLatency, formatTokens } from "../../../lib/format";

interface LiveEvent {
  id: string;
  provider: string;
  model: string;
  taskType: string | null;
  complexity: string | null;
  routedBy: string | null;
  cached: boolean;
  usedFallback: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  tenantId: string | null;
  userId: string | null;
  apiTokenId: string | null;
  promptPreview: string;
  createdAt: string;
}

const MAX_EVENTS = 200;

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50",
  anthropic: "bg-orange-900/40 text-orange-300 border-orange-800/50",
  google: "bg-blue-900/40 text-blue-300 border-blue-800/50",
  mistral: "bg-purple-900/40 text-purple-300 border-purple-800/50",
  xai: "bg-cyan-900/40 text-cyan-300 border-cyan-800/50",
  zai: "bg-pink-900/40 text-pink-300 border-pink-800/50",
  ollama: "bg-zinc-800 text-zinc-300 border-zinc-700",
};

export default function LivePage() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [routedByFilter, setRoutedByFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");

  // Pause buffer — events arrive while paused go here so Resume can flush them.
  const pausedBuffer = useRef<LiveEvent[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const url = gatewayUrl("/v1/analytics/live");
    // EventSource doesn't support credentials:include by default on cross-origin;
    // we rely on the gateway's CORS config already set up for the dashboard. If
    // cookies don't reach it, the gateway will reject as anonymous — fine for
    // self-host single-tenant, and CORS is configured correctly for cloud.
    const es = new EventSource(url, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as LiveEvent;
        if (pausedRef.current) {
          pausedBuffer.current.push(ev);
          return;
        }
        setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS));
      } catch {}
    };
    return () => es.close();
  }, []);

  function resume() {
    const buffered = pausedBuffer.current;
    pausedBuffer.current = [];
    setPaused(false);
    if (buffered.length > 0) {
      setEvents((prev) => [...buffered.reverse(), ...prev].slice(0, MAX_EVENTS));
    }
  }

  function clear() {
    setEvents([]);
    pausedBuffer.current = [];
  }

  const filtered = events.filter((e) => {
    if (providerFilter && e.provider !== providerFilter) return false;
    if (modelFilter && !e.model.includes(modelFilter)) return false;
    if (routedByFilter && e.routedBy !== routedByFilter) return false;
    if (userFilter && e.userId !== userFilter) return false;
    return true;
  });

  const uniqueProviders = Array.from(new Set(events.map((e) => e.provider))).sort();
  const uniqueRoutedBy = Array.from(new Set(events.map((e) => e.routedBy).filter(Boolean) as string[])).sort();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Live</h1>
          <span className="flex items-center gap-1.5 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"}`} />
            <span className="text-zinc-500">{connected ? "streaming" : "disconnected"}</span>
          </span>
          {paused && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/50">
              paused · {pausedBuffer.current.length} buffered
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => (paused ? resume() : setPaused(true))}
            className="px-3 py-1.5 text-sm rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={clear}
            className="px-3 py-1.5 text-sm rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200"
          >
            Clear
          </button>
        </div>
      </div>

      <p className="text-sm text-zinc-500">
        Ephemeral tail of completed chat-completion requests in this workspace. No server-side history — for time-bounded lookups use <Link href="/dashboard/logs" className="text-blue-400 hover:text-blue-300 underline">Logs</Link>.
      </p>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Provider</label>
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
          >
            <option value="">All</option>
            {uniqueProviders.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Model contains</label>
          <input
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            placeholder="e.g. gpt-4"
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Routed by</label>
          <select
            value={routedByFilter}
            onChange={(e) => setRoutedByFilter(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
          >
            <option value="">All</option>
            {uniqueRoutedBy.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">User ID</label>
          <input
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            placeholder="exact match"
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200"
          />
        </div>
      </div>

      {/* Event stream */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-zinc-600 text-sm">
            {events.length === 0
              ? "Waiting for traffic… submit a request from the playground or your app."
              : "No events match the current filters."}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/60 max-h-[75vh] overflow-y-auto">
            {filtered.map((ev) => {
              const time = new Date(ev.createdAt);
              return (
                <li key={ev.id} className="px-4 py-2.5 hover:bg-zinc-900/80 transition-colors">
                  <Link href={`/dashboard/logs/${ev.id}`} className="block">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-zinc-600 font-mono w-20 shrink-0">
                        {time.toLocaleTimeString("en-US", { hour12: false })}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium border ${PROVIDER_COLORS[ev.provider] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}>
                        {ev.provider}
                      </span>
                      <span className="font-mono text-zinc-300 truncate w-48 shrink-0">
                        {ev.model}
                      </span>
                      {ev.taskType && (
                        <span className="text-zinc-400">{ev.taskType}/{ev.complexity ?? "?"}</span>
                      )}
                      {ev.routedBy && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-blue-900/30 text-blue-300">
                          {ev.routedBy}
                        </span>
                      )}
                      {ev.cached && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-cyan-900/40 text-cyan-300">cached</span>
                      )}
                      {ev.usedFallback && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-300">fallback</span>
                      )}
                      <span className="text-zinc-500 ml-auto shrink-0">
                        {formatLatency(ev.latencyMs)} · {formatTokens(ev.inputTokens)}/{formatTokens(ev.outputTokens)} · {formatCost(ev.cost ?? 0)}
                      </span>
                    </div>
                    {ev.promptPreview && (
                      <div className="mt-1 text-xs text-zinc-500 pl-[92px] truncate">
                        {ev.promptPreview}
                      </div>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
