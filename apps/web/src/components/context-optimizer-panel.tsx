"use client";

import { useEffect, useMemo, useState } from "react";
import { gatewayFetchRaw } from "../lib/gateway-client";

export interface ContextOptimizationSummary {
  eventCount: number;
  inputChunks: number;
  outputChunks: number;
  droppedChunks: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  reductionPct: number;
  flaggedChunks: number;
  quarantinedChunks: number;
  latestAt: string | null;
}

export interface ContextOptimizationEvent {
  id: string;
  tenantId: string | null;
  inputChunks: number;
  outputChunks: number;
  droppedChunks: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  reductionPct: number;
  duplicateSourceIds: string[];
  riskScanned: boolean;
  flaggedChunks: number;
  quarantinedChunks: number;
  riskySourceIds: string[];
  riskDetails: Array<{
    id: string;
    decision: string;
    ruleName: string | null;
    matchedContent: string | null;
  }>;
  createdAt: string;
}

interface GateState {
  message: string;
  upgradeUrl?: string;
}

interface LoadState {
  summary: ContextOptimizationSummary | null;
  events: ContextOptimizationEvent[];
  loading: boolean;
  error: string | null;
  gate: GateState | null;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function metricTone(value: number): string {
  if (value > 0) return "text-emerald-300";
  return "text-zinc-200";
}

function riskTone(value: number): string {
  if (value > 0) return "text-amber-300";
  return "text-zinc-200";
}

function StatTile({ label, value, detail, tone }: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${tone || "text-zinc-100"}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      {[0, 1, 2].map((row) => (
        <div key={row} className="grid grid-cols-5 gap-4 border-b border-zinc-800 px-4 py-4 last:border-b-0">
          <div className="h-4 rounded bg-zinc-800" />
          <div className="h-4 rounded bg-zinc-800" />
          <div className="h-4 rounded bg-zinc-800" />
          <div className="h-4 rounded bg-zinc-800" />
          <div className="h-4 rounded bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return await res.json() as T;
  } catch {
    return null;
  }
}

export function ContextOptimizerPanel() {
  const [state, setState] = useState<LoadState>({
    summary: null,
    events: [],
    loading: true,
    error: null,
    gate: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState((prev) => ({ ...prev, loading: true, error: null, gate: null }));

      try {
        const [summaryRes, eventsRes] = await Promise.all([
          gatewayFetchRaw("/v1/context/summary"),
          gatewayFetchRaw("/v1/context/events?limit=25"),
        ]);

        if (summaryRes.status === 402 || eventsRes.status === 402) {
          const body = await readJson<{ error?: { message?: string }; gate?: { upgradeUrl?: string } }>(
            summaryRes.status === 402 ? summaryRes : eventsRes,
          );
          if (!cancelled) {
            setState({
              summary: null,
              events: [],
              loading: false,
              error: null,
              gate: {
                message: body?.error?.message || "Intelligence access is required.",
                upgradeUrl: body?.gate?.upgradeUrl,
              },
            });
          }
          return;
        }

        if (!summaryRes.ok || !eventsRes.ok) {
          throw new Error("Failed to load Context Optimizer data");
        }

        const summaryBody = await summaryRes.json() as { summary: ContextOptimizationSummary };
        const eventsBody = await eventsRes.json() as { events: ContextOptimizationEvent[] };

        if (!cancelled) {
          setState({
            summary: summaryBody.summary,
            events: eventsBody.events,
            loading: false,
            error: null,
            gate: null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            summary: null,
            events: [],
            loading: false,
            error: err instanceof Error ? err.message : "Failed to load Context Optimizer data",
            gate: null,
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = state.summary;
  const eventRows = useMemo(() => state.events, [state.events]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Context Optimizer</h1>
          <p className="mt-1 text-sm text-zinc-400">Runtime context savings and duplicate-drop visibility.</p>
        </div>
        <div className="text-xs text-zinc-500">
          Latest event: <span className="text-zinc-300">{formatTimestamp(summary?.latestAt ?? null)}</span>
        </div>
      </div>

      {state.gate && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/30 p-4">
          <div className="text-sm font-medium text-amber-200">Upgrade required</div>
          <div className="mt-1 text-sm text-amber-100/80">{state.gate.message}</div>
          {state.gate.upgradeUrl && (
            <a href={state.gate.upgradeUrl} className="mt-3 inline-flex rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">
              View Billing
            </a>
          )}
        </div>
      )}

      {state.error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-sm text-red-200">
          {state.error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Events"
          value={formatInteger(summary?.eventCount ?? 0)}
          detail="Optimization calls recorded"
        />
        <StatTile
          label="Saved Tokens"
          value={formatInteger(summary?.savedTokens ?? 0)}
          detail={`${formatInteger(summary?.inputTokens ?? 0)} input token estimate`}
          tone={metricTone(summary?.savedTokens ?? 0)}
        />
        <StatTile
          label="Dropped Chunks"
          value={formatInteger(summary?.droppedChunks ?? 0)}
          detail={`${formatInteger(summary?.inputChunks ?? 0)} input chunks scanned`}
          tone={metricTone(summary?.droppedChunks ?? 0)}
        />
        <StatTile
          label="Risky Chunks"
          value={formatInteger((summary?.flaggedChunks ?? 0) + (summary?.quarantinedChunks ?? 0))}
          detail={`${formatInteger(summary?.quarantinedChunks ?? 0)} quarantined, ${formatInteger(summary?.flaggedChunks ?? 0)} flagged`}
          tone={riskTone((summary?.flaggedChunks ?? 0) + (summary?.quarantinedChunks ?? 0))}
        />
        <StatTile
          label="Reduction"
          value={formatPercent(summary?.reductionPct ?? 0)}
          detail={`${formatInteger(summary?.outputTokens ?? 0)} output token estimate`}
          tone={metricTone(summary?.reductionPct ?? 0)}
        />
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Recent Events</h2>
            <p className="mt-1 text-sm text-zinc-500">Newest context optimization records.</p>
          </div>
        </div>

        {state.loading ? (
          <LoadingRows />
        ) : eventRows.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
            No context optimization events yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-950/60 text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Time</th>
                    <th className="px-4 py-3 text-right font-medium">Chunks</th>
                    <th className="px-4 py-3 text-right font-medium">Dropped</th>
                    <th className="px-4 py-3 text-right font-medium">Risk</th>
                    <th className="px-4 py-3 text-right font-medium">Saved</th>
                    <th className="px-4 py-3 text-left font-medium">Duplicate IDs</th>
                    <th className="px-4 py-3 text-left font-medium">Risky IDs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {eventRows.map((event) => {
                    const riskyChunks = event.flaggedChunks + event.quarantinedChunks;
                    return (
                      <tr key={event.id}>
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-300">{formatTimestamp(event.createdAt)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatInteger(event.inputChunks)} {"->"} {formatInteger(event.outputChunks)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatInteger(event.droppedChunks)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                          {event.riskScanned ? (
                            <span className={riskyChunks > 0 ? "text-amber-300" : "text-zinc-400"}>
                              {formatInteger(riskyChunks)}
                              <span className="ml-2 text-xs text-zinc-500">
                                {formatInteger(event.quarantinedChunks)}q/{formatInteger(event.flaggedChunks)}f
                              </span>
                            </span>
                          ) : (
                            <span className="text-zinc-600">Not scanned</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-emerald-300">
                          {formatInteger(event.savedTokens)}
                          <span className="ml-2 text-xs text-zinc-500">{formatPercent(event.reductionPct)}</span>
                        </td>
                        <td className="px-4 py-3">
                          {event.duplicateSourceIds.length === 0 ? (
                            <span className="text-zinc-600">None</span>
                          ) : (
                            <div className="flex max-w-xl flex-wrap gap-1">
                              {event.duplicateSourceIds.slice(0, 6).map((id) => (
                                <span key={id} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-300">
                                  {id}
                                </span>
                              ))}
                              {event.duplicateSourceIds.length > 6 && (
                                <span className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-500">
                                  +{event.duplicateSourceIds.length - 6}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {event.riskySourceIds.length === 0 ? (
                            <span className="text-zinc-600">None</span>
                          ) : (
                            <div className="flex max-w-xl flex-wrap gap-1">
                              {event.riskySourceIds.slice(0, 6).map((id) => (
                                <span key={id} className="rounded border border-amber-800/80 bg-amber-950/30 px-2 py-0.5 font-mono text-xs text-amber-200">
                                  {id}
                                </span>
                              ))}
                              {event.riskySourceIds.length > 6 && (
                                <span className="rounded border border-amber-900/70 bg-amber-950/20 px-2 py-0.5 text-xs text-amber-400">
                                  +{event.riskySourceIds.length - 6}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
