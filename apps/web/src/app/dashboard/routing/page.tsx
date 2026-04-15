"use client";

import { useEffect, useState } from "react";
import { formatLatency, formatNumber } from "../../../lib/format";
import { DataTable, type Column } from "../../../components/data-table";
import { Badge } from "../../../components/badge";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

interface RoutingStat {
  taskType: string | null;
  complexity: string | null;
  routedBy: string | null;
  provider: string;
  model: string;
  count: number;
  avgLatency: number;
}

interface Distribution {
  byTaskType: { taskType: string | null; count: number }[];
  byComplexity: { complexity: string | null; count: number }[];
}

const TASK_TYPES = ["coding", "creative", "summarization", "qa", "general"];
const COMPLEXITIES = ["simple", "medium", "complex"];

function BarChart({ data, labelKey, valueKey }: { data: Record<string, unknown>[]; labelKey: string; valueKey: string }) {
  const maxValue = Math.max(...data.map((d) => (d[valueKey] as number) || 0), 1);
  return (
    <div className="space-y-2">
      {data.map((d, i) => {
        const label = (d[labelKey] as string) || "unknown";
        const value = (d[valueKey] as number) || 0;
        const pct = (value / maxValue) * 100;
        return (
          <div key={i} className="flex items-center gap-3">
            <span className="text-sm text-zinc-400 w-28 text-right">{label}</span>
            <div className="flex-1 bg-zinc-800 rounded-full h-6 overflow-hidden">
              <div
                className="bg-blue-600 h-full rounded-full flex items-center justify-end pr-2"
                style={{ width: `${Math.max(pct, 8)}%` }}
              >
                <span className="text-xs font-medium">{formatNumber(value)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RoutingMatrix({ stats }: { stats: RoutingStat[] }) {
  // Build a matrix view: taskType × complexity → top model
  const cells: Record<string, Record<string, { model: string; provider: string; count: number }>> = {};

  for (const stat of stats) {
    const tt = stat.taskType || "unknown";
    const cx = stat.complexity || "unknown";
    if (!cells[tt]) cells[tt] = {};
    if (!cells[tt][cx] || stat.count > cells[tt][cx].count) {
      cells[tt][cx] = { model: stat.model, provider: stat.provider, count: stat.count };
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-400 text-left">
            <th className="px-4 py-3">Task Type</th>
            {COMPLEXITIES.map((c) => (
              <th key={c} className="px-4 py-3 text-center capitalize">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TASK_TYPES.map((tt) => (
            <tr key={tt} className="border-b border-zinc-800/50">
              <td className="px-4 py-3 capitalize font-medium">{tt}</td>
              {COMPLEXITIES.map((cx) => {
                const cell = cells[tt]?.[cx];
                return (
                  <td key={cx} className="px-4 py-3 text-center">
                    {cell ? (
                      <div>
                        <p className="font-mono text-xs">{cell.model}</p>
                        <p className="text-xs text-zinc-500">{formatNumber(cell.count)} reqs</p>
                      </div>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const routingStatsColumns: Column<RoutingStat>[] = [
  { key: "taskType", label: "Task Type", sortable: true, filterable: true, render: (row) => row.taskType ? <Badge variant={row.taskType}>{row.taskType}</Badge> : <>—</>, getValue: (row) => row.taskType },
  { key: "complexity", label: "Complexity", sortable: true, filterable: true, render: (row) => row.complexity ? <Badge variant={row.complexity}>{row.complexity}</Badge> : <>—</>, getValue: (row) => row.complexity },
  { key: "routedBy", label: "Routed By", sortable: true, filterable: true, render: (row) => <span className="text-zinc-400 text-xs">{row.routedBy || "—"}</span>, getValue: (row) => row.routedBy },
  { key: "provider", label: "Provider", sortable: true, filterable: true },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.model}</span> },
  { key: "count", label: "Requests", sortable: true, align: "right", render: (row) => formatNumber(row.count) },
  { key: "avgLatency", label: "Avg Latency", sortable: true, align: "right", render: (row) => formatLatency(row.avgLatency) },
];

export default function RoutingPage() {
  const [stats, setStats] = useState<RoutingStat[]>([]);
  const [distribution, setDistribution] = useState<Distribution | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, distRes] = await Promise.all([
          fetch(`${GATEWAY}/v1/analytics/routing/stats`),
          fetch(`${GATEWAY}/v1/analytics/routing/distribution`),
        ]);
        const statsData = await statsRes.json();
        const distData = await distRes.json();
        setStats(statsData.stats || []);
        setDistribution(distData);
      } catch (err) {
        console.error("Failed to fetch routing data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading routing data...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <h1 className="text-2xl font-bold">Routing Analytics</h1>

      {/* Distribution Charts */}
      <div className="grid grid-cols-2 gap-6">
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">By Task Type</h2>
          {distribution?.byTaskType && distribution.byTaskType.length > 0 ? (
            <BarChart data={distribution.byTaskType} labelKey="taskType" valueKey="count" />
          ) : (
            <p className="text-zinc-500 text-sm">No data yet.</p>
          )}
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">By Complexity</h2>
          {distribution?.byComplexity && distribution.byComplexity.length > 0 ? (
            <BarChart data={distribution.byComplexity} labelKey="complexity" valueKey="count" />
          ) : (
            <p className="text-zinc-500 text-sm">No data yet.</p>
          )}
        </section>
      </div>

      {/* Routing Matrix */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Routing Matrix (Top Model per Cell)</h2>
        <RoutingMatrix stats={stats} />
      </section>

      {/* Detailed Stats */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Detailed Routing Stats</h2>
        <DataTable
          columns={routingStatsColumns}
          data={stats}
          pageSize={10}
          emptyMessage="No routing data yet. Send some requests without specifying a model."
        />
      </section>
    </div>
  );
}
