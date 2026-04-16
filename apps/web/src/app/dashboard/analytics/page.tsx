"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { gatewayClientFetch } from "../../../lib/gateway-client";
import { formatCost, formatNumber, formatLatency } from "../../../lib/format";

// ---- Types ----

interface TimeseriesPoint {
  bucket: string;
  requestCount: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  totalCost: number;
}

interface CostByProviderPoint {
  bucket: string;
  provider: string;
  totalCost: number;
  requestCount: number;
}

interface ModelComparison {
  provider: string;
  model: string;
  requestCount: number;
  avgLatency: number;
  totalCost: number;
  avgScore: number | null;
  feedbackCount: number;
}

interface OverviewStats {
  totalRequests: number;
  totalCost: number;
  avgLatency: number;
  providerCount: number;
}

// ---- Helpers ----

const RANGES = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#34d399",
  anthropic: "#fb923c",
  google: "#60a5fa",
  mistral: "#a78bfa",
  xai: "#22d3ee",
  zai: "#f472b6",
  ollama: "#a1a1aa",
};

function getProviderColor(provider: string): string {
  return PROVIDER_COLORS[provider] || "#71717a";
}

function formatBucket(bucket: string): string {
  if (bucket.includes(" ")) {
    // Hourly: "2026-04-15 14:00" -> "14:00"
    return bucket.split(" ")[1];
  }
  // Daily: "2026-04-15" -> "Apr 15"
  const d = new Date(bucket + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const BADGE_COLORS: Record<string, string> = {
  openai: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50",
  anthropic: "bg-orange-900/40 text-orange-300 border-orange-800/50",
  google: "bg-blue-900/40 text-blue-300 border-blue-800/50",
  mistral: "bg-purple-900/40 text-purple-300 border-purple-800/50",
  xai: "bg-cyan-900/40 text-cyan-300 border-cyan-800/50",
  zai: "bg-pink-900/40 text-pink-300 border-pink-800/50",
  ollama: "bg-zinc-800 text-zinc-300 border-zinc-700",
};

// ---- Custom tooltip ----

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-xl text-xs">
      <p className="text-zinc-400 mb-1.5">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-zinc-400">{entry.name}:</span>
          <span className="text-zinc-200 font-medium">{typeof entry.value === "number" && entry.name.toLowerCase().includes("cost") ? `$${entry.value.toFixed(4)}` : entry.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Page ----

export default function AnalyticsPage() {
  const [range, setRange] = useState("7d");
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [costByProvider, setCostByProvider] = useState<CostByProviderPoint[]>([]);
  const [models, setModels] = useState<ModelComparison[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [overviewData, tsData, costData, modelsData] = await Promise.all([
        gatewayClientFetch<OverviewStats>("/v1/analytics/overview"),
        gatewayClientFetch<{ series: TimeseriesPoint[] }>(`/v1/analytics/timeseries?range=${range}`),
        gatewayClientFetch<{ series: CostByProviderPoint[] }>(`/v1/analytics/timeseries/cost-by-provider?range=${range}`),
        gatewayClientFetch<{ models: ModelComparison[] }>(`/v1/analytics/models/compare?range=${range}`),
      ]);
      setOverview(overviewData);
      setTimeseries(tsData.series);
      setCostByProvider(costData.series);
      setModels(modelsData.models);
    } catch (err) {
      console.error("Failed to fetch analytics:", err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Pivot cost-by-provider into stacked chart data
  const providers = [...new Set(costByProvider.map((r) => r.provider))];
  const costPivot = (() => {
    const bucketMap = new Map<string, Record<string, string | number>>();
    for (const row of costByProvider) {
      const entry = bucketMap.get(row.bucket) || { bucket: row.bucket };
      entry[row.provider] = ((entry[row.provider] as number) || 0) + row.totalCost;
      bucketMap.set(row.bucket, entry);
    }
    return [...bucketMap.values()];
  })();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-sm text-zinc-400 mt-1">Request volume, costs, and latency over time.</p>
        </div>
        <div className="flex gap-1 bg-zinc-800 rounded-md p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                range === r.value ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      {overview && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <p className="text-xs text-zinc-500">Total Requests</p>
            <p className="text-2xl font-bold mt-1">{formatNumber(overview.totalRequests)}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <p className="text-xs text-zinc-500">Total Cost</p>
            <p className="text-2xl font-bold mt-1">{formatCost(overview.totalCost)}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <p className="text-xs text-zinc-500">Avg Latency</p>
            <p className="text-2xl font-bold mt-1">{formatLatency(overview.avgLatency)}</p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <p className="text-xs text-zinc-500">Providers Used</p>
            <p className="text-2xl font-bold mt-1">{overview.providerCount}</p>
          </div>
        </div>
      )}

      {loading && !overview ? (
        <p className="text-zinc-400 py-8">Loading analytics...</p>
      ) : (
        <>
          {/* Request volume + cost chart */}
          <div className="grid grid-cols-2 gap-6">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
              <h2 className="text-sm font-semibold text-zinc-300 mb-4">Request Volume</h2>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={timeseries.map((t) => ({ ...t, bucket: formatBucket(t.bucket) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: "#71717a" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#71717a" }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="requestCount" name="Requests" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
              <h2 className="text-sm font-semibold text-zinc-300 mb-4">Cost Over Time</h2>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={costPivot.map((c) => ({ ...c, bucket: formatBucket(String(c.bucket)) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: "#71717a" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#71717a" }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip content={<ChartTooltip />} cursor={false} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {providers.map((p) => (
                    <Bar key={p} dataKey={p} name={p} stackId="cost" fill={getProviderColor(p)} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Latency percentiles */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <h2 className="text-sm font-semibold text-zinc-300 mb-4">Latency Percentiles</h2>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={timeseries.map((t) => ({ ...t, bucket: formatBucket(t.bucket) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: "#71717a" }} />
                <YAxis tick={{ fontSize: 10, fill: "#71717a" }} tickFormatter={(v) => `${v}ms`} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="p50Latency" name="p50" stroke="#34d399" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="p95Latency" name="p95" stroke="#fbbf24" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="p99Latency" name="p99" stroke="#f87171" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Model comparison */}
          {models.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-300">Model Comparison</h2>
                <p className="text-xs text-zinc-500 mt-1">Performance across models for the selected time range.</p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                    <th className="px-6 py-3">Model</th>
                    <th className="px-6 py-3 text-right">Requests</th>
                    <th className="px-6 py-3 text-right">Avg Latency</th>
                    <th className="px-6 py-3 text-right">Total Cost</th>
                    <th className="px-6 py-3 text-right">Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {models
                    .sort((a, b) => b.requestCount - a.requestCount)
                    .map((m) => (
                      <tr key={`${m.provider}/${m.model}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${BADGE_COLORS[m.provider] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}>
                              {m.provider}
                            </span>
                            <span className="font-mono text-xs text-zinc-300">{m.model}</span>
                          </div>
                        </td>
                        <td className="px-6 py-3 text-right text-zinc-300">{m.requestCount.toLocaleString()}</td>
                        <td className="px-6 py-3 text-right text-zinc-400">{m.avgLatency}ms</td>
                        <td className="px-6 py-3 text-right text-zinc-400">{formatCost(m.totalCost)}</td>
                        <td className="px-6 py-3 text-right">
                          {m.avgScore !== null ? (
                            <span className={`font-medium ${m.avgScore >= 4 ? "text-emerald-400" : m.avgScore >= 3 ? "text-yellow-400" : "text-red-400"}`}>
                              {m.avgScore.toFixed(1)}/5
                              <span className="text-zinc-600 ml-1">({m.feedbackCount})</span>
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
        </>
      )}
    </div>
  );
}
