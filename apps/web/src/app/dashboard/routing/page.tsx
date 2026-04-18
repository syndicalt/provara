"use client";

import { useEffect, useState } from "react";
import { formatLatency, formatNumber } from "../../../lib/format";
import { DataTable, type Column } from "../../../components/data-table";
import { Badge } from "../../../components/badge";
import { gatewayFetchRaw } from "../../../lib/gateway-client";
import { PipelineVisualization } from "../../../components/pipeline-viz";
import type { AdaptiveCell } from "../../../components/adaptive-heatmap";
import { useAdaptiveScoreBuffer } from "../../../hooks/use-adaptive-score-buffer";
import { MigrationsPanel } from "../../../components/migrations-panel";

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

function IsolationSection({
  isolation,
  saving,
  onToggleConsume,
  onToggleContribute,
}: {
  isolation: IsolationResponse;
  saving: null | "consumesPool" | "contributesPool";
  onToggleConsume: () => void;
  onToggleContribute: () => void;
}) {
  const tierLabel =
    isolation.tier === "enterprise" ? "Enterprise" : isolation.tier === "team" ? "Team" : "Pro";
  const isolatedByDefault = isolation.tier === "team" || isolation.tier === "enterprise";
  const matrixEmpty = isolatedByDefault && !isolation.preferences.consumesPool;

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">Adaptive Isolation</h2>
          <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
            Controls whether your tenant's routing matrix is isolated from the shared pool and whether your ratings contribute to it. Current plan: <span className="text-zinc-300">{tierLabel}</span>.
          </p>
        </div>
        <a
          href="/enterprise-data-handling"
          className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
          target="_blank"
          rel="noreferrer"
        >
          Data handling ↗
        </a>
      </div>

      {!isolation.canToggle && (
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-xs text-zinc-400">
          Pro plans use the shared routing pool for both reads and writes. Isolated per-tenant routing is a Team and Enterprise feature.{" "}
          <a href="/pricing" className="text-blue-400 hover:text-blue-300">Compare plans</a>.
        </div>
      )}

      <div className="space-y-4">
        <ToggleRow
          label="Use pooled routing signal"
          hint="When your matrix is empty or sparse, fall back to the shared pool at decision time. Pool data is never copied into your matrix."
          on={isolation.policy.readsPool}
          saving={saving === "consumesPool"}
          disabled={!isolation.canToggle}
          onClick={onToggleConsume}
        />
        <ToggleRow
          label="Contribute ratings to pooled signal"
          hint="When on, your ratings update the shared pool in addition to your own matrix. Contributions merge into a statistical model and cannot be retroactively removed — turn off at any time to stop future contributions."
          warning
          on={isolation.policy.writesPool}
          saving={saving === "contributesPool"}
          disabled={!isolation.canToggle}
          onClick={onToggleContribute}
        />
      </div>

      {matrixEmpty && (
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-xs text-zinc-400">
          Your routing matrix is isolated. Until your own ratings accrue, routing falls back to cost-based selection for cells you have no history on. Turn on <span className="text-zinc-300">Use pooled routing signal</span> to bootstrap from the shared pool without cutting ties.
        </div>
      )}
    </section>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  saving,
  disabled,
  warning,
  onClick,
}: {
  label: string;
  hint: string;
  on: boolean;
  saving: boolean;
  disabled: boolean;
  warning?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex-1">
        <p className="text-sm text-zinc-300">{label}</p>
        <p className={`text-xs mt-1 max-w-2xl ${warning ? "text-amber-300/80" : "text-zinc-500"}`}>{hint}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || saving}
        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors shrink-0 ${
          disabled
            ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
            : on
            ? "bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/50"
            : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
        } ${saving ? "opacity-60" : ""}`}
      >
        {saving ? "Saving..." : on ? "On" : "Off"}
      </button>
    </div>
  );
}

function ContributeConfirmModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h3 className="text-base font-semibold text-zinc-100">Contribute to the shared pool?</h3>
        <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
          Ratings you contribute will merge into the shared pool's statistical model and{" "}
          <span className="text-amber-300">cannot be retroactively removed</span>. You can stop future contributions at any time by turning this toggle back off, but past contributions remain in the pool.
        </p>
        <p className="mt-3 text-xs text-zinc-500">
          See the <a href="/enterprise-data-handling" className="text-blue-400 hover:text-blue-300" target="_blank" rel="noreferrer">data handling addendum</a> for the full contractual language.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-600"
          >
            I understand, enable
          </button>
        </div>
      </div>
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

interface RoutingConfig {
  abTestPreempts: boolean;
}

type IsolationTier = "free" | "pro" | "team" | "enterprise";

interface IsolationResponse {
  tier: IsolationTier;
  canToggle: boolean;
  policy: {
    readsPool: boolean;
    writesPool: boolean;
    readsTenantRow: boolean;
    writesTenantRow: boolean;
  };
  preferences: {
    consumesPool: boolean;
    contributesPool: boolean;
  };
}

export default function RoutingPage() {
  const [stats, setStats] = useState<RoutingStat[]>([]);
  const [distribution, setDistribution] = useState<Distribution | null>(null);
  const [adaptiveCells, setAdaptiveCells] = useState<AdaptiveCell[]>([]);
  const [routingConfig, setRoutingConfig] = useState<RoutingConfig | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [isolation, setIsolation] = useState<IsolationResponse | null>(null);
  const [savingIsolation, setSavingIsolation] = useState<null | "consumesPool" | "contributesPool">(null);
  const [contributeConfirm, setContributeConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const { pulseTick, recentUpdateCount } = useAdaptiveScoreBuffer(adaptiveCells);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, distRes, configRes, isoRes] = await Promise.all([
          gatewayFetchRaw("/v1/analytics/routing/stats"),
          gatewayFetchRaw("/v1/analytics/routing/distribution"),
          gatewayFetchRaw("/v1/routing/config"),
          gatewayFetchRaw("/v1/routing/isolation").catch(() => null),
        ]);
        const statsData = await statsRes.json();
        const distData = await distRes.json();
        const configData = await configRes.json();
        setStats(statsData.stats || []);
        setDistribution(distData);
        setRoutingConfig(configData);
        if (isoRes && isoRes.ok) {
          setIsolation(await isoRes.json());
        }
      } catch (err) {
        console.error("Failed to fetch routing data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  async function patchIsolation(payload: { consumesPool?: boolean; contributesPool?: boolean }, key: "consumesPool" | "contributesPool") {
    setSavingIsolation(key);
    try {
      const res = await gatewayFetchRaw("/v1/routing/isolation", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = (await res.json()) as IsolationResponse;
        // Re-fetch to get updated derived policy (backend recomputes).
        const policyRes = await gatewayFetchRaw("/v1/routing/isolation");
        if (policyRes.ok) {
          setIsolation(await policyRes.json());
        } else {
          setIsolation((prev) => (prev ? { ...prev, preferences: data.preferences } : prev));
        }
      } else {
        console.error("isolation patch failed", await res.text());
      }
    } catch (err) {
      console.error("isolation patch error", err);
    } finally {
      setSavingIsolation(null);
    }
  }

  function onToggleConsume() {
    if (!isolation || !isolation.canToggle || savingIsolation) return;
    patchIsolation({ consumesPool: !isolation.preferences.consumesPool }, "consumesPool");
  }

  function onToggleContribute() {
    if (!isolation || !isolation.canToggle || savingIsolation) return;
    // Irreversibility warning fires only when enabling (turning off is safe).
    if (!isolation.preferences.contributesPool) {
      setContributeConfirm(true);
      return;
    }
    patchIsolation({ contributesPool: false }, "contributesPool");
  }

  function confirmContribute() {
    setContributeConfirm(false);
    patchIsolation({ contributesPool: true }, "contributesPool");
  }

  async function toggleAbTestPreempts() {
    if (!routingConfig || savingConfig) return;
    setSavingConfig(true);
    const next = !routingConfig.abTestPreempts;
    try {
      const res = await gatewayFetchRaw("/v1/routing/config", {
        method: "PUT",
        body: JSON.stringify({ abTestPreempts: next }),
      });
      const data = await res.json();
      setRoutingConfig(data);
    } catch (err) {
      console.error("Failed to update routing config:", err);
    } finally {
      setSavingConfig(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function pollAdaptive() {
      try {
        const res = await gatewayFetchRaw("/v1/analytics/adaptive/scores");
        const data = await res.json();
        if (!cancelled) setAdaptiveCells(data.cells || []);
      } catch {}
    }
    pollAdaptive();
    const id = setInterval(pollAdaptive, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
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

      {/* Adaptive Isolation — only visible when backend returns a response
          (i.e. cloud deployment with known tier). Free tenants are hidden
          entirely; Pro sees disabled toggles with upgrade copy; Team +
          Enterprise get working toggles with an irreversibility modal
          gating the "contribute to pool" enable. */}
      {isolation && isolation.tier !== "free" && (
        <IsolationSection
          isolation={isolation}
          saving={savingIsolation}
          onToggleConsume={onToggleConsume}
          onToggleContribute={onToggleContribute}
        />
      )}

      {/* Modal — irreversibility confirmation for "contribute to pool" enable */}
      {contributeConfirm && (
        <ContributeConfirmModal
          onCancel={() => setContributeConfirm(false)}
          onConfirm={confirmContribute}
        />
      )}

      {/* Routing Config */}
      {routingConfig && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">Routing Configuration</h2>
          <div className="flex items-start justify-between gap-6">
            <div className="flex-1">
              <p className="text-sm text-zinc-300 mb-1">A/B tests preempt adaptive routing</p>
              <p className="text-xs text-zinc-500 max-w-2xl">
                When enabled (default), an active A/B test on a cell takes precedence over adaptive routing — useful for controlled comparisons. When disabled, adaptive wins if it has enough samples for the cell, and A/B tests only fire when adaptive can't help.
              </p>
            </div>
            <button
              onClick={toggleAbTestPreempts}
              disabled={savingConfig}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors shrink-0 ${
                routingConfig.abTestPreempts
                  ? "bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/50"
                  : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
              } ${savingConfig ? "opacity-60" : ""}`}
            >
              {savingConfig ? "Saving..." : routingConfig.abTestPreempts ? "On" : "Off"}
            </button>
          </div>
        </section>
      )}

      {/* Pipeline Visualization */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold">Routing Pipeline</h2>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                recentUpdateCount > 0 ? "bg-emerald-400" : "bg-zinc-600"
              }`}
            />
            <span>
              <span className="font-mono text-zinc-200">{recentUpdateCount}</span>{" "}
              learning {recentUpdateCount === 1 ? "update" : "updates"} in last 60s
            </span>
          </div>
        </div>
        <PipelineVisualization adaptivePulseTick={pulseTick} />
      </section>

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
        <h2 className="text-lg font-semibold mb-1">Most Frequently Called Model per Cell</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Based on historical request count. See <a href="/dashboard/quality" className="text-blue-400 hover:text-blue-300 underline">Quality → Adaptive Routing</a> for quality-based routing decisions.
        </p>
        <RoutingMatrix stats={stats} />
      </section>

      {/* Cost migrations */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Cost Migrations</h2>
        <MigrationsPanel />
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
