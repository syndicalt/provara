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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <p className="text-sm text-zinc-400 mb-1">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function OnboardingCard() {
  return (
    <section className="bg-gradient-to-br from-blue-950/40 via-zinc-900 to-zinc-900 border border-blue-900/40 rounded-xl p-8">
      <h2 className="text-xl font-semibold mb-2">Welcome to Provara 👋</h2>
      <p className="text-sm text-zinc-400 mb-6 max-w-2xl">
        Your gateway is live. Send traffic through it and this dashboard will start showing routing decisions, costs, and quality scores per cell. Three steps to get going:
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

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [costsByModel, setCostsByModel] = useState<CostByModel[]>([]);
  const [recentRequests, setRecentRequests] = useState<RequestRow[]>([]);
  const [totalRequests, setTotalRequests] = useState(0);
  const [reqPage, setReqPage] = useState(0);
  const [reqPageSize, setReqPageSize] = useState(10);
  const [loading, setLoading] = useState(true);

  const fetchRequests = useCallback(async (page: number, pageSize: number) => {
    try {
      const data = await gatewayClientFetch<{ requests: RequestRow[]; total: number }>(`/v1/analytics/requests?limit=${pageSize}&offset=${page * pageSize}`);
      setRecentRequests(data.requests || []);
      setTotalRequests(data.total || 0);
    } catch (err) {
      console.error("Failed to fetch requests:", err);
    }
  }, []);

  const fetchDashboard = useCallback(async () => {
    try {
      const [overviewData, costsData] = await Promise.all([
        gatewayClientFetch<Overview>(`/v1/analytics/overview`),
        gatewayClientFetch<{ costs: CostByModel[] }>(`/v1/analytics/costs/by-model`),
      ]);
      setOverview(overviewData);
      setCostsByModel(costsData.costs || []);
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    fetchRequests(0, reqPageSize);

    // Auto-refresh every 10 seconds
    const interval = setInterval(() => {
      fetchDashboard();
      fetchRequests(reqPage, reqPageSize);
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchDashboard, fetchRequests, reqPage, reqPageSize]);

  // Also fetch immediately on page/size change
  useEffect(() => {
    fetchRequests(reqPage, reqPageSize);
  }, [reqPage, reqPageSize, fetchRequests]);

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
          <div className="grid grid-cols-4 gap-4">
            <StatCard label="Total Requests" value={formatNumber(overview?.totalRequests || 0)} />
            <StatCard label="Total Cost" value={formatCost(overview?.totalCost || 0)} />
            <StatCard label="Avg Latency" value={formatLatency(overview?.avgLatency || 0)} />
            <StatCard label="Active Providers" value={String(overview?.providerCount || 0)} />
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
            />
          </section>
        </>
      )}
    </div>
  );
}
