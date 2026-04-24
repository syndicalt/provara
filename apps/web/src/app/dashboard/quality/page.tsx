"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { formatNumber } from "../../../lib/format";
import { DataTable, type Column } from "../../../components/data-table";
import { AdaptiveHeatmap, type AdaptiveCell } from "../../../components/adaptive-heatmap";
import { RegressionPanel } from "../../../components/regression-panel";
import { useAdaptiveScoreBuffer } from "../../../hooks/use-adaptive-score-buffer";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";

interface QualityByModel {
  provider: string;
  model: string;
  avgScore: number;
  count: number;
  userCount: number;
  judgeCount: number;
}

interface FeedbackEntry {
  id: string;
  requestId: string;
  tenantId: string | null;
  score: number;
  comment: string | null;
  source: string;
  createdAt: string;
  model: string | null;
  provider: string | null;
  taskType: string | null;
  complexity: string | null;
}

interface TrendPoint {
  bucket: string;
  avgScore: number;
  count: number;
  userCount: number;
  judgeCount: number;
}

interface JudgeConfig {
  sampleRate: number;
  enabled: boolean;
  provider: string | null;
  model: string | null;
}

interface ProviderInfo {
  name: string;
  models: string[];
}

const RANGES = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

function ScoreBar({ score, max = 5 }: { score: number; max?: number }) {
  const pct = (score / max) * 100;
  const color =
    score >= 4 ? "bg-emerald-500" : score >= 3 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
        <div className={`${color} h-full rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-medium w-8 text-right">{score.toFixed(1)}</span>
    </div>
  );
}

function formatBucket(bucket: string): string {
  if (bucket.includes(" ")) return bucket.split(" ")[1];
  const d = new Date(bucket + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-xl text-xs">
      <p className="text-zinc-400 mb-1.5">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-zinc-400">{entry.name}:</span>
          <span className="text-zinc-200 font-medium">{typeof entry.value === "number" ? entry.value.toFixed(2) : entry.value}</span>
        </div>
      ))}
    </div>
  );
}

const qualityColumns: Column<QualityByModel>[] = [
  { key: "provider", label: "Provider", sortable: true, filterable: true },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.model}</span> },
  { key: "avgScore", label: "Avg Score", sortable: true, render: (row) => <div className="w-48"><ScoreBar score={row.avgScore} /></div> },
  { key: "count", label: "Total", sortable: true, align: "right", render: (row) => formatNumber(row.count) },
  { key: "userCount", label: "User", sortable: true, align: "right", render: (row) => formatNumber(row.userCount) },
  { key: "judgeCount", label: "Judge", sortable: true, align: "right", render: (row) => formatNumber(row.judgeCount) },
];

const feedbackColumns: Column<FeedbackEntry>[] = [
  {
    key: "createdAt", label: "Time", sortable: true,
    render: (row) => (
      <span className="text-xs text-zinc-400 whitespace-nowrap" title={new Date(row.createdAt).toLocaleString()}>
        {formatTimestamp(row.createdAt)}
      </span>
    ),
  },
  {
    key: "source", label: "Source", sortable: true, filterable: true,
    render: (row) => (
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${row.source === "judge" ? "bg-purple-900/50 text-purple-300" : "bg-blue-900/50 text-blue-300"}`}>
        {row.source}
      </span>
    ),
  },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.provider}/{row.model}</span> },
  { key: "taskType", label: "Task", sortable: true, filterable: true, render: (row) => <span className="text-xs text-zinc-400">{row.taskType ? `${row.taskType}/${row.complexity}` : "—"}</span>, getValue: (row) => row.taskType },
  {
    key: "score", label: "Score", sortable: true,
    render: (row) => (
      <span className={`font-medium ${row.score >= 4 ? "text-emerald-400" : row.score >= 3 ? "text-yellow-400" : "text-red-400"}`}>
        {row.score}/5
      </span>
    ),
  },
  { key: "comment", label: "Comment", render: (row) => <span className="text-xs text-zinc-400 max-w-xs truncate block">{row.comment || "—"}</span> },
];

export default function QualityPage() {
  const [byModel, setByModel] = useState<QualityByModel[]>([]);
  const [adaptiveCells, setAdaptiveCells] = useState<AdaptiveCell[]>([]);
  const [recentFeedback, setRecentFeedback] = useState<FeedbackEntry[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [trendRange, setTrendRange] = useState("7d");
  const [judgeConfig, setJudgeConfigState] = useState<JudgeConfig | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);
  const [loading, setLoading] = useState(true);
  const { getSparkline, pulsedKeys } = useAdaptiveScoreBuffer(adaptiveCells);

  const fetchTrend = useCallback(async () => {
    try {
      const res = await gatewayFetchRaw(`/v1/feedback/quality/trend?range=${trendRange}`);
      const data = await res.json();
      setTrend(data.series || []);
    } catch {}
  }, [trendRange]);

  useEffect(() => {
    async function fetchData() {
      try {
        const [modelRes, adaptiveRes, feedbackRes, configRes, providersRes] = await Promise.all([
          gatewayFetchRaw("/v1/feedback/quality/by-model"),
          gatewayFetchRaw("/v1/analytics/adaptive/scores"),
          gatewayFetchRaw("/v1/feedback?limit=20"),
          gatewayFetchRaw("/v1/feedback/judge/config"),
          gatewayFetchRaw("/v1/providers"),
        ]);
        const modelData = await modelRes.json();
        const adaptiveData = await adaptiveRes.json();
        const feedbackData = await feedbackRes.json();
        const configData = await configRes.json();
        const providersData = await providersRes.json();
        setByModel(modelData.quality || []);
        setAdaptiveCells(adaptiveData.cells || []);
        setRecentFeedback(feedbackData.feedback || []);
        setJudgeConfigState(configData);
        setProviders(providersData.providers || []);
      } catch (err) {
        console.error("Failed to fetch quality data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  useEffect(() => {
    fetchTrend();
  }, [fetchTrend]);

  useEffect(() => {
    let cancelled = false;
    async function pollAdaptive() {
      try {
        const res = await gatewayFetchRaw("/v1/analytics/adaptive/scores");
        const data = await res.json();
        if (!cancelled) setAdaptiveCells(data.cells || []);
      } catch {}
    }
    const id = setInterval(pollAdaptive, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleSaveConfig() {
    if (!judgeConfig) return;
    setSavingConfig(true);
    try {
      const res = await gatewayFetchRaw("/v1/feedback/judge/config", {
        method: "PUT",
        body: JSON.stringify(judgeConfig),
      });
      const data = await res.json();
      setJudgeConfigState(data);
    } catch {}
    setSavingConfig(false);
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading quality data...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <h1 className="text-2xl font-bold">Quality Analytics</h1>

      {/* Quality Trend Chart */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-300">Quality Score Trend</h2>
          <div className="flex gap-1 bg-zinc-800 rounded-md p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setTrendRange(r.value)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  trendRange === r.value ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {trend.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trend.map((t) => ({ ...t, bucket: formatBucket(t.bucket) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#71717a" }} />
              <YAxis domain={[0, 5]} tick={{ fontSize: 11, fill: "#71717a" }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="avgScore" name="Avg Score" stroke="#34d399" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-zinc-500 py-8 text-center">No feedback data in this time range.</p>
        )}
      </section>

      {/* Judge Configuration */}
      {judgeConfig && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">LLM Judge Configuration</h2>
          <p className="text-xs text-zinc-500 mb-4">
            The judge automatically scores a sample of responses. Pin a specific model below, or let it pick the cheapest available.
          </p>
          <div className="flex items-end gap-6">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Status</label>
              <button
                onClick={() => setJudgeConfigState({ ...judgeConfig, enabled: !judgeConfig.enabled })}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  judgeConfig.enabled
                    ? "bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/50"
                    : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
                }`}
              >
                {judgeConfig.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <div className="flex-1 max-w-xs">
              <label className="block text-xs text-zinc-400 mb-1">
                Sample Rate: {Math.round(judgeConfig.sampleRate * 100)}%
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(judgeConfig.sampleRate * 100)}
                onChange={(e) => setJudgeConfigState({ ...judgeConfig, sampleRate: parseInt(e.target.value) / 100 })}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-xs text-zinc-600 mt-1">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>
            <div className="flex-1 max-w-xs">
              <label className="block text-xs text-zinc-400 mb-1">Judge Model</label>
              <select
                value={judgeConfig.provider && judgeConfig.model ? `${judgeConfig.provider}:${judgeConfig.model}` : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    setJudgeConfigState({ ...judgeConfig, provider: null, model: null });
                  } else {
                    const [provider, ...rest] = v.split(":");
                    setJudgeConfigState({ ...judgeConfig, provider, model: rest.join(":") });
                  }
                }}
                className="w-full bg-zinc-800 border border-zinc-700 rounded text-xs px-2 py-1.5 text-zinc-200"
              >
                <option value="">Auto (cheapest)</option>
                {providers.flatMap((p) =>
                  p.models.map((m) => (
                    <option key={`${p.name}:${m}`} value={`${p.name}:${m}`}>
                      {p.name} / {m}
                    </option>
                  ))
                )}
              </select>
            </div>
            <button
              onClick={handleSaveConfig}
              disabled={savingConfig}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-medium transition-colors"
            >
              {savingConfig ? "Saving..." : "Save"}
            </button>
          </div>
        </section>
      )}

      {/* Adaptive Routing Heatmap */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Adaptive Routing</h2>
        <p className="text-sm text-zinc-400 mb-3">
          Live quality EMA per routing cell. Each strip is a candidate model — color shows score, opacity shows sample confidence, dashed outlines mark models still below the adaptive-routing threshold.
        </p>
        <AdaptiveHeatmap cells={adaptiveCells} pulsedKeys={pulsedKeys} getSparkline={getSparkline} />
      </section>

      {/* Silent-regression detection */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Regression Watch</h2>
        <RegressionPanel />
      </section>

      {/* Quality by Model */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Quality by Model</h2>
        <DataTable
          columns={qualityColumns}
          data={byModel}
          pageSize={10}
          emptyMessage="No quality data yet. Submit feedback via POST /v1/feedback or enable the LLM judge."
        />
      </section>

      {/* Recent Feedback */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Recent Feedback</h2>
        <DataTable
          columns={feedbackColumns}
          data={recentFeedback}
          pageSize={10}
          emptyMessage="No feedback yet."
        />
      </section>
    </div>
  );
}
