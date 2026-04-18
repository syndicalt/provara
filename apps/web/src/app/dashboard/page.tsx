"use client";

import { useEffect, useState, useCallback } from "react";
import { formatCost, formatLatency, formatNumber, formatTokens } from "../../lib/format";
import { DataTable, type Column } from "../../components/data-table";
import { Badge } from "../../components/badge";
import { gatewayClientFetch } from "../../lib/gateway-client";

interface Overview {
  totalRequests: number;
  totalCost: number;
  avgLatency: number;
  providerCount: number;
}

interface CostByModel {
  provider: string;
  model: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  avgCost: number;
}

interface RequestRow {
  id: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  cost: number | null;
  taskType: string | null;
  complexity: string | null;
  routedBy: string | null;
  createdAt: string;
}

type StatAccent = "default" | "blue" | "amber" | "purple" | "cyan" | "emerald";

// Full class names (not string-composed) so Tailwind's build-time
// extractor sees every variant. Changing a color here flows to the card
// background gradient, border tint, and label color in one place.
const STAT_ACCENT_BG: Record<StatAccent, string> = {
  default: "bg-zinc-900 border-zinc-800",
  blue: "bg-gradient-to-br from-blue-950/40 via-zinc-900 to-zinc-900 border-blue-900/40",
  amber: "bg-gradient-to-br from-amber-950/40 via-zinc-900 to-zinc-900 border-amber-900/40",
  purple: "bg-gradient-to-br from-purple-950/40 via-zinc-900 to-zinc-900 border-purple-900/40",
  cyan: "bg-gradient-to-br from-cyan-950/40 via-zinc-900 to-zinc-900 border-cyan-900/40",
  emerald: "bg-gradient-to-br from-emerald-950/40 via-zinc-900 to-zinc-900 border-emerald-900/40",
};
const STAT_ACCENT_LABEL: Record<StatAccent, string> = {
  default: "text-zinc-400",
  blue: "text-blue-300",
  amber: "text-amber-300",
  purple: "text-purple-300",
  cyan: "text-cyan-300",
  emerald: "text-emerald-300",
};

function StatCard({
  label,
  value,
  subtitle,
  accent = "default",
}: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: StatAccent;
}) {
  return (
    <div className={`border rounded-lg p-5 ${STAT_ACCENT_BG[accent]}`}>
      <p className={`text-sm mb-1 ${STAT_ACCENT_LABEL[accent]}`}>{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {subtitle && <p className="text-xs text-zinc-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function OnboardingCard() {
  return (
    <section className="bg-gradient-to-br from-blue-950/40 via-zinc-900 to-zinc-900 border border-blue-900/40 rounded-xl p-8">
      <h2 className="text-xl font-semibold mb-2">Welcome to Provara 👋</h2>
      <p className="text-sm text-zinc-400 mb-6 max-w-2xl">
        Your gateway is live. Send traffic through it and this dashboard will start showing routing decisions, costs, and quality scores per cell. Four steps to get going:
      </p>
      <ol className="space-y-4 max-w-2xl">
        <li className="flex gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/40 text-blue-300 text-xs font-semibold flex items-center justify-center">1</span>
          <div className="flex-1">
            <p className="text-sm text-zinc-200 font-medium">Add an API key</p>
            <p className="text-xs text-zinc-500 mb-2">Plug in OpenAI, Anthropic, Groq, DeepSeek, or any OpenAI-compatible provider. Keys are encrypted at rest.</p>
            <a href="/dashboard/api-keys" className="inline-block text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-md transition-colors">Add key →</a>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/40 text-blue-300 text-xs font-semibold flex items-center justify-center">2</span>
          <div className="flex-1">
            <p className="text-sm text-zinc-200 font-medium">Point your SDK at the gateway</p>
            <p className="text-xs text-zinc-500 mb-2">Works with any OpenAI-compatible client — just change the base URL and use your Provara token as the key.</p>
            <pre className="bg-zinc-900/80 border border-zinc-800 rounded-md p-2 text-xs text-zinc-300 overflow-x-auto">
              <code>baseURL: &quot;https://gateway.provara.xyz/v1&quot;</code>
            </pre>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/40 text-blue-300 text-xs font-semibold flex items-center justify-center">3</span>
          <div className="flex-1">
            <p className="text-sm text-zinc-200 font-medium">Watch the pipeline learn</p>
            <p className="text-xs text-zinc-500">Every request gets classified, routed, and optionally scored by the LLM judge. After a few dozen requests, the adaptive router starts picking the best model per cell on its own.</p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/40 text-blue-300 text-xs font-semibold flex items-center justify-center">4</span>
          <div className="flex-1">
            <p className="text-sm text-zinc-200 font-medium">Pick a plan</p>
            <p className="text-xs text-zinc-500 mb-2">Free gets you started. Pro unlocks higher limits and Intelligence features — auto-A/B, silent-regression detection, cost migrations. Team and Enterprise add per-tenant routing isolation.</p>
            <a href="/dashboard/billing" className="inline-block text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-md transition-colors">Manage subscription →</a>
          </div>
        </li>
      </ol>
      <div className="mt-6 pt-5 border-t border-zinc-800 flex flex-wrap gap-4 text-xs text-zinc-500">
        <a href="/dashboard/playground" className="hover:text-zinc-300 transition-colors">Try the Playground →</a>
        <a href="/dashboard/tokens" className="hover:text-zinc-300 transition-colors">Create an API token →</a>
        <a href="https://github.com/syndicalt/provara" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300 transition-colors">Docs &amp; SDK examples →</a>
      </div>
    </section>
  );
}

const costColumns: Column<CostByModel>[] = [
  { key: "provider", label: "Provider", sortable: true, filterable: true },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.model}</span> },
  { key: "requestCount", label: "Requests", sortable: true, align: "right", render: (row) => formatNumber(row.requestCount) },
  { key: "totalInputTokens", label: "Input Tokens", sortable: true, align: "right", render: (row) => formatTokens(row.totalInputTokens) },
  { key: "totalOutputTokens", label: "Output Tokens", sortable: true, align: "right", render: (row) => formatTokens(row.totalOutputTokens) },
  { key: "totalCost", label: "Total Cost", sortable: true, align: "right", render: (row) => formatCost(row.totalCost) },
  { key: "avgCost", label: "Avg Cost", sortable: true, align: "right", render: (row) => formatCost(row.avgCost) },
];

const requestColumns: Column<RequestRow>[] = [
  { key: "provider", label: "Provider", sortable: true, filterable: true },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.model}</span> },
  { key: "taskType", label: "Task Type", sortable: true, filterable: true, render: (row) => row.taskType ? <Badge variant={row.taskType}>{row.taskType}</Badge> : <>—</>, getValue: (row) => row.taskType },
  { key: "complexity", label: "Complexity", sortable: true, filterable: true, render: (row) => row.complexity ? <Badge variant={row.complexity}>{row.complexity}</Badge> : <>—</>, getValue: (row) => row.complexity },
  { key: "routedBy", label: "Routed By", sortable: true, filterable: true, render: (row) => <span className="text-zinc-400 text-xs">{row.routedBy || "—"}</span>, getValue: (row) => row.routedBy },
  { key: "latencyMs", label: "Latency", sortable: true, align: "right", render: (row) => row.latencyMs ? formatLatency(row.latencyMs) : "—" },
  { key: "tokens", label: "Tokens", align: "right", render: (row) => row.inputTokens != null ? <span className="text-xs">{formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens || 0)}</span> : <>—</> },
  { key: "cost", label: "Cost", sortable: true, align: "right", render: (row) => row.cost != null ? formatCost(row.cost) : "—" },
  { key: "createdAt", label: "Time", sortable: true, align: "right", render: (row) => {
    const d = new Date(row.createdAt);
    return <span className="text-xs text-zinc-500">{d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>;
  }},
];

interface CacheSavings {
  tokensSavedInput: number;
  tokensSavedOutput: number;
  tokensSavedTotal: number;
  hits: { exact: number; semantic: number; total: number };
  hitRate: number;
}

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [costsByModel, setCostsByModel] = useState<CostByModel[]>([]);
  const [recentRequests, setRecentRequests] = useState<RequestRow[]>([]);
  const [cacheSavings, setCacheSavings] = useState<CacheSavings | null>(null);
  const [totalRequests, setTotalRequests] = useState(0);
  const [reqPage, setReqPage] = useState(0);
  const [reqPageSize, setReqPageSize] = useState(10);
  const [reqSortKey, setReqSortKey] = useState<string | null>(null);
  const [reqSortDir, setReqSortDir] = useState<"asc" | "desc" | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRequests = useCallback(async (page: number, pageSize: number, sortKey: string | null, sortDir: "asc" | "desc" | null) => {
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
      if (sortKey && sortDir) {
        params.set("orderBy", sortKey);
        params.set("order", sortDir);
      }
      const data = await gatewayClientFetch<{ requests: RequestRow[]; total: number }>(`/v1/analytics/requests?${params}`);
      setRecentRequests(data.requests || []);
      setTotalRequests(data.total || 0);
    } catch (err) {
      console.error("Failed to fetch requests:", err);
    }
  }, []);

  const fetchDashboard = useCallback(async () => {
    try {
      const [overviewData, costsData, savingsData] = await Promise.all([
        gatewayClientFetch<Overview>(`/v1/analytics/overview`),
        gatewayClientFetch<{ costs: CostByModel[] }>(`/v1/analytics/costs/by-model`),
        gatewayClientFetch<CacheSavings>(`/v1/analytics/cache/savings`).catch(() => null),
      ]);
      setOverview(overviewData);
      setCostsByModel(costsData.costs || []);
      setCacheSavings(savingsData);
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    fetchRequests(0, reqPageSize, reqSortKey, reqSortDir);

    // Auto-refresh every 10 seconds
    const interval = setInterval(() => {
      fetchDashboard();
      fetchRequests(reqPage, reqPageSize, reqSortKey, reqSortDir);
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchDashboard, fetchRequests, reqPage, reqPageSize, reqSortKey, reqSortDir]);

  // Also fetch immediately on page/size/sort change
  useEffect(() => {
    fetchRequests(reqPage, reqPageSize, reqSortKey, reqSortDir);
  }, [reqPage, reqPageSize, reqSortKey, reqSortDir, fetchRequests]);

  // Add a subtle live indicator
  const [lastRefresh, setLastRefresh] = useState(new Date());
  useEffect(() => {
    const tick = setInterval(() => setLastRefresh(new Date()), 10_000);
    return () => clearInterval(tick);
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <span className="flex items-center gap-1.5 text-xs text-zinc-600">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Live
        </span>
      </div>

      {(overview?.totalRequests || 0) === 0 ? (
        <OnboardingCard />
      ) : (
        <>
          {/* Overview Stats */}
          <div className="grid grid-cols-5 gap-4">
            <StatCard
              label="Total Requests"
              value={formatNumber(overview?.totalRequests || 0)}
              accent="blue"
            />
            <StatCard
              label="Total Cost"
              value={formatCost(overview?.totalCost || 0)}
              accent="amber"
            />
            <StatCard
              label="Avg Latency"
              value={formatLatency(overview?.avgLatency || 0)}
              accent="purple"
            />
            <StatCard
              label="Active Providers"
              value={String(overview?.providerCount || 0)}
              accent="cyan"
            />
            <StatCard
              label="Tokens Saved"
              value={formatTokens(cacheSavings?.tokensSavedTotal || 0)}
              subtitle={
                cacheSavings
                  ? `${(cacheSavings.hitRate * 100).toFixed(1)}% hit rate · ${cacheSavings.hits.semantic} semantic / ${cacheSavings.hits.exact} exact`
                  : undefined
              }
              accent="emerald"
            />
          </div>

          {/* Cost by Model */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Cost by Model</h2>
            <DataTable
              columns={costColumns}
              data={costsByModel}
              pageSize={10}
              emptyMessage="No data yet. Send some requests through the gateway."
            />
          </section>

          {/* Recent Requests */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Recent Requests</h2>
            <DataTable
              columns={requestColumns}
              data={recentRequests}
              emptyMessage="No requests yet. Send some requests through the gateway."
              serverPagination={{
                total: totalRequests,
                page: reqPage,
                onPageChange: setReqPage,
                pageSize: reqPageSize,
                onPageSizeChange: (size) => { setReqPageSize(size); setReqPage(0); },
              }}
              serverSort={{
                sortKey: reqSortKey,
                sortDir: reqSortDir,
                onSortChange: (key, dir) => {
                  setReqSortKey(key);
                  setReqSortDir(dir);
                  setReqPage(0);
                },
              }}
            />
          </section>
        </>
      )}
    </div>
  );
}
