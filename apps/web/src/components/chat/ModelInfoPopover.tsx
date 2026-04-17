"use client";

import { useEffect, useRef, useState } from "react";
import { gatewayClientFetch } from "../../lib/gateway-client";

export interface ModelStats {
  provider: string;
  model: string;
  pricing: { inputPer1M: number; outputPer1M: number } | null;
  stats: {
    requestCount: number;
    avgLatency: number;
    avgInputTokens: number;
    avgOutputTokens: number;
  };
  totalCost: number;
  quality: { avgScore: number; feedbackCount: number } | null;
}

interface Props {
  /** Empty provider/model means auto-routing. */
  selectedProvider: string;
  selectedModel: string;
}

/**
 * "ⓘ" button next to the model selector. Click opens a small popover with
 * pricing, historical latency, quality score, and request volume for the
 * currently selected model. For auto-routing, shows a short explainer
 * instead — there's no "selected model" to summarize.
 *
 * Stats are loaded once per mount from /v1/models/stats; no polling. The
 * data is mostly stable (pricing doesn't change, quality EMA moves slowly)
 * so the staleness is fine for an info popover.
 */
export function ModelInfoPopover({ selectedProvider, selectedModel }: Props) {
  const [open, setOpen] = useState(false);
  const [allStats, setAllStats] = useState<ModelStats[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    gatewayClientFetch<{ models: ModelStats[] }>("/v1/models/stats")
      .then((data) => setAllStats(data.models || []))
      .catch(() => {});
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = selectedModel
    ? allStats.find((s) => s.provider === selectedProvider && s.model === selectedModel)
    : undefined;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Model info"
        aria-label="Model info"
        className="w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
      >
        ⓘ
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-10 w-72 rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl p-3 text-xs text-zinc-300">
          {selectedModel ? (
            <SelectedModelCard stats={selected} fallback={{ provider: selectedProvider, model: selectedModel }} />
          ) : (
            <AutoRoutingCard />
          )}
        </div>
      )}
    </div>
  );
}

function SelectedModelCard({
  stats,
  fallback,
}: {
  stats: ModelStats | undefined;
  fallback: { provider: string; model: string };
}) {
  const provider = stats?.provider ?? fallback.provider;
  const model = stats?.model ?? fallback.model;
  return (
    <div className="space-y-2">
      <div>
        <p className="text-zinc-500 text-[10px] uppercase tracking-widest">Model</p>
        <p className="font-mono">{provider} / {model}</p>
      </div>
      <Row label="Input" value={stats?.pricing ? `$${stats.pricing.inputPer1M.toFixed(2)} / 1M tok` : "unknown"} />
      <Row label="Output" value={stats?.pricing ? `$${stats.pricing.outputPer1M.toFixed(2)} / 1M tok` : "unknown"} />
      <Row label="Avg latency" value={stats?.stats.requestCount ? `${stats.stats.avgLatency}ms` : "—"} />
      <Row
        label="Quality (user)"
        value={
          stats?.quality && stats.quality.feedbackCount > 0
            ? `${stats.quality.avgScore.toFixed(2)} / 5 (${stats.quality.feedbackCount})`
            : "no ratings yet"
        }
      />
      <Row label="Requests" value={stats?.stats.requestCount ? String(stats.stats.requestCount) : "0"} />
    </div>
  );
}

function AutoRoutingCard() {
  return (
    <div className="space-y-2">
      <p className="text-zinc-500 text-[10px] uppercase tracking-widest">Routing</p>
      <p className="font-medium text-zinc-200">Auto-routing enabled</p>
      <p className="leading-relaxed">
        The gateway classifies each request and picks the model with the best
        quality-adjusted score in that cell. See <a href="/dashboard/routing" className="text-blue-400 hover:text-blue-300 underline">Routing</a>
        {" "}for the live matrix.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-zinc-500">{label}</span>
      <span className="font-mono text-right">{value}</span>
    </div>
  );
}
