"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../../lib/gateway-client";

// ---- Lightweight word-level diff ----
type DiffOp = "equal" | "insert" | "delete";
interface DiffSegment { op: DiffOp; text: string }

function wordDiff(a: string, b: string): DiffSegment[] {
  const wordsA = a.split(/(\s+)/);
  const wordsB = b.split(/(\s+)/);
  const n = wordsA.length;
  const m = wordsB.length;

  // LCS via Myers-style DP (fine for typical LLM response lengths)
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (wordsA[i] === wordsB[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0, j = 0;

  function push(op: DiffOp, text: string) {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.op === op) {
      last.text += text;
    } else {
      segments.push({ op, text });
    }
  }

  while (i < n && j < m) {
    if (wordsA[i] === wordsB[j]) {
      push("equal", wordsA[i]);
      i++; j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      push("delete", wordsA[i]);
      i++;
    } else {
      push("insert", wordsB[j]);
      j++;
    }
  }
  while (i < n) { push("delete", wordsA[i]); i++; }
  while (j < m) { push("insert", wordsB[j]); j++; }

  return segments;
}

function DiffView({ original, replay }: { original: string; replay: string }) {
  const segments = useMemo(() => wordDiff(original, replay), [original, replay]);

  return (
    <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed p-3">
      {segments.map((seg, i) => {
        if (seg.op === "equal") {
          return <span key={i} className="text-zinc-300">{seg.text}</span>;
        }
        if (seg.op === "delete") {
          return <span key={i} className="bg-red-900/40 text-red-300 line-through decoration-red-500/50">{seg.text}</span>;
        }
        return <span key={i} className="bg-emerald-900/40 text-emerald-300">{seg.text}</span>;
      })}
    </pre>
  );
}

interface RequestDetail {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  cost: number | null;
  taskType: string | null;
  complexity: string | null;
  routedBy: string | null;
  tenantId: string | null;
  abTestId: string | null;
  createdAt: string;
}

interface FeedbackEntry {
  id: string;
  score: number;
  comment: string | null;
  source: string;
  createdAt: string;
}

interface ReplayResult {
  model: string;
  provider: string;
  content: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-emerald-900/40 text-emerald-300 border-emerald-800/50",
  anthropic: "bg-orange-900/40 text-orange-300 border-orange-800/50",
  google: "bg-blue-900/40 text-blue-300 border-blue-800/50",
  mistral: "bg-purple-900/40 text-purple-300 border-purple-800/50",
  xai: "bg-cyan-900/40 text-cyan-300 border-cyan-800/50",
  zai: "bg-pink-900/40 text-pink-300 border-pink-800/50",
  ollama: "bg-zinc-800 text-zinc-300 border-zinc-700",
};

function formatCost(cost: number | null): string {
  if (cost === null || cost === 0) return "--";
  if (cost < 0.001) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

function formatMessages(promptJson: string): { role: string; content: string }[] {
  try {
    const parsed = JSON.parse(promptJson);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [{ role: "user", content: promptJson }];
}

export default function RequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Replay state
  const [replayModel, setReplayModel] = useState("");
  const [replayModels, setReplayModels] = useState<{ provider: string; model: string }[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [viewMode, setViewMode] = useState<"side-by-side" | "diff">("side-by-side");

  useEffect(() => {
    gatewayClientFetch<{ request: RequestDetail; feedback: FeedbackEntry[] }>(
      `/v1/analytics/requests/${id}`
    )
      .then((data) => {
        setRequest(data.request);
        setFeedbackEntries(data.feedback || []);
      })
      .catch(() => router.push("/dashboard/logs"))
      .finally(() => setLoading(false));

    // Fetch available models for replay
    gatewayClientFetch<{ models: { provider: string; model: string }[] }>("/v1/models/pricing")
      .then((data) => setReplayModels(data.models || []))
      .catch(() => {});
  }, [id, router]);

  async function handleReplay() {
    if (!request || !replayModel) return;
    setReplaying(true);
    setReplayResult(null);

    try {
      const messages = formatMessages(request.prompt);
      const start = performance.now();
      const res = await gatewayFetchRaw("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: replayModel,
          messages,
        }),
      });
      const latencyMs = Math.round(performance.now() - start);
      const data = await res.json();

      setReplayResult({
        model: data.model || replayModel,
        provider: data._provara?.provider || "unknown",
        content: data.choices?.[0]?.message?.content || "(empty response)",
        latencyMs,
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      });
    } catch (err) {
      console.error("Replay failed:", err);
    } finally {
      setReplaying(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading request...</p>
      </div>
    );
  }

  if (!request) return null;

  const messages = formatMessages(request.prompt);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/logs"
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </Link>
        <h1 className="text-xl font-bold">Request Detail</h1>
        <code className="text-xs text-zinc-600 font-mono">{request.id}</code>
      </div>

      {/* Metadata grid */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Provider / Model</p>
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${PROVIDER_COLORS[request.provider] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}>
                {request.provider}
              </span>
              <span className="text-sm font-mono text-zinc-300">{request.model}</span>
            </div>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Latency</p>
            <p className="text-sm text-zinc-300">
              {request.latencyMs ? `${request.latencyMs.toLocaleString()}ms` : "--"}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Cost</p>
            <p className="text-sm text-zinc-300">{formatCost(request.cost)}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Timestamp</p>
            <p className="text-sm text-zinc-300">
              {new Date(request.createdAt).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Input Tokens</p>
            <p className="text-sm text-zinc-300">{request.inputTokens?.toLocaleString() || "--"}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Output Tokens</p>
            <p className="text-sm text-zinc-300">{request.outputTokens?.toLocaleString() || "--"}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Routing</p>
            <div className="flex items-center gap-1.5">
              {request.routedBy && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-800/50">
                  {request.routedBy}
                </span>
              )}
              {request.taskType && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                  {request.taskType}
                </span>
              )}
              {request.complexity && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700/50">
                  {request.complexity}
                </span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Quality</p>
            {feedbackEntries.length > 0 ? (
              <div className="flex items-center gap-2">
                {feedbackEntries.map((f) => (
                  <span
                    key={f.id}
                    className={`text-xs font-medium ${
                      f.score >= 4 ? "text-emerald-400" : f.score >= 3 ? "text-yellow-400" : "text-red-400"
                    }`}
                  >
                    {f.score}/5
                    <span className="text-zinc-600 ml-1">({f.source})</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-zinc-600">--</span>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-400">Messages</h2>
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`rounded-lg border p-4 ${
              msg.role === "assistant"
                ? "bg-zinc-900 border-zinc-800"
                : msg.role === "system"
                ? "bg-zinc-900/50 border-zinc-800/50"
                : "bg-zinc-900 border-zinc-800"
            }`}
          >
            <p className={`text-[10px] font-semibold uppercase tracking-widest mb-2 ${
              msg.role === "user" ? "text-blue-400" : msg.role === "assistant" ? "text-emerald-400" : "text-zinc-500"
            }`}>
              {msg.role}
            </p>
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
              {msg.content}
            </pre>
          </div>
        ))}
      </div>

      {/* Response */}
      {request.response && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400">Response</h2>
          <div className="bg-zinc-900 border border-emerald-900/30 rounded-lg p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-2 text-emerald-400">
              assistant
            </p>
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
              {request.response}
            </pre>
          </div>
        </div>
      )}

      {/* Replay */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-400">Replay</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
          <p className="text-xs text-zinc-500">
            Send the same prompt to a different model and compare results.
          </p>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs text-zinc-500 mb-1">Target Model</label>
              <select
                value={replayModel}
                onChange={(e) => setReplayModel(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-blue-500"
              >
                <option value="">Select a model...</option>
                {replayModels.map((m) => (
                  <option key={`${m.provider}/${m.model}`} value={m.model}>
                    {m.provider} / {m.model}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleReplay}
              disabled={!replayModel || replaying}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {replaying ? "Replaying..." : "Replay"}
            </button>
          </div>

          {/* Replay result */}
          {replayResult && (
            <div className="pt-4 border-t border-zinc-800 space-y-3">
              {/* View mode toggle + stats */}
              <div className="flex items-center justify-between">
                <div className="flex gap-1 bg-zinc-800 rounded-md p-0.5">
                  <button
                    onClick={() => setViewMode("side-by-side")}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${viewMode === "side-by-side" ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Side by Side
                  </button>
                  <button
                    onClick={() => setViewMode("diff")}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${viewMode === "diff" ? "bg-zinc-700 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Diff
                  </button>
                </div>
                <div className="flex gap-4 text-[10px] text-zinc-500">
                  <span>Original: {request.latencyMs}ms, {request.inputTokens}/{request.outputTokens} tok, {formatCost(request.cost)}</span>
                  <span>Replay: {replayResult.latencyMs}ms, {replayResult.inputTokens}/{replayResult.outputTokens} tok</span>
                </div>
              </div>

              {viewMode === "side-by-side" ? (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs font-semibold text-zinc-400 mb-2">Original — {request.provider}/{request.model}</p>
                    <div className="bg-zinc-800/50 border border-zinc-700/50 rounded p-3 max-h-96 overflow-y-auto">
                      <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                        {request.response || "(no response)"}
                      </pre>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-blue-400 mb-2">Replay — {replayResult.provider}/{replayResult.model}</p>
                    <div className="bg-zinc-800/50 border border-blue-900/30 rounded p-3 max-h-96 overflow-y-auto">
                      <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                        {replayResult.content}
                      </pre>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-4 mb-2">
                    <p className="text-xs font-semibold text-zinc-400">
                      <span className="text-red-400">Original</span> vs <span className="text-emerald-400">Replay ({replayResult.provider}/{replayResult.model})</span>
                    </p>
                  </div>
                  <div className="bg-zinc-800/50 border border-zinc-700/50 rounded max-h-96 overflow-y-auto">
                    <DiffView
                      original={request.response || "(no response)"}
                      replay={replayResult.content}
                    />
                  </div>
                  <div className="flex gap-4 mt-2 text-[10px] text-zinc-600">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-2 rounded-sm bg-red-900/40 border border-red-800/30" />
                      Removed from original
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-2 rounded-sm bg-emerald-900/40 border border-emerald-800/30" />
                      Added in replay
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
