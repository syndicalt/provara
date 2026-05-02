"use client";

import { useEffect, useMemo, useState } from "react";
import { gatewayFetchRaw } from "../lib/gateway-client";

export interface ContextOptimizationSummary {
  eventCount: number;
  inputChunks: number;
  outputChunks: number;
  droppedChunks: number;
  nearDuplicateChunks: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  reductionPct: number;
  avgRelevanceScore: number | null;
  lowRelevanceChunks: number;
  rerankedChunks: number;
  avgFreshnessScore: number | null;
  staleChunks: number;
  conflictChunks: number;
  conflictGroups: number;
  compressedChunks: number;
  compressionSavedTokens: number;
  compressionRatePct: number;
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
  nearDuplicateChunks: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  reductionPct: number;
  avgRelevanceScore: number | null;
  lowRelevanceChunks: number;
  rerankedChunks: number;
  avgFreshnessScore: number | null;
  staleChunks: number;
  conflictChunks: number;
  conflictGroups: number;
  compressedChunks: number;
  compressionSavedTokens: number;
  compressionRatePct: number;
  conflictSourceIds: string[];
  conflictDetails: Array<{
    id: string;
    kind: string;
    chunkIds: [string, string];
    sourceIds: string[];
    topicTokens: string[];
    leftValue: string;
    rightValue: string;
    score?: number;
    severity?: "low" | "medium" | "high";
  }>;
  duplicateSourceIds: string[];
  nearDuplicateSourceIds: string[];
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
  nearDuplicateChunks: number;
  riskyChunks: number;
  retrievedTokens: number;
  usedTokens: number;
  unusedTokens: number;
  avgRelevanceScore: number | null;
  lowRelevanceChunks: number;
  rerankedChunks: number;
  avgFreshnessScore: number | null;
  staleChunks: number;
  conflictChunks: number;
  conflictGroups: number;
  compressedChunks: number;
  compressionSavedTokens: number;
  compressionRatePct: number;
  efficiencyPct: number;
  duplicateRatePct: number;
  nearDuplicateRatePct: number;
  riskyRatePct: number;
  conflictRatePct: number;
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
  nearDuplicateChunks: number;
  riskyChunks: number;
  retrievedTokens: number;
  usedTokens: number;
  unusedTokens: number;
  avgRelevanceScore: number | null;
  lowRelevanceChunks: number;
  rerankedChunks: number;
  avgFreshnessScore: number | null;
  staleChunks: number;
  conflictChunks: number;
  conflictGroups: number;
  compressedChunks: number;
  compressionSavedTokens: number;
  compressionRatePct: number;
  efficiencyPct: number;
  duplicateRatePct: number;
  nearDuplicateRatePct: number;
  riskyRatePct: number;
  conflictRatePct: number;
  usedSourceIds: string[];
  unusedSourceIds: string[];
  riskySourceIds: string[];
  conflictSourceIds: string[];
  createdAt: string;
}

export interface ContextCollection {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  status: "active" | "archived";
  documentCount: number;
  blockCount: number;
  canonicalBlockCount: number;
  approvedBlockCount: number;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContextCanonicalBlock {
  id: string;
  collectionId: string;
  content: string;
  tokenCount: number;
  sourceCount: number;
  reviewStatus: "draft" | "approved" | "rejected";
  reviewNote: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  policyStatus: "unchecked" | "passed" | "failed";
  policyCheckedAt: string | null;
  policyDetails: Array<{
    decision: string;
    ruleId: string | null;
    ruleName: string | null;
    action: string | null;
    matchedSnippet: string | null;
  }>;
  updatedAt: string;
}

interface BulkCanonicalResult {
  id: string;
  ok: boolean;
  canonicalBlock?: ContextCanonicalBlock;
  error?: {
    message: string;
    type: string;
  };
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
  collections: ContextCollection[];
  canonicalBlocks: ContextCanonicalBlock[];
  loading: boolean;
  error: string | null;
  gate: GateState | null;
}

type DedupeMode = "exact" | "semantic";
type RankMode = "none" | "lexical" | "embedding";
type FreshnessMode = "off" | "metadata";
type ConflictMode = "off" | "heuristic" | "scored";
type CompressionMode = "off" | "extractive" | "abstractive";

interface OptimizerDraftSettings {
  dedupeMode: DedupeMode;
  semanticThreshold: number;
  rankMode: RankMode;
  query: string;
  minRelevanceScore: number;
  freshnessMode: FreshnessMode;
  maxContextAgeDays: number;
  conflictMode: ConflictMode;
  compressionMode: CompressionMode;
  maxSentencesPerChunk: number;
  scanRisk: boolean;
}

const OPTIMIZER_SETTINGS_STORAGE_KEY = "provara:context-optimizer:settings";

const DEFAULT_OPTIMIZER_SETTINGS: OptimizerDraftSettings = {
  dedupeMode: "semantic",
  semanticThreshold: 0.72,
  rankMode: "embedding",
  query: "What is the refund policy for paid accounts?",
  minRelevanceScore: 0.2,
  freshnessMode: "metadata",
  maxContextAgeDays: 180,
  conflictMode: "scored",
  compressionMode: "extractive",
  maxSentencesPerChunk: 3,
  scanRisk: true,
};

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

function formatRelevance(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return value.toFixed(2);
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

function conflictSeverityTone(severity: string | undefined): string {
  if (severity === "high") return "text-red-300";
  if (severity === "medium") return "text-amber-300";
  if (severity === "low") return "text-zinc-400";
  return "text-zinc-500";
}

function deltaTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return "text-zinc-200";
  if (value < 0) return "text-red-300";
  if (value > 0) return "text-emerald-300";
  return "text-zinc-200";
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function readStoredOptimizerSettings(): OptimizerDraftSettings {
  if (typeof window === "undefined") return DEFAULT_OPTIMIZER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(OPTIMIZER_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_OPTIMIZER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<OptimizerDraftSettings>;
    return {
      dedupeMode: parsed.dedupeMode === "exact" || parsed.dedupeMode === "semantic"
        ? parsed.dedupeMode
        : DEFAULT_OPTIMIZER_SETTINGS.dedupeMode,
      semanticThreshold: clampNumber(Number(parsed.semanticThreshold), 0.5, 1),
      rankMode: parsed.rankMode === "none" || parsed.rankMode === "lexical" || parsed.rankMode === "embedding"
        ? parsed.rankMode
        : DEFAULT_OPTIMIZER_SETTINGS.rankMode,
      query: typeof parsed.query === "string" ? parsed.query.slice(0, 2000) : DEFAULT_OPTIMIZER_SETTINGS.query,
      minRelevanceScore: clampNumber(Number(parsed.minRelevanceScore), 0, 1),
      freshnessMode: parsed.freshnessMode === "off" || parsed.freshnessMode === "metadata"
        ? parsed.freshnessMode
        : DEFAULT_OPTIMIZER_SETTINGS.freshnessMode,
      maxContextAgeDays: Math.round(clampNumber(Number(parsed.maxContextAgeDays), 1, 3650)),
      conflictMode: parsed.conflictMode === "off" || parsed.conflictMode === "heuristic" || parsed.conflictMode === "scored"
        ? parsed.conflictMode
        : DEFAULT_OPTIMIZER_SETTINGS.conflictMode,
      compressionMode: parsed.compressionMode === "off" || parsed.compressionMode === "extractive" || parsed.compressionMode === "abstractive"
        ? parsed.compressionMode
        : DEFAULT_OPTIMIZER_SETTINGS.compressionMode,
      maxSentencesPerChunk: Math.round(clampNumber(Number(parsed.maxSentencesPerChunk), 1, 8)),
      scanRisk: typeof parsed.scanRisk === "boolean" ? parsed.scanRisk : DEFAULT_OPTIMIZER_SETTINGS.scanRisk,
    };
  } catch {
    return DEFAULT_OPTIMIZER_SETTINGS;
  }
}

function buildOptimizerPayload(settings: OptimizerDraftSettings) {
  return {
    dedupeMode: settings.dedupeMode,
    semanticThreshold: settings.semanticThreshold,
    rankMode: settings.rankMode,
    query: settings.query,
    minRelevanceScore: settings.minRelevanceScore,
    freshnessMode: settings.freshnessMode,
    maxContextAgeDays: settings.maxContextAgeDays,
    conflictMode: settings.conflictMode,
    compressionMode: settings.compressionMode,
    maxSentencesPerChunk: settings.maxSentencesPerChunk,
    scanRisk: settings.scanRisk,
    chunks: [
      {
        id: "refunds-current.md#2",
        content: "Refunds are available for paid accounts within 30 days when a receipt is present.",
        source: "help-center",
        metadata: { conflictKey: "refund-policy", status: "active", updatedAt: "2026-04-01T00:00:00.000Z" },
      },
      {
        id: "refunds-legacy.md#8",
        content: "Refunds are available for paid accounts within 14 days.",
        source: "legacy-docs",
        metadata: { conflictKey: "refund-policy", status: "deprecated", updatedAt: "2024-01-15T00:00:00.000Z" },
      },
    ],
  };
}

function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-zinc-100 outline-none focus:border-blue-500"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function NumberField({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(clampNumber(Number(event.target.value), min, max))}
        className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-zinc-100 outline-none focus:border-blue-500"
      />
    </label>
  );
}

function OptimizerConfigPanel() {
  const [settings, setSettings] = useState<OptimizerDraftSettings>(() => readStoredOptimizerSettings());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPTIMIZER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage failures in locked-down browser contexts.
    }
  }, [settings]);

  const payload = useMemo(() => buildOptimizerPayload(settings), [settings]);
  const payloadText = useMemo(() => JSON.stringify(payload, null, 2), [payload]);

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payloadText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  function update<K extends keyof OptimizerDraftSettings>(key: K, value: OptimizerDraftSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Configuration</h2>
          <p className="mt-1 text-sm text-zinc-500">Draft optimizer modes and export the request payload.</p>
        </div>
        <button
          type="button"
          onClick={copyPayload}
          className="inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          {copied ? "Copied" : "Copy API Payload"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <SelectField
          label="Dedupe"
          value={settings.dedupeMode}
          options={[{ value: "exact", label: "Exact" }, { value: "semantic", label: "Semantic" }]}
          onChange={(value) => update("dedupeMode", value)}
        />
        <SelectField
          label="Ranking"
          value={settings.rankMode}
          options={[{ value: "none", label: "None" }, { value: "lexical", label: "Lexical" }, { value: "embedding", label: "Embedding" }]}
          onChange={(value) => update("rankMode", value)}
        />
        <SelectField
          label="Freshness"
          value={settings.freshnessMode}
          options={[{ value: "off", label: "Off" }, { value: "metadata", label: "Metadata" }]}
          onChange={(value) => update("freshnessMode", value)}
        />
        <SelectField
          label="Conflicts"
          value={settings.conflictMode}
          options={[{ value: "off", label: "Off" }, { value: "heuristic", label: "Heuristic" }, { value: "scored", label: "Scored" }]}
          onChange={(value) => update("conflictMode", value)}
        />
        <SelectField
          label="Compression"
          value={settings.compressionMode}
          options={[{ value: "off", label: "Off" }, { value: "extractive", label: "Extractive" }, { value: "abstractive", label: "Abstractive" }]}
          onChange={(value) => update("compressionMode", value)}
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <NumberField label="Semantic Threshold" value={settings.semanticThreshold} min={0.5} max={1} step={0.01} onChange={(value) => update("semanticThreshold", value)} />
        <NumberField label="Min Relevance" value={settings.minRelevanceScore} min={0} max={1} step={0.01} onChange={(value) => update("minRelevanceScore", value)} />
        <NumberField label="Max Age Days" value={settings.maxContextAgeDays} min={1} max={3650} step={1} onChange={(value) => update("maxContextAgeDays", Math.round(value))} />
        <NumberField label="Max Sentences" value={settings.maxSentencesPerChunk} min={1} max={8} step={1} onChange={(value) => update("maxSentencesPerChunk", Math.round(value))} />
        <label className="flex min-h-[66px] items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200">
          <span>
            <span className="block text-xs font-medium uppercase tracking-wider text-zinc-500">Risk Scan</span>
            <span className="mt-1 block text-zinc-300">{settings.scanRisk ? "Enabled" : "Disabled"}</span>
          </span>
          <input
            aria-label="Risk Scan"
            type="checkbox"
            checked={settings.scanRisk}
            onChange={(event) => update("scanRisk", event.target.checked)}
            className="h-4 w-4 accent-blue-600"
          />
        </label>
      </div>

      <label className="mt-3 block text-xs font-medium uppercase tracking-wider text-zinc-500">
        Query
        <input
          value={settings.query}
          onChange={(event) => update("query", event.target.value.slice(0, 2000))}
          className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-zinc-100 outline-none focus:border-blue-500"
        />
      </label>

      <pre className="mt-4 max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
        {payloadText}
      </pre>
    </section>
  );
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
  const [selectedCanonicalIds, setSelectedCanonicalIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<"policy" | "approve" | "reject" | null>(null);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({
    summary: null,
    events: [],
    qualitySummary: null,
    qualityEvents: [],
    retrievalSummary: null,
    retrievalEvents: [],
    collections: [],
    canonicalBlocks: [],
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
          collectionsRes,
        ] = await Promise.all([
          gatewayFetchRaw("/v1/context/summary"),
          gatewayFetchRaw("/v1/context/events?limit=25"),
          gatewayFetchRaw("/v1/context/quality/summary"),
          gatewayFetchRaw("/v1/context/quality/events?limit=10"),
          gatewayFetchRaw("/v1/context/retrieval/summary"),
          gatewayFetchRaw("/v1/context/retrieval/events?limit=10"),
          gatewayFetchRaw("/v1/context/collections"),
        ]);

        const responses = [
          summaryRes,
          eventsRes,
          qualitySummaryRes,
          qualityEventsRes,
          retrievalSummaryRes,
          retrievalEventsRes,
          collectionsRes,
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
              collections: [],
              canonicalBlocks: [],
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
        const collectionsBody = await collectionsRes.json() as { collections: ContextCollection[] };
        let canonicalBlocks: ContextCanonicalBlock[] = [];
        const firstCollection = collectionsBody.collections[0];
        if (firstCollection && firstCollection.canonicalBlockCount > 0) {
          const canonicalRes = await gatewayFetchRaw(`/v1/context/collections/${firstCollection.id}/canonical-blocks?reviewStatus=draft`);
          if (canonicalRes.ok) {
            const canonicalBody = await canonicalRes.json() as { canonicalBlocks: ContextCanonicalBlock[] };
            canonicalBlocks = canonicalBody.canonicalBlocks;
          }
        }

        if (!cancelled) {
          setState({
            summary: summaryBody.summary,
            events: eventsBody.events,
            qualitySummary: qualitySummaryBody.summary,
            qualityEvents: qualityEventsBody.events,
            retrievalSummary: retrievalSummaryBody.summary,
            retrievalEvents: retrievalEventsBody.events,
            collections: collectionsBody.collections,
            canonicalBlocks,
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
            collections: [],
            canonicalBlocks: [],
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
  const collectionRows = useMemo(() => state.collections, [state.collections]);
  const canonicalRows = useMemo(() => state.canonicalBlocks, [state.canonicalBlocks]);
  const visibleCanonicalRows = useMemo(() => canonicalRows.slice(0, 10), [canonicalRows]);
  const selectedCanonicalSet = useMemo(() => new Set(selectedCanonicalIds), [selectedCanonicalIds]);
  const selectedVisibleCount = visibleCanonicalRows.filter((block) => selectedCanonicalSet.has(block.id)).length;
  const allVisibleSelected = visibleCanonicalRows.length > 0 && selectedVisibleCount === visibleCanonicalRows.length;
  const bulkDisabled = selectedCanonicalIds.length === 0 || bulkAction !== null;

  function toggleCanonicalSelection(id: string, checked: boolean) {
    setSelectedCanonicalIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return Array.from(next);
    });
  }

  function toggleVisibleCanonicalSelection(checked: boolean) {
    setSelectedCanonicalIds((prev) => {
      const next = new Set(prev);
      for (const block of visibleCanonicalRows) {
        if (checked) {
          next.add(block.id);
        } else {
          next.delete(block.id);
        }
      }
      return Array.from(next);
    });
  }

  async function runBulkPolicyCheck() {
    if (selectedCanonicalIds.length === 0) return;
    setBulkAction("policy");
    setBulkMessage(null);
    try {
      const res = await gatewayFetchRaw("/v1/context/canonical-blocks/bulk-policy-check", {
        method: "POST",
        body: JSON.stringify({ blockIds: selectedCanonicalIds }),
      });
      if (!res.ok) throw new Error("Failed to run bulk policy checks");
      const body = await res.json() as { results: BulkCanonicalResult[] };
      const updates = new Map(body.results.filter((result) => result.ok && result.canonicalBlock).map((result) => [result.id, result.canonicalBlock as ContextCanonicalBlock]));
      setState((prev) => ({
        ...prev,
        canonicalBlocks: prev.canonicalBlocks.map((block) => updates.get(block.id) ?? block),
      }));
      const failed = body.results.filter((result) => !result.ok).length;
      setBulkMessage(`Policy checks complete: ${body.results.length - failed} updated, ${failed} failed.`);
    } catch (err) {
      setBulkMessage(err instanceof Error ? err.message : "Failed to run bulk policy checks");
    } finally {
      setBulkAction(null);
    }
  }

  async function runBulkReview(reviewStatus: "approved" | "rejected") {
    if (selectedCanonicalIds.length === 0) return;
    setBulkAction(reviewStatus === "approved" ? "approve" : "reject");
    setBulkMessage(null);
    try {
      const res = await gatewayFetchRaw("/v1/context/canonical-blocks/bulk-review", {
        method: "PATCH",
        body: JSON.stringify({
          blockIds: selectedCanonicalIds,
          reviewStatus,
          note: reviewStatus === "approved" ? "Bulk approved." : "Bulk rejected.",
        }),
      });
      if (!res.ok) throw new Error("Failed to run bulk review");
      const body = await res.json() as { results: BulkCanonicalResult[] };
      const reviewedIds = new Set(body.results.filter((result) => result.ok).map((result) => result.id));
      setState((prev) => ({
        ...prev,
        collections: prev.collections.map((collection, index) => index === 0 && reviewStatus === "approved"
          ? { ...collection, approvedBlockCount: collection.approvedBlockCount + reviewedIds.size }
          : collection),
        canonicalBlocks: prev.canonicalBlocks.filter((block) => !reviewedIds.has(block.id)),
      }));
      setSelectedCanonicalIds((prev) => prev.filter((id) => !reviewedIds.has(id)));
      const failed = body.results.filter((result) => !result.ok).length;
      setBulkMessage(`Bulk ${reviewStatus}: ${reviewedIds.size} updated, ${failed} failed.`);
    } catch (err) {
      setBulkMessage(err instanceof Error ? err.message : "Failed to run bulk review");
    } finally {
      setBulkAction(null);
    }
  }

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

      <OptimizerConfigPanel />

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Managed Collections</h2>
          <p className="mt-1 text-sm text-zinc-500">Persisted context collections for reusable knowledge blocks.</p>
        </div>

        {state.loading ? (
          <LoadingRows />
        ) : collectionRows.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
            No managed context collections yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-950/60 text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Collection</th>
                    <th className="px-4 py-3 text-right font-medium">Documents</th>
                    <th className="px-4 py-3 text-right font-medium">Blocks</th>
                    <th className="px-4 py-3 text-right font-medium">Canonical</th>
                    <th className="px-4 py-3 text-right font-medium">Approved</th>
                    <th className="px-4 py-3 text-right font-medium">Tokens</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {collectionRows.map((collection) => (
                    <tr key={collection.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-zinc-200">{collection.name}</div>
                        <div className="mt-1 max-w-xl truncate text-xs text-zinc-500">
                          {collection.description || collection.id}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(collection.documentCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(collection.blockCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(collection.canonicalBlockCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-emerald-300">
                        {formatInteger(collection.approvedBlockCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-emerald-300">
                        {formatInteger(collection.tokenCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="rounded border border-emerald-900/70 bg-emerald-950/20 px-2 py-0.5 text-xs capitalize text-emerald-200">
                          {collection.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-400">
                        {formatTimestamp(collection.updatedAt)}
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
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Canonical Review Queue</h2>
            <p className="mt-1 text-sm text-zinc-500">Draft canonical blocks awaiting approval.</p>
          </div>
          {canonicalRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500">{selectedCanonicalIds.length} selected</span>
              <button
                type="button"
                className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={bulkDisabled}
                onClick={() => void runBulkPolicyCheck()}
              >
                {bulkAction === "policy" ? "Checking..." : "Run Policy Check"}
              </button>
              <button
                type="button"
                className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={bulkDisabled}
                onClick={() => void runBulkReview("approved")}
              >
                {bulkAction === "approve" ? "Approving..." : "Approve"}
              </button>
              <button
                type="button"
                className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={bulkDisabled}
                onClick={() => void runBulkReview("rejected")}
              >
                {bulkAction === "reject" ? "Rejecting..." : "Reject"}
              </button>
            </div>
          )}
        </div>
        {bulkMessage && (
          <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">
            {bulkMessage}
          </div>
        )}

        {state.loading ? (
          <LoadingRows />
        ) : canonicalRows.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
            No draft canonical blocks in the first managed collection.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-950/60 text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">
                      <input
                        aria-label="Select visible canonical blocks"
                        type="checkbox"
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                        checked={allVisibleSelected}
                        onChange={(event) => toggleVisibleCanonicalSelection(event.target.checked)}
                      />
                    </th>
                    <th className="px-4 py-3 text-left font-medium">Content</th>
                    <th className="px-4 py-3 text-right font-medium">Sources</th>
                    <th className="px-4 py-3 text-right font-medium">Tokens</th>
                    <th className="px-4 py-3 text-left font-medium">Policy</th>
                    <th className="px-4 py-3 text-left font-medium">Evidence</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {visibleCanonicalRows.map((block) => (
                    <tr key={block.id}>
                      <td className="px-4 py-3 align-top">
                        <input
                          aria-label={`Select canonical block ${block.id}`}
                          type="checkbox"
                          className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                          checked={selectedCanonicalSet.has(block.id)}
                          onChange={(event) => toggleCanonicalSelection(block.id, event.target.checked)}
                        />
                      </td>
                      <td className="max-w-3xl px-4 py-3 text-zinc-300">
                        <div className="line-clamp-2">{block.content}</div>
                        {block.reviewNote && <div className="mt-1 text-xs text-zinc-500">{block.reviewNote}</div>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(block.sourceCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(block.tokenCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className={`rounded border px-2 py-0.5 text-xs capitalize ${
                          block.policyStatus === "passed"
                            ? "border-emerald-900/70 bg-emerald-950/20 text-emerald-200"
                            : block.policyStatus === "failed"
                              ? "border-red-900/70 bg-red-950/20 text-red-200"
                              : "border-zinc-700 bg-zinc-950/40 text-zinc-400"
                        }`}>
                          {block.policyStatus}
                        </span>
                      </td>
                      <td className="max-w-sm px-4 py-3 text-xs text-zinc-400">
                        {block.policyDetails.length > 0 ? (
                          <div className="line-clamp-2">
                            {block.policyDetails[0].ruleName ?? block.policyDetails[0].decision}
                            {block.policyDetails[0].matchedSnippet ? `: ${block.policyDetails[0].matchedSnippet}` : ""}
                          </div>
                        ) : (
                          <span className="text-zinc-600">No evidence</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="rounded border border-amber-900/70 bg-amber-950/20 px-2 py-0.5 text-xs capitalize text-amber-200">
                          {block.reviewStatus}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-400">
                        {formatTimestamp(block.updatedAt)}
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
          <h2 className="text-lg font-semibold text-zinc-100">Retrieval Analytics</h2>
          <p className="mt-1 text-sm text-zinc-500">Context usage and retrieval health.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
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
            label="Relevance"
            value={formatRelevance(retrievalSummary?.avgRelevanceScore)}
            detail={`${formatInteger(retrievalSummary?.lowRelevanceChunks ?? 0)} low, ${formatInteger(retrievalSummary?.rerankedChunks ?? 0)} reranked`}
            tone={metricTone(retrievalSummary?.avgRelevanceScore ?? 0)}
          />
          <StatTile
            label="Freshness"
            value={formatRelevance(retrievalSummary?.avgFreshnessScore)}
            detail={`${formatInteger(retrievalSummary?.staleChunks ?? 0)} stale chunks`}
            tone={riskTone(retrievalSummary?.staleChunks ?? 0)}
          />
          <StatTile
            label="Conflicts"
            value={formatInteger(retrievalSummary?.conflictChunks ?? 0)}
            detail={`${formatInteger(retrievalSummary?.conflictGroups ?? 0)} conflict groups`}
            tone={riskTone(retrievalSummary?.conflictChunks ?? 0)}
          />
          <StatTile
            label="Compression"
            value={formatInteger(retrievalSummary?.compressionSavedTokens ?? 0)}
            detail={`${formatInteger(retrievalSummary?.compressedChunks ?? 0)} compressed chunks`}
            tone={metricTone(retrievalSummary?.compressionSavedTokens ?? 0)}
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <StatTile
            label="Duplicate Rate"
            value={formatPercent(retrievalSummary?.duplicateRatePct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.duplicateChunks ?? 0)} total duplicate chunks`}
            tone={riskTone(retrievalSummary?.duplicateChunks ?? 0)}
          />
          <StatTile
            label="Semantic Rate"
            value={formatPercent(retrievalSummary?.nearDuplicateRatePct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.nearDuplicateChunks ?? 0)} near-duplicate chunks`}
            tone={riskTone(retrievalSummary?.nearDuplicateChunks ?? 0)}
          />
          <StatTile
            label="Risky Context Rate"
            value={formatPercent(retrievalSummary?.riskyRatePct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.riskyChunks ?? 0)} risky chunks`}
            tone={riskTone(retrievalSummary?.riskyChunks ?? 0)}
          />
          <StatTile
            label="Conflict Rate"
            value={formatPercent(retrievalSummary?.conflictRatePct ?? 0)}
            detail={`${formatInteger(retrievalSummary?.conflictChunks ?? 0)} conflicting chunks`}
            tone={riskTone(retrievalSummary?.conflictChunks ?? 0)}
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
                    <th className="px-4 py-3 text-right font-medium">Relevance</th>
                    <th className="px-4 py-3 text-right font-medium">Freshness</th>
                    <th className="px-4 py-3 text-right font-medium">Conflicts</th>
                    <th className="px-4 py-3 text-right font-medium">Duplicates</th>
                    <th className="px-4 py-3 text-right font-medium">Semantic</th>
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
                        {formatRelevance(event.avgRelevanceScore)}
                        <span className="ml-2 text-xs text-zinc-500">
                          {formatInteger(event.lowRelevanceChunks)} low
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatRelevance(event.avgFreshnessScore)}
                        <span className="ml-2 text-xs text-zinc-500">
                          {formatInteger(event.staleChunks)} stale
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-amber-300">
                        {formatInteger(event.conflictChunks)}
                        <span className="ml-2 text-xs text-zinc-500">{formatPercent(event.conflictRatePct)}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(event.duplicateChunks)}
                        <span className="ml-2 text-xs text-zinc-500">{formatPercent(event.duplicateRatePct)}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                        {formatInteger(event.nearDuplicateChunks)}
                        <span className="ml-2 text-xs text-zinc-500">{formatPercent(event.nearDuplicateRatePct)}</span>
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
                    <th className="px-4 py-3 text-right font-medium">Semantic</th>
                    <th className="px-4 py-3 text-right font-medium">Relevance</th>
                    <th className="px-4 py-3 text-right font-medium">Freshness</th>
                    <th className="px-4 py-3 text-right font-medium">Conflicts</th>
                    <th className="px-4 py-3 text-right font-medium">Risk</th>
                    <th className="px-4 py-3 text-right font-medium">Saved</th>
                    <th className="px-4 py-3 text-left font-medium">Duplicate IDs</th>
                    <th className="px-4 py-3 text-left font-medium">Risky IDs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {eventRows.map((event) => {
                    const riskyChunks = event.flaggedChunks + event.quarantinedChunks;
                    const topConflict = event.conflictDetails
                      .slice()
                      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
                    return (
                      <tr key={event.id}>
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-300">{formatTimestamp(event.createdAt)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatInteger(event.inputChunks)} {"->"} {formatInteger(event.outputChunks)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatInteger(event.droppedChunks)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatInteger(event.nearDuplicateChunks)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatRelevance(event.avgRelevanceScore)}
                          <span className="ml-2 text-xs text-zinc-500">
                            {formatInteger(event.rerankedChunks)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-zinc-300">
                          {formatRelevance(event.avgFreshnessScore)}
                          <span className="ml-2 text-xs text-zinc-500">
                            {formatInteger(event.staleChunks)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-amber-300">
                          {formatInteger(event.conflictChunks)}
                          <span className="ml-2 text-xs text-zinc-500">
                            {formatInteger(event.conflictGroups)}
                          </span>
                          {topConflict ? (
                            <span className={`ml-2 text-xs uppercase ${conflictSeverityTone(topConflict.severity)}`}>
                              {topConflict.severity ?? "scored"} {topConflict.score !== undefined ? topConflict.score.toFixed(2) : ""}
                            </span>
                          ) : null}
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
                          {[...event.duplicateSourceIds, ...event.nearDuplicateSourceIds].length === 0 ? (
                            <span className="text-zinc-600">None</span>
                          ) : (
                            <div className="flex max-w-xl flex-wrap gap-1">
                              {event.duplicateSourceIds.slice(0, 6).map((id) => (
                                <span key={id} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-300">
                                  {id}
                                </span>
                              ))}
                              {event.nearDuplicateSourceIds.slice(0, Math.max(0, 6 - event.duplicateSourceIds.length)).map((id) => (
                                <span key={id} className="rounded border border-cyan-800/80 bg-cyan-950/20 px-2 py-0.5 font-mono text-xs text-cyan-200">
                                  {id}
                                </span>
                              ))}
                              {event.duplicateSourceIds.length + event.nearDuplicateSourceIds.length > 6 && (
                                <span className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-500">
                                  +{event.duplicateSourceIds.length + event.nearDuplicateSourceIds.length - 6}
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
