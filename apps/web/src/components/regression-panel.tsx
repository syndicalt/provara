"use client";

import { useCallback, useEffect, useState } from "react";
import { gatewayFetchRaw } from "../lib/gateway-client";

interface RegressionStatus {
  enabled: boolean;
  budget: { used: number; limit: number; remaining: number };
  bankSize: number;
  defaultWeeklyBudgetUsd: number;
}

interface RegressionEvent {
  id: string;
  taskType: string;
  complexity: string;
  provider: string;
  model: string;
  replayCount: number;
  originalMean: number;
  replayMean: number;
  delta: number;
  costUsd: number;
  detectedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

function formatUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function RegressionPanel() {
  const [status, setStatus] = useState<RegressionStatus | null>(null);
  const [events, setEvents] = useState<RegressionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      const [statusRes, eventsRes] = await Promise.all([
        gatewayFetchRaw("/v1/regression/status").then((r) => r.json()),
        gatewayFetchRaw("/v1/regression/events").then((r) => r.json()),
      ]);
      setStatus(statusRes);
      setEvents(eventsRes.events || []);
    } catch (err) {
      console.error("regression panel fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleOptIn() {
    if (!status) return;
    setToggling(true);
    try {
      await gatewayFetchRaw("/v1/regression/opt-in", {
        method: "POST",
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      await load();
    } finally {
      setToggling(false);
    }
  }

  async function resolveEvent(id: string) {
    await gatewayFetchRaw(`/v1/regression/events/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note: "dismissed" }),
    });
    await load();
  }

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading regression detection...</p>;
  }

  if (!status) return null;

  const liveEvents = events.filter((e) => !e.resolvedAt);
  const resolvedEvents = events.filter((e) => e.resolvedAt);

  return (
    <div className="space-y-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Silent-regression detection</h3>
            <p className="text-xs text-zinc-500 mt-1">
              Periodically replays top-rated historical prompts and alerts when the current model's answers grade lower than the originals.
            </p>
          </div>
          <button
            onClick={toggleOptIn}
            disabled={toggling}
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
            <div className="text-zinc-500">Bank size</div>
            <div className="text-zinc-200 font-medium mt-1">{status.bankSize} prompts</div>
          </div>
          <div className="bg-zinc-800/40 rounded p-2">
            <div className="text-zinc-500">Weekly budget</div>
            <div className="text-zinc-200 font-medium mt-1">
              {formatUsd(status.budget.used)} / {formatUsd(status.budget.limit)}
            </div>
          </div>
          <div className="bg-zinc-800/40 rounded p-2">
            <div className="text-zinc-500">Live regressions</div>
            <div className={`font-medium mt-1 ${liveEvents.length > 0 ? "text-red-400" : "text-emerald-400"}`}>
              {liveEvents.length}
            </div>
          </div>
        </div>
      </div>

      {liveEvents.length > 0 && (
        <div className="bg-red-950/30 border border-red-900/60 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-red-900/40">
            <h4 className="text-sm font-semibold text-red-300">Active regressions</h4>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-400 text-xs">
                <th className="text-left px-4 py-2">Cell</th>
                <th className="text-left px-4 py-2">Model</th>
                <th className="text-right px-4 py-2">Original</th>
                <th className="text-right px-4 py-2">Replay</th>
                <th className="text-right px-4 py-2">Δ</th>
                <th className="text-right px-4 py-2">Detected</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {liveEvents.map((e) => (
                <tr key={e.id} className="border-t border-red-900/30">
                  <td className="px-4 py-2 text-xs text-zinc-300 capitalize">{e.taskType}+{e.complexity}</td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-200">{e.provider}/{e.model}</td>
                  <td className="px-4 py-2 text-right text-xs text-zinc-300">{e.originalMean.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right text-xs text-red-300">{e.replayMean.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right text-xs text-red-300">{e.delta.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right text-xs text-zinc-500">{new Date(e.detectedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => resolveEvent(e.id)}
                      className="text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Dismiss
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resolvedEvents.length > 0 && (
        <details className="bg-zinc-900 border border-zinc-800 rounded-lg">
          <summary className="px-4 py-2 cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
            Resolved history ({resolvedEvents.length})
          </summary>
          <div className="divide-y divide-zinc-800/50">
            {resolvedEvents.slice(0, 20).map((e) => (
              <div key={e.id} className="px-4 py-2 text-xs text-zinc-500 flex justify-between">
                <span>
                  <span className="text-zinc-400">{e.provider}/{e.model}</span> — {e.taskType}+{e.complexity} — Δ{e.delta.toFixed(2)}
                </span>
                <span>{e.resolvedAt ? new Date(e.resolvedAt).toLocaleDateString() : ""}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
