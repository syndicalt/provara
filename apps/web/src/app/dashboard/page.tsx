"use client";

import { useEffect, useState } from "react";
import { formatCost, formatLatency, formatNumber, formatTokens } from "../../lib/format";

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

function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: string }) {
  const colors: Record<string, string> = {
    default: "bg-zinc-800 text-zinc-300",
    coding: "bg-blue-900/50 text-blue-300",
    creative: "bg-purple-900/50 text-purple-300",
    summarization: "bg-green-900/50 text-green-300",
    qa: "bg-amber-900/50 text-amber-300",
    general: "bg-zinc-800 text-zinc-300",
    simple: "bg-emerald-900/50 text-emerald-300",
    medium: "bg-yellow-900/50 text-yellow-300",
    complex: "bg-red-900/50 text-red-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[variant] || colors.default}`}>
      {children}
    </span>
  );
}

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [costsByModel, setCostsByModel] = useState<CostByModel[]>([]);
  const [recentRequests, setRecentRequests] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [overviewRes, costsRes, requestsRes] = await Promise.all([
          fetch(`${GATEWAY}/v1/analytics/overview`),
          fetch(`${GATEWAY}/v1/analytics/costs/by-model`),
          fetch(`${GATEWAY}/v1/analytics/requests?limit=25`),
        ]);
        const overviewData = await overviewRes.json();
        const costsData = await costsRes.json();
        const requestsData = await requestsRes.json();
        setOverview(overviewData);
        setCostsByModel(costsData.costs || []);
        setRecentRequests(requestsData.requests || []);
      } catch (err) {
        console.error("Failed to fetch dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
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
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3 text-right">Requests</th>
                <th className="px-4 py-3 text-right">Input Tokens</th>
                <th className="px-4 py-3 text-right">Output Tokens</th>
                <th className="px-4 py-3 text-right">Total Cost</th>
                <th className="px-4 py-3 text-right">Avg Cost</th>
              </tr>
            </thead>
            <tbody>
              {costsByModel.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                    No data yet. Send some requests through the gateway.
                  </td>
                </tr>
              ) : (
                costsByModel.map((row) => (
                  <tr key={`${row.provider}-${row.model}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-4 py-3">{row.provider}</td>
                    <td className="px-4 py-3 font-mono text-xs">{row.model}</td>
                    <td className="px-4 py-3 text-right">{formatNumber(row.requestCount)}</td>
                    <td className="px-4 py-3 text-right">{formatTokens(row.totalInputTokens)}</td>
                    <td className="px-4 py-3 text-right">{formatTokens(row.totalOutputTokens)}</td>
                    <td className="px-4 py-3 text-right">{formatCost(row.totalCost)}</td>
                    <td className="px-4 py-3 text-right">{formatCost(row.avgCost)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent Requests */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Recent Requests</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Task Type</th>
                <th className="px-4 py-3">Complexity</th>
                <th className="px-4 py-3">Routed By</th>
                <th className="px-4 py-3 text-right">Latency</th>
                <th className="px-4 py-3 text-right">Tokens</th>
                <th className="px-4 py-3 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {recentRequests.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                    No requests yet. Send some requests through the gateway.
                  </td>
                </tr>
              ) : (
                recentRequests.map((req) => (
                  <tr key={req.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-4 py-3">{req.provider}</td>
                    <td className="px-4 py-3 font-mono text-xs">{req.model}</td>
                    <td className="px-4 py-3">
                      {req.taskType && <Badge variant={req.taskType}>{req.taskType}</Badge>}
                    </td>
                    <td className="px-4 py-3">
                      {req.complexity && <Badge variant={req.complexity}>{req.complexity}</Badge>}
                    </td>
                    <td className="px-4 py-3 text-zinc-400 text-xs">{req.routedBy || "—"}</td>
                    <td className="px-4 py-3 text-right">{req.latencyMs ? formatLatency(req.latencyMs) : "—"}</td>
                    <td className="px-4 py-3 text-right text-xs">
                      {req.inputTokens != null ? `${formatTokens(req.inputTokens)} / ${formatTokens(req.outputTokens || 0)}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">{req.cost != null ? formatCost(req.cost) : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
