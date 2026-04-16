"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { gatewayClientFetch } from "../../../lib/gateway-client";

interface RequestRow {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  cost: number | null;
  taskType: string | null;
  complexity: string | null;
  routedBy: string | null;
  createdAt: string;
}

interface RequestsResponse {
  requests: RequestRow[];
  total: number;
  limit: number;
  offset: number;
}

function formatCost(cost: number | null): string {
  if (cost === null || cost === 0) return "--";
  if (cost < 0.001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(4)}`;
}

function formatLatency(ms: number | null): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function truncatePrompt(prompt: string): string {
  try {
    const messages = JSON.parse(prompt);
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1];
      const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      return content.length > 120 ? content.slice(0, 120) + "..." : content;
    }
  } catch {
    // not JSON, use raw
  }
  return prompt.length > 120 ? prompt.slice(0, 120) + "..." : prompt;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50",
  anthropic: "bg-orange-900/40 text-orange-300 border-orange-800/50",
  google: "bg-blue-900/40 text-blue-300 border-blue-800/50",
  mistral: "bg-purple-900/40 text-purple-300 border-purple-800/50",
  xai: "bg-cyan-900/40 text-cyan-300 border-cyan-800/50",
  zai: "bg-pink-900/40 text-pink-300 border-pink-800/50",
  ollama: "bg-zinc-800 text-zinc-300 border-zinc-700",
};

const PAGE_SIZE = 25;

export default function LogsPage() {
  const [data, setData] = useState<RequestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (providerFilter) params.set("provider", providerFilter);
      if (modelFilter) params.set("model", modelFilter);

      const result = await gatewayClientFetch<RequestsResponse>(
        `/v1/analytics/requests?${params}`
      );
      setData(result);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    } finally {
      setLoading(false);
    }
  }, [page, providerFilter, modelFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Client-side search filter on top of API results
  const filtered = data?.requests.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.model.toLowerCase().includes(q) ||
      r.provider.toLowerCase().includes(q) ||
      (r.prompt && r.prompt.toLowerCase().includes(q)) ||
      (r.taskType && r.taskType.toLowerCase().includes(q))
    );
  }) || [];

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  // Extract unique providers and models from current data for filter dropdowns
  const providers = data ? [...new Set(data.requests.map((r) => r.provider))].sort() : [];
  const models = data ? [...new Set(data.requests.map((r) => r.model))].sort() : [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Request Logs</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Browse all requests routed through the gateway.
          {data && <span className="text-zinc-500"> {data.total.toLocaleString()} total requests.</span>}
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search prompts, models..."
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
        />
        <select
          value={providerFilter}
          onChange={(e) => { setProviderFilter(e.target.value); setPage(0); }}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-blue-500"
        >
          <option value="">All Providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={modelFilter}
          onChange={(e) => { setModelFilter(e.target.value); setPage(0); }}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-blue-500"
        >
          <option value="">All Models</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading && !data ? (
        <p className="text-zinc-400 py-8">Loading logs...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
          <p className="text-zinc-400">No requests found.</p>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="px-4 py-3">Prompt</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Routing</th>
                <th className="px-4 py-3 text-right">Tokens</th>
                <th className="px-4 py-3 text-right">Latency</th>
                <th className="px-4 py-3 text-right">Cost</th>
                <th className="px-4 py-3 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
                >
                  <td className="px-4 py-3 max-w-xs">
                    <Link
                      href={`/dashboard/logs/${r.id}`}
                      className="text-zinc-300 hover:text-blue-400 transition-colors block truncate"
                    >
                      {truncatePrompt(r.prompt)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-xs font-medium border ${
                          PROVIDER_COLORS[r.provider] || "bg-zinc-800 text-zinc-300 border-zinc-700"
                        }`}
                      >
                        {r.provider}
                      </span>
                      <span className="font-mono text-xs text-zinc-400">{r.model}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {r.taskType && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                          {r.taskType}
                        </span>
                      )}
                      {r.complexity && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700/50">
                          {r.complexity}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-500 text-xs font-mono">
                    {r.inputTokens || 0} / {r.outputTokens || 0}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-400 text-xs">
                    {formatLatency(r.latencyMs)}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-400 text-xs">
                    {formatCost(r.cost)}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-500 text-xs">
                    {formatTimestamp(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500">
            Page {page + 1} of {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 rounded text-xs text-zinc-300 transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 rounded text-xs text-zinc-300 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
