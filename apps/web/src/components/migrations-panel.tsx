"use client";

import { useCallback, useEffect, useState } from "react";
import { gatewayFetchRaw } from "../lib/gateway-client";
import { GatedPanel } from "./gated-panel";

interface MigrationRow {
  id: string;
  taskType: string;
  complexity: string;
  fromProvider: string;
  fromModel: string;
  fromCostPer1M: number;
  fromQualityScore: number;
  toProvider: string;
  toModel: string;
  toCostPer1M: number;
  toQualityScore: number;
  projectedMonthlySavingsUsd: number;
  graceEndsAt: string;
  executedAt: string;
  rolledBackAt: string | null;
  rollbackReason: string | null;
}

interface Status {
  enabled: boolean;
  savingsThisMonth: number;
}

function usd(v: number): string {
  if (v === 0) return "$0";
  if (v < 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(0)}`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface GatedState {
  reason: string;
  currentTier: string;
  upgradeUrl?: string;
}

export function MigrationsPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [migrations, setMigrations] = useState<MigrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gated, setGated] = useState<GatedState | null>(null);

  const load = useCallback(async () => {
    try {
      const statusRes = await gatewayFetchRaw("/v1/cost-migrations/status");
      // Tier gate from #168 returns 402 when the deployment isn't Cloud or
      // the caller's subscription doesn't include Intelligence. Render a
      // dedicated empty state instead of crashing on status.savingsThisMonth
      // being undefined. Full Upgrade CTA UX lands in #169.
      if (statusRes.status === 402) {
        const body = await statusRes.json().catch(() => ({}));
        setGated({
          reason: body?.gate?.reason ?? "not_available",
          currentTier: body?.gate?.currentTier ?? "free",
          upgradeUrl: body?.gate?.upgradeUrl,
        });
        setStatus(null);
        setMigrations([]);
        return;
      }
      if (!statusRes.ok) {
        setStatus(null);
        return;
      }
      const parsedStatus: Status = await statusRes.json();
      const listRes = await gatewayFetchRaw("/v1/cost-migrations").then((r) => r.json());
      setStatus(parsedStatus);
      setMigrations(listRes.migrations || []);
      setGated(null);
    } catch (err) {
      console.error("migrations panel fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle() {
    if (!status) return;
    setBusy(true);
    try {
      await gatewayFetchRaw("/v1/cost-migrations/opt-in", {
        method: "POST",
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function rollback(id: string) {
    await gatewayFetchRaw(`/v1/cost-migrations/${id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ reason: "manual rollback from dashboard" }),
    });
    await load();
  }

  if (loading) return <p className="text-sm text-zinc-500">Loading cost migrations...</p>;
  if (gated) return <GatedPanel reason={gated.reason} currentTier={gated.currentTier} upgradeUrl={gated.upgradeUrl} feature="Automated cost migrations" />;
  if (!status) return null;

  const activeRows = migrations.filter((m) => !m.rolledBackAt);
  const rolledBackRows = migrations.filter((m) => m.rolledBackAt);

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Quality-gated cost migrations</h3>
            <p className="text-xs text-zinc-500 mt-1">
              Nightly sweep: when a cheaper model holds its quality within
              tolerance, the router migrates the cell automatically and reports
              the projected savings.
            </p>
          </div>
          <button
            onClick={toggle}
            disabled={busy}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              status.enabled
                ? "bg-emerald-700 hover:bg-emerald-600 text-white"
                : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
            } disabled:opacity-50`}
          >
            {status.enabled ? "Enabled" : "Enable"}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
          <div className="bg-zinc-800/40 rounded p-2">
            <div className="text-zinc-500">Projected savings this month</div>
            <div className="text-emerald-400 font-semibold mt-1 text-base">
              {usd(status.savingsThisMonth)}
            </div>
          </div>
          <div className="bg-zinc-800/40 rounded p-2">
            <div className="text-zinc-500">Active migrations</div>
            <div className="text-zinc-200 font-medium mt-1">{activeRows.length}</div>
          </div>
          <div className="bg-zinc-800/40 rounded p-2">
            <div className="text-zinc-500">Rolled back</div>
            <div className="text-zinc-200 font-medium mt-1">{rolledBackRows.length}</div>
          </div>
        </div>
      </div>

      {activeRows.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h4 className="text-sm font-semibold text-zinc-200">Active migrations</h4>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-400 text-xs">
                <th className="text-left px-4 py-2">Cell</th>
                <th className="text-left px-4 py-2">From</th>
                <th className="text-left px-4 py-2">To</th>
                <th className="text-right px-4 py-2">Savings/mo</th>
                <th className="text-right px-4 py-2">Grace ends</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((m) => (
                <tr key={m.id} className="border-t border-zinc-800/50">
                  <td className="px-4 py-2 text-xs text-zinc-300 capitalize">
                    {m.taskType}+{m.complexity}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-400">
                    {m.fromProvider}/{m.fromModel}
                    <div className="text-[10px] text-zinc-500">
                      q{m.fromQualityScore.toFixed(2)} · ${m.fromCostPer1M.toFixed(2)}/1M
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-emerald-300">
                    {m.toProvider}/{m.toModel}
                    <div className="text-[10px] text-zinc-500">
                      q{m.toQualityScore.toFixed(2)} · ${m.toCostPer1M.toFixed(2)}/1M
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-emerald-400 font-medium">
                    {usd(m.projectedMonthlySavingsUsd)}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-zinc-500">
                    {shortDate(m.graceEndsAt)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => rollback(m.id)}
                      className="text-xs text-zinc-400 hover:text-red-400"
                    >
                      Roll back
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rolledBackRows.length > 0 && (
        <details className="bg-zinc-900 border border-zinc-800 rounded-lg">
          <summary className="px-4 py-2 cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
            Rolled-back history ({rolledBackRows.length})
          </summary>
          <div className="divide-y divide-zinc-800/50">
            {rolledBackRows.slice(0, 20).map((m) => (
              <div key={m.id} className="px-4 py-2 text-xs text-zinc-500 flex justify-between">
                <span>
                  {m.taskType}+{m.complexity} —{" "}
                  <span className="font-mono text-zinc-400">
                    {m.fromProvider}/{m.fromModel} → {m.toProvider}/{m.toModel}
                  </span>
                </span>
                <span>{m.rolledBackAt ? shortDate(m.rolledBackAt) : ""}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
