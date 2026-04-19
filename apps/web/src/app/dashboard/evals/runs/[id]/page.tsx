"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { gatewayClientFetch } from "../../../../../lib/gateway-client";
import { formatCost, formatLatency } from "../../../../../lib/format";

interface Run {
  id: string;
  datasetId: string;
  provider: string;
  model: string;
  status: "queued" | "running" | "completed" | "failed";
  avgScore: number | null;
  totalCost: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface Result {
  id: string;
  caseIndex: number;
  input: string;
  output: string | null;
  score: number | null;
  judgeSource: string | null;
  error: string | null;
  latencyMs: number | null;
  cost: number | null;
  createdAt: string;
}

function scoreColor(score: number | null) {
  if (score === null) return "text-zinc-500";
  if (score >= 4) return "text-emerald-400";
  if (score >= 3) return "text-yellow-400";
  return "text-red-400";
}

function extractPromptPreview(inputJson: string, maxChars = 160): string {
  try {
    const messages = JSON.parse(inputJson) as Array<{ role: string; content: string | unknown[] }>;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return "";
    const content = lastUser.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((p) => {
                const part = p as { type?: string; text?: string };
                return part.type === "text" && part.text ? part.text : part.type === "image_url" ? "[image]" : "";
              })
              .filter(Boolean)
              .join(" ")
          : "";
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  } catch {
    return inputJson.slice(0, maxChars);
  }
}

export default function EvalRunPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [run, setRun] = useState<Run | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [completedCases, setCompletedCases] = useState(0);
  const [totalCases, setTotalCases] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchRun = useCallback(async () => {
    try {
      const data = await gatewayClientFetch<{
        run: Run;
        results: Result[];
        completedCases: number;
      }>(`/v1/evals/runs/${id}`);
      setRun(data.run);
      setResults(data.results);
      setCompletedCases(data.completedCases);
      if (totalCases === null) {
        // Dataset total case count isn't in the run payload; fetch once.
        try {
          const ds = await gatewayClientFetch<{ caseCount: number }>(
            `/v1/evals/datasets/${data.run.datasetId}`,
          );
          setTotalCases(ds.caseCount);
        } catch {
          setTotalCases(data.completedCases);
        }
      }
    } catch {
      router.push("/dashboard/evals");
    }
  }, [id, router, totalCases]);

  useEffect(() => {
    fetchRun();
    // Poll while the run is in flight. Stop once it's terminal.
    const poll = setInterval(() => {
      if (run && (run.status === "completed" || run.status === "failed")) return;
      fetchRun();
    }, 3000);
    return () => clearInterval(poll);
  }, [fetchRun, run]);

  if (!run) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading run…</p>
      </div>
    );
  }

  const progress = totalCases ? (completedCases / totalCases) * 100 : 0;

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/evals" className="text-zinc-500 hover:text-zinc-300">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </Link>
        <h1 className="text-xl font-bold">Eval Run</h1>
        <code className="text-xs text-zinc-600 font-mono">{run.id}</code>
      </div>

      {/* Summary */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-5 grid grid-cols-2 sm:grid-cols-4 gap-6">
        <div>
          <p className="text-xs text-zinc-500 mb-1">Model</p>
          <p className="text-sm font-mono text-zinc-200">{run.provider} / {run.model}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 mb-1">Status</p>
          <p className="text-sm text-zinc-200 capitalize">{run.status}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 mb-1">Avg score</p>
          <p className={`text-lg font-semibold ${scoreColor(run.avgScore)}`}>
            {run.avgScore !== null ? run.avgScore.toFixed(2) : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-zinc-500 mb-1">Total cost</p>
          <p className="text-sm text-zinc-300">{run.totalCost !== null ? formatCost(run.totalCost) : "—"}</p>
        </div>
      </div>

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>
            {completedCases} / {totalCases ?? "?"} cases
          </span>
          <span>{progress.toFixed(0)}%</span>
        </div>
        <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${run.status === "failed" ? "bg-red-600" : "bg-emerald-600"}`}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      </div>

      {/* Results */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest">Cases</h2>
        {results.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg py-10 text-center text-sm text-zinc-500">
            Waiting for first case to complete…
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg divide-y divide-zinc-800/60">
            {results.map((r) => {
              const isOpen = expanded.has(r.id);
              return (
                <div key={r.id}>
                  <button
                    onClick={() => toggle(r.id)}
                    className="w-full px-4 py-3 flex items-center gap-4 hover:bg-zinc-900/80 text-left"
                  >
                    <span className="text-xs text-zinc-600 font-mono w-8">#{r.caseIndex}</span>
                    <span className={`text-sm font-semibold w-10 ${scoreColor(r.score)}`}>
                      {r.score !== null ? `${r.score}/5` : "—"}
                    </span>
                    <span className="flex-1 text-xs text-zinc-400 truncate">
                      {extractPromptPreview(r.input)}
                    </span>
                    <span className="text-xs text-zinc-500 shrink-0">
                      {r.latencyMs !== null ? formatLatency(r.latencyMs) : ""} ·{" "}
                      {r.cost !== null ? formatCost(r.cost) : ""}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-4 py-3 bg-zinc-950/40 border-t border-zinc-800/60 space-y-3 text-xs">
                      <div>
                        <p className="text-zinc-500 mb-1">Input</p>
                        <pre className="text-zinc-300 whitespace-pre-wrap font-mono bg-zinc-900/60 p-2 rounded max-h-48 overflow-y-auto">
                          {r.input}
                        </pre>
                      </div>
                      <div>
                        <p className="text-zinc-500 mb-1">Output</p>
                        <pre className="text-zinc-300 whitespace-pre-wrap font-sans bg-zinc-900/60 p-2 rounded max-h-64 overflow-y-auto">
                          {r.output ?? "(no output)"}
                        </pre>
                      </div>
                      {r.error && (
                        <div>
                          <p className="text-red-400 mb-1">Error</p>
                          <pre className="text-red-300 whitespace-pre-wrap font-mono bg-red-950/30 p-2 rounded">
                            {r.error}
                          </pre>
                        </div>
                      )}
                      {r.judgeSource && (
                        <p className="text-zinc-500">Graded by {r.judgeSource}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
