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

export interface ContextQualitySummary {
  eventCount: number;
  regressedCount: number;
  avgRawScore: number | null;
  avgOptimizedScore: number | null;
  avgDelta: number | null;
  latestAt: string | null;
}

export interface ContextQualityEvent {
  id: string;
  tenantId: string | null;
  rawScore: number;
  optimizedScore: number;
  delta: number;
  regressed: boolean;
  regressionThreshold: number;
  judgeProvider: string;
  judgeModel: string;
  promptHash: string;
  rawSourceIds: string[];
  optimizedSourceIds: string[];
  rationale: string | null;
  createdAt: string;
}

export interface ContextRetrievalSummary {
  eventCount: number;
  retrievedChunks: number;
  usedChunks: number;
  unusedChunks: number;
  duplicateChunks: number;
  riskyChunks: number;
  retrievedTokens: number;
  usedTokens: number;
  unusedTokens: number;
  efficiencyPct: number;
  duplicateRatePct: number;
  riskyRatePct: number;
  latestAt: string | null;
}

export interface ContextRetrievalEvent {
  id: string;
  tenantId: string | null;
  optimizationEventId: string | null;
  retrievedChunks: number;
  usedChunks: number;
  unusedChunks: number;
  duplicateChunks: number;
  riskyChunks: number;
  retrievedTokens: number;
  usedTokens: number;
  unusedTokens: number;
  efficiencyPct: number;
  duplicateRatePct: number;
  riskyRatePct: number;
  usedSourceIds: string[];
  unusedSourceIds: string[];
  riskySourceIds: string[];
  createdAt: string;
}

interface GateState {
  message: string;
  upgradeUrl?: string;
}

interface LoadState {
  summary: ContextOptimizationSummary | null;
  events: ContextOptimizationEvent[];
  qualitySummary: ContextQualitySummary | null;
  qualityEvents: ContextQualityEvent[];
  retrievalSummary: ContextRetrievalSummary | null;
  retrievalEvents: ContextRetrievalEvent[];
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

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(value % 1 === 0 ? 0 : 2);
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

function deltaTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return "text-zinc-200";
  if (value < 0) return "text-red-300";
  if (value > 0) return "text-emerald-300";
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
    qualitySummary: null,
    qualityEvents: [],
    retrievalSummary: null,
    retrievalEvents: [],
    loading: true,
    error: null,
    gate: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState((prev) => ({ ...prev, loading: true, error: null, gate: null }));

      try {
        const [
          summaryRes,
          eventsRes,
          qualitySummaryRes,
          qualityEventsRes,
          retrievalSummaryRes,
          retrievalEventsRes,
        ] = await Promise.all([
          gatewayFetchRaw("/v1/context/summary"),
          gatewayFetchRaw("/v1/context/events?limit=25"),
          gatewayFetchRaw("/v1/context/quality/summary"),
          gatewayFetchRaw("/v1/context/quality/events?limit=10"),
          gatewayFetchRaw("/v1/context/retrieval/summary"),
          gatewayFetchRaw("/v1/context/retrieval/events?limit=10"),
        ]);

        const responses = [
          summaryRes,
          eventsRes,
          qualitySummaryRes,
          qualityEventsRes,
          retrievalSummaryRes,
          retrievalEventsRes,
        ];
        if (
          responses.some((res) => res.status === 402)
        ) {
          const body = await readJson<{ error?: { message?: string }; gate?: { upgradeUrl?: string } }>(
            responses.find((res) => res.status === 402) ?? summaryRes,
          );
          if (!cancelled) {
            setState({
              summary: null,
              events: [],
              qualitySummary: null,
              qualityEvents: [],
              retrievalSummary: null,
              retrievalEvents: [],
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

        if (responses.some((res) => !res.ok)) {
          throw new Error("Failed to load Context Optimizer data");
        }

        const summaryBody = await summaryRes.json() as { summary: ContextOptimizationSummary };
        const eventsBody = await eventsRes.json() as { events: ContextOptimizationEvent[] };
        const qualitySummaryBody = await qualitySummaryRes.json() as { summary: ContextQualitySummary };
        const qualityEventsBody = await qualityEventsRes.json() as { events: ContextQualityEvent[] };
        const retrievalSummaryBody = await retrievalSummaryRes.json() as { summary: ContextRetrievalSummary };
        const retrievalEventsBody = await retrievalEventsRes.json() as { events: ContextRetrievalEvent[] };

        if (!cancelled) {
          setState({
            summary: summaryBody.summary,
            events: eventsBody.events,
            qualitySummary: qualitySummaryBody.summary,
            qualityEvents: qualityEventsBody.events,
            retrievalSummary: retrievalSummaryBody.summary,
            retrievalEvents: retrievalEventsBody.events,
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
            qualitySummary: null,
            qualityEvents: [],
            retrievalSummary: null,
            retrievalEvents: [],
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
  const qualitySummary = state.qualitySummary;
  const qualityRows = useMemo(() => state.qualityEvents, [state.qualityEvents]);
  const retrievalSummary = state.retrievalSummary;
  const retrievalRows = useMemo(() => state.retrievalEvents, [state.retrievalEvents]);

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
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Retrieval Analytics</h2>
          <p className="mt-1 text-sm text-zinc-500">Context usage and retrieval health.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Retrieval Efficiency"
            value={formatPercent(retrievalSummary?.efficiencyPct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.usedChunks ?? 0)} used of ${formatInteger(retrievalSummary?.retrievedChunks ?? 0)} chunks`}
            tone={metricTone(retrievalSummary?.efficiencyPct ?? 0)}
          />
          <StatTile
            label="Unused Context"
            value={formatInteger(retrievalSummary?.unusedChunks ?? 0)}
            detail={`${formatInteger(retrievalSummary?.unusedTokens ?? 0)} unused token estimate`}
            tone={riskTone(retrievalSummary?.unusedChunks ?? 0)}
          />
          <StatTile
            label="Duplicate Rate"
            value={formatPercent(retrievalSummary?.duplicateRatePct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.duplicateChunks ?? 0)} duplicate chunks`}
            tone={riskTone(retrievalSummary?.duplicateChunks ?? 0)}
          />
          <StatTile
            label="Risky Context Rate"
            value={formatPercent(retrievalSummary?.riskyRatePct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.riskyChunks ?? 0)} risky chunks`}
            tone={riskTone(retrievalSummary?.riskyChunks ?? 0)}
          />
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Retrieval Events</h2>
          <p className="mt-1 text-sm text-zinc-500">Recent retrieved-context efficiency records.</p>
        </div>

        {state.loading ? (
          <LoadingRows />
        ) : retrievalRows.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
            No context retrieval events yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-950/60 text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Time</th>
                    <th className="px-4 py-3 text-right font-medium">Chunks</th>
                    <th className="px-4 py-3 text-right font-medium">Efficiency</th>
                    <th className="px-4 py-3 text-right font-medium">Duplicates</th>
                    <th className="px-4 py-3 text-right font-medium">Risky</th>
                    <th className="px-4 py-3 text-left font-medium">Unused IDs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {retrievalRows.map((event) => (
                    <tr key={event.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-300">{formatTimestamp(event.createdAt)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(event.usedChunks)} / {formatInteger(event.retrievedChunks)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-emerald-300">
                        {formatPercent(event.efficiencyPct)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(event.duplicateChunks)}
                        <span className="ml-2 text-xs text-zinc-500">{formatPercent(event.duplicateRatePct)}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-amber-300">
                        {formatInteger(event.riskyChunks)}
                        <span className="ml-2 text-xs text-zinc-500">{formatPercent(event.riskyRatePct)}</span>
                      </td>
                      <td className="px-4 py-3">
                        {event.unusedSourceIds.length === 0 ? (
                          <span className="text-zinc-600">None</span>
                        ) : (
                          <div className="flex max-w-xl flex-wrap gap-1">
                            {event.unusedSourceIds.slice(0, 6).map((id) => (
                              <span key={id} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-300">
                                {id}
                              </span>
                            ))}
                            {event.unusedSourceIds.length > 6 && (
                              <span className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-500">
                                +{event.unusedSourceIds.length - 6}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Quality Loop</h2>
          <p className="mt-1 text-sm text-zinc-500">Raw-context vs optimized-context answer scoring.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <StatTile
            label="Quality Delta"
            value={formatScore(qualitySummary?.avgDelta)}
            detail={`${formatScore(qualitySummary?.avgOptimizedScore)} optimized vs ${formatScore(qualitySummary?.avgRawScore)} raw`}
            tone={deltaTone(qualitySummary?.avgDelta)}
          />
          <StatTile
            label="Quality Checks"
            value={formatInteger(qualitySummary?.eventCount ?? 0)}
            detail="Raw vs optimized comparisons"
          />
          <StatTile
            label="Regressions"
            value={formatInteger(qualitySummary?.regressedCount ?? 0)}
            detail="Below configured delta threshold"
            tone={riskTone(qualitySummary?.regressedCount ?? 0)}
          />
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Quality Events</h2>
          <p className="mt-1 text-sm text-zinc-500">Recent judge comparisons for optimized context.</p>
        </div>

        {state.loading ? (
          <LoadingRows />
        ) : qualityRows.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
            No context quality checks yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-950/60 text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Time</th>
                    <th className="px-4 py-3 text-right font-medium">Raw</th>
                    <th className="px-4 py-3 text-right font-medium">Optimized</th>
                    <th className="px-4 py-3 text-right font-medium">Delta</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Sources</th>
                    <th className="px-4 py-3 text-left font-medium">Judge</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {qualityRows.map((event) => (
                    <tr key={event.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-300">{formatTimestamp(event.createdAt)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">{formatScore(event.rawScore)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">{formatScore(event.optimizedScore)}</td>
                      <td className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${deltaTone(event.delta)}`}>
                        {formatScore(event.delta)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {event.regressed ? (
                          <span className="rounded border border-red-900/70 bg-red-950/30 px-2 py-0.5 text-xs text-red-200">Regression</span>
                        ) : (
                          <span className="rounded border border-emerald-900/70 bg-emerald-950/20 px-2 py-0.5 text-xs text-emerald-200">Stable</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex max-w-xl flex-wrap gap-1">
                          {[...new Set([...event.rawSourceIds, ...event.optimizedSourceIds])].slice(0, 6).map((id) => (
                            <span key={id} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-300">
                              {id}
                            </span>
                          ))}
                          {event.rawSourceIds.length + event.optimizedSourceIds.length === 0 && (
                            <span className="text-zinc-600">None</span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-500">
                        {event.judgeProvider}/{event.judgeModel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

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
