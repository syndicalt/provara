"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";
import { formatCost } from "../../../lib/format";

interface Dataset {
  id: string;
  name: string;
  description: string | null;
  caseCount: number;
  createdAt: string;
}

type Scorer = "llm-judge" | "exact-match" | "regex-match";

interface Run {
  id: string;
  datasetId: string;
  datasetName: string;
  provider: string;
  model: string;
  status: "queued" | "running" | "completed" | "failed";
  avgScore: number | null;
  totalCost: number | null;
  scorer: Scorer;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

const CLASSIFIER_TARGET = "provara/classifier";
const SCORER_LABELS: Record<Scorer, string> = {
  "llm-judge": "LLM judge (1-5)",
  "exact-match": "Exact match (pass/fail)",
  "regex-match": "Regex match (pass/fail)",
};

interface ProviderInfo {
  name: string;
  models: string[];
}

const EXAMPLE_JSONL = `{"input": [{"role": "user", "content": "What's 2+2?"}]}
{"input": [{"role": "user", "content": "Summarize: the sky is blue because of Rayleigh scattering."}]}
{"input": [{"role": "user", "content": "Write a haiku about caching."}]}`;

function StatusBadge({ status }: { status: Run["status"] }) {
  const colors: Record<Run["status"], string> = {
    queued: "bg-zinc-800 text-zinc-300",
    running: "bg-blue-900/40 text-blue-300",
    completed: "bg-emerald-900/40 text-emerald-300",
    failed: "bg-red-900/40 text-red-300",
  };
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[status]}`}>{status}</span>;
}

export default function EvalsPage() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Upload form
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadJsonl, setUploadJsonl] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Run form
  const [runDatasetId, setRunDatasetId] = useState("");
  const [runProviderModel, setRunProviderModel] = useState("");
  const [runScorer, setRunScorer] = useState<Scorer>("llm-judge");
  const [runError, setRunError] = useState<string | null>(null);
  const [runSubmitting, setRunSubmitting] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [d, r, p] = await Promise.all([
        gatewayClientFetch<{ datasets: Dataset[] }>("/v1/evals/datasets"),
        gatewayClientFetch<{ runs: Run[] }>("/v1/evals/runs"),
        gatewayClientFetch<{ providers: ProviderInfo[] }>("/v1/providers"),
      ]);
      setDatasets(d.datasets || []);
      setRuns(r.runs || []);
      setProviders(p.providers || []);
    } catch (err) {
      console.error("evals fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Poll every 5s — runs update incrementally, keeps the UI honest.
    const id = setInterval(fetchAll, 5000);
    return () => clearInterval(id);
  }, [fetchAll]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploading(true);
    try {
      const res = await gatewayFetchRaw("/v1/evals/datasets", {
        method: "POST",
        body: JSON.stringify({
          name: uploadName,
          description: uploadDescription || undefined,
          jsonl: uploadJsonl,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      setUploadOpen(false);
      setUploadName("");
      setUploadDescription("");
      setUploadJsonl("");
      fetchAll();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    setRunError(null);
    if (!runDatasetId || !runProviderModel) {
      setRunError("Pick a dataset and a model");
      return;
    }
    const [provider, ...modelParts] = runProviderModel.split("/");
    const model = modelParts.join("/");
    setRunSubmitting(true);
    try {
      const res = await gatewayFetchRaw("/v1/evals/runs", {
        method: "POST",
        body: JSON.stringify({ datasetId: runDatasetId, provider, model, scorer: runScorer }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      setRunDatasetId("");
      setRunProviderModel("");
      setRunScorer("llm-judge");
      fetchAll();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading evals…</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Evals</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Upload a JSONL dataset, run it against a model, get per-case judge scores. Your golden test set and your prod quality monitor — same loop.
          </p>
        </div>
        <button
          onClick={() => setUploadOpen(!uploadOpen)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-md text-sm font-medium"
        >
          {uploadOpen ? "Cancel" : "Create dataset"}
        </button>
      </div>

      {/* Upload form */}
      {uploadOpen && (
        <form onSubmit={handleUpload} className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-5 space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Name</label>
            <input
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              required
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
              placeholder="e.g. panel-photo-regression-v1"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Description (optional)</label>
            <input
              value={uploadDescription}
              onChange={(e) => setUploadDescription(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
              placeholder="What this dataset covers"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Cases (JSONL — one JSON object per line)</label>
            <textarea
              value={uploadJsonl}
              onChange={(e) => setUploadJsonl(e.target.value)}
              rows={10}
              required
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-xs font-mono"
              placeholder={EXAMPLE_JSONL}
            />
            <p className="mt-1 text-xs text-zinc-600">
              Each line: <code className="text-zinc-400">{`{"input": ChatMessage[], "expected"?: string, "metadata"?: object}`}</code>
            </p>
          </div>
          {uploadError && (
            <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded px-3 py-2">
              {uploadError}
            </div>
          )}
          <button
            type="submit"
            disabled={uploading}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-md text-sm font-medium"
          >
            {uploading ? "Uploading…" : "Create dataset"}
          </button>
        </form>
      )}

      {/* Datasets */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest">Datasets</h2>
        {datasets.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg py-10 text-center text-sm text-zinc-500">
            No datasets yet. Paste JSONL above to get started.
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg divide-y divide-zinc-800/60">
            {datasets.map((d) => (
              <div key={d.id} className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-200 truncate">{d.name}</p>
                  {d.description && <p className="text-xs text-zinc-500 truncate">{d.description}</p>}
                </div>
                <span className="text-xs text-zinc-500 shrink-0">{d.caseCount} cases</span>
                <span className="text-xs text-zinc-600 shrink-0">
                  {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Run form */}
      {datasets.length > 0 && (
        <form onSubmit={handleRun} className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-200">Start a run</h2>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <select
              value={runDatasetId}
              onChange={(e) => setRunDatasetId(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
            >
              <option value="">Dataset…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.caseCount} cases)
                </option>
              ))}
            </select>
            <select
              value={runProviderModel}
              onChange={(e) => setRunProviderModel(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
            >
              <option value="">Target…</option>
              <optgroup label="Provara internals">
                <option value={CLASSIFIER_TARGET}>Provara classifier</option>
              </optgroup>
              {providers.map((p) => (
                <optgroup key={p.name} label={p.name}>
                  {p.models.map((m) => (
                    <option key={`${p.name}/${m}`} value={`${p.name}/${m}`}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              value={runScorer}
              onChange={(e) => setRunScorer(e.target.value as Scorer)}
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
            >
              {(Object.keys(SCORER_LABELS) as Scorer[]).map((s) => (
                <option key={s} value={s}>
                  {SCORER_LABELS[s]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={runSubmitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-sm font-medium"
            >
              {runSubmitting ? "Queuing…" : "Run"}
            </button>
          </div>
          {runProviderModel === CLASSIFIER_TARGET && runScorer === "llm-judge" && (
            <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded px-3 py-2">
              Classifier target outputs a label like <code>coding/medium</code>. Pair it with <strong>Exact match</strong> and set each case's <code>expected</code> to the correct label.
            </div>
          )}
          {runError && (
            <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded px-3 py-2">
              {runError}
            </div>
          )}
        </form>
      )}

      {/* Runs */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest">Recent runs</h2>
        {runs.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg py-10 text-center text-sm text-zinc-500">
            No runs yet.
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Dataset</th>
                  <th className="px-4 py-2 text-left font-medium">Target</th>
                  <th className="px-4 py-2 text-left font-medium">Scorer</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                  <th className="px-4 py-2 text-right font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-900/80 transition-colors">
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/evals/runs/${r.id}`} className="text-blue-400 hover:text-blue-300">
                        {r.datasetName}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-300">
                      {r.provider} / {r.model}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-400">
                      {SCORER_LABELS[r.scorer]?.split(" ")[0] ?? r.scorer}
                    </td>
                    <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-2 text-right text-zinc-300">
                      {r.avgScore === null
                        ? "—"
                        : r.scorer === "llm-judge"
                          ? r.avgScore.toFixed(2)
                          : `${Math.round(((r.avgScore - 1) / 4) * 100)}% pass`}
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-400">
                      {r.totalCost !== null ? formatCost(r.totalCost) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-zinc-500">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
