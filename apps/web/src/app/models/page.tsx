"use client";

import { useEffect, useState, useMemo } from "react";
import { PublicNav } from "../../components/public-nav";
import { gatewayClientFetch } from "../../lib/gateway-client";

interface ModelInfo {
  provider: string;
  model: string;
  pricing: { inputPer1M: number; outputPer1M: number } | null;
  stats: {
    requestCount: number;
    avgLatency: number;
    avgInputTokens: number;
    avgOutputTokens: number;
  };
  totalCost: number;
  quality: { avgScore: number; feedbackCount: number } | null;
}

function formatPrice(price: number): string {
  if (price === 0) return "Free";
  if (price < 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function formatLatency(ms: number): string {
  if (ms === 0) return "--";
  return `${ms}ms`;
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

type SortKey = "model" | "provider" | "inputPrice" | "outputPrice" | "latency" | "requests";

export default function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("requests");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    gatewayClientFetch<{ models: ModelInfo[] }>("/v1/models/stats")
      .then((data) => setModels(data.models || []))
      .catch((err) => console.error("Failed to fetch models:", err))
      .finally(() => setLoading(false));
  }, []);

  const providers = useMemo(
    () => [...new Set(models.map((m) => m.provider))].sort(),
    [models]
  );

  const filtered = useMemo(() => {
    let result = models;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (m) => m.model.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)
      );
    }

    if (providerFilter) {
      result = result.filter((m) => m.provider === providerFilter);
    }

    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "model":
          cmp = a.model.localeCompare(b.model);
          break;
        case "provider":
          cmp = a.provider.localeCompare(b.provider);
          break;
        case "inputPrice":
          cmp = (a.pricing?.inputPer1M || 0) - (b.pricing?.inputPer1M || 0);
          break;
        case "outputPrice":
          cmp = (a.pricing?.outputPer1M || 0) - (b.pricing?.outputPer1M || 0);
          break;
        case "latency":
          cmp = a.stats.avgLatency - b.stats.avgLatency;
          break;
        case "requests":
          cmp = a.stats.requestCount - b.stats.requestCount;
          break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });

    return result;
  }, [models, search, providerFilter, sortBy, sortDir]);

  function handleSort(key: SortKey) {
    if (sortBy === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortBy(key);
      setSortDir(key === "model" || key === "provider" ? "asc" : "desc");
    }
  }

  function SortHeader({ label, sortKey }: { label: string; sortKey: SortKey }) {
    const active = sortBy === sortKey;
    return (
      <button
        onClick={() => handleSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-zinc-200 transition-colors ${active ? "text-zinc-200" : ""}`}
      >
        {label}
        {active && <span className="text-blue-400">{sortDir === "asc" ? "\u25B2" : "\u25BC"}</span>}
      </button>
    );
  }

  return (
    <>
      <PublicNav />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Models</h1>
          <p className="text-zinc-400">
            Browse all available models across providers. Pricing, latency, and usage stats.
          </p>
        </div>

        {/* Filters */}
        <div className="flex gap-4 mb-6">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
          />
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-zinc-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">All Providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="text-zinc-400 py-8">Loading models...</p>
        ) : filtered.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
            <p className="text-zinc-400">No models found.</p>
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-3"><SortHeader label="Model" sortKey="model" /></th>
                  <th className="px-4 py-3"><SortHeader label="Provider" sortKey="provider" /></th>
                  <th className="px-4 py-3 text-right"><SortHeader label="Input / 1M" sortKey="inputPrice" /></th>
                  <th className="px-4 py-3 text-right"><SortHeader label="Output / 1M" sortKey="outputPrice" /></th>
                  <th className="px-4 py-3 text-right"><SortHeader label="Avg Latency" sortKey="latency" /></th>
                  <th className="px-4 py-3 text-right"><SortHeader label="Requests" sortKey="requests" /></th>
                  <th className="px-4 py-3 text-right">Quality</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr
                    key={`${m.provider}/${m.model}`}
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-zinc-200">{m.model}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium border ${
                          PROVIDER_COLORS[m.provider] || "bg-zinc-800 text-zinc-300 border-zinc-700"
                        }`}
                      >
                        {m.provider}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400">
                      {m.pricing ? formatPrice(m.pricing.inputPer1M) : "--"}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400">
                      {m.pricing ? formatPrice(m.pricing.outputPer1M) : "--"}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400">
                      {formatLatency(m.stats.avgLatency)}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400">
                      {m.stats.requestCount > 0 ? m.stats.requestCount.toLocaleString() : "--"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {m.quality ? (
                        <span
                          className={`font-medium ${
                            m.quality.avgScore >= 4
                              ? "text-emerald-400"
                              : m.quality.avgScore >= 3
                              ? "text-yellow-400"
                              : "text-red-400"
                          }`}
                        >
                          {m.quality.avgScore.toFixed(1)}/5
                        </span>
                      ) : (
                        <span className="text-zinc-600">--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-zinc-600 mt-4">
          {filtered.length} model{filtered.length !== 1 ? "s" : ""} across {[...new Set(filtered.map((m) => m.provider))].length} provider{[...new Set(filtered.map((m) => m.provider))].length !== 1 ? "s" : ""}
          {providerFilter ? ` (filtered: ${providerFilter})` : ""}
        </p>
      </div>
    </>
  );
}
