"use client";

import { useEffect, useState, useCallback } from "react";
import { formatCost, formatLatency, formatNumber, formatTokens } from "../../lib/format";
import { DataTable, type Column } from "../../components/data-table";
import { Badge } from "../../components/badge";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

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
      const res = await fetch(`${GATEWAY}/v1/analytics/requests?limit=${pageSize}&offset=${page * pageSize}`);
      const data = await res.json();
      setRecentRequests(data.requests || []);
      setTotalRequests(data.total || 0);
    } catch (err) {
      console.error("Failed to fetch requests:", err);
    }
  }, []);

  useEffect(() => {
    async function fetchData() {
      try {
        const [overviewRes, costsRes] = await Promise.all([
          fetch(`${GATEWAY}/v1/analytics/overview`),
          fetch(`${GATEWAY}/v1/analytics/costs/by-model`),
        ]);
        const overviewData = await overviewRes.json();
        const costsData = await costsRes.json();
        setOverview(overviewData);
        setCostsByModel(costsData.costs || []);
      } catch (err) {
        console.error("Failed to fetch dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    fetchRequests(0, reqPageSize);
  }, [fetchRequests, reqPageSize]);

  useEffect(() => {
    fetchRequests(reqPage, reqPageSize);
  }, [reqPage, reqPageSize, fetchRequests]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <h1 className="text-2xl font-bold">Dashboard</h1>

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
    </div>
  );
}
