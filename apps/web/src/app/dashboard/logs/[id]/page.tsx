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
  usedFallback: boolean;
  cached: boolean;
  fallbackErrors: string | null;
  tenantId: string | null;
  abTestId: string | null;
  createdAt: string;
}

interface FallbackError {
  provider: string;
  model: string;
  error: string;
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

type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type StoredMessage = { role: string; content: string | MessageContentPart[] };

function formatMessages(promptJson: string): StoredMessage[] {
  try {
    const parsed = JSON.parse(promptJson);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [{ role: "user", content: promptJson }];
}

/** Render a message's content. Text stays as a wrapped <pre>; image_url parts
 *  render as thumbnails that click-to-expand. Data URIs render inline (already
 *  local to the browser); http(s) URLs render as a link with the domain shown
 *  — the browser fetches, the dashboard server never sees the bytes. */
function MessageContent({ content }: { content: string | MessageContentPart[] }) {
  if (typeof content === "string") {
    return (
      <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
        {content}
      </pre>
    );
  }
  return (
    <div className="space-y-3">
      {content.map((part, i) => {
        if (part.type === "text") {
          return (
            <pre key={i} className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
              {part.text}
            </pre>
          );
        }
        if (part.type === "image_url") {
          const url = part.image_url.url;
          const isDataUri = url.startsWith("data:");
          const label = isDataUri
            ? url.slice(0, 30) + "…"
            : (() => {
                try { return new URL(url).hostname; } catch { return "external image"; }
              })();
          return (
            <div key={i} className="space-y-1">
              <p className="text-xs text-zinc-500 font-mono">image · {label}</p>
              <a href={url} target="_blank" rel="noopener noreferrer">
                <img
                  src={url}
                  alt="prompt attachment"
                  loading="lazy"
                  className="max-h-64 rounded border border-zinc-700 object-contain bg-zinc-800"
                />
              </a>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export default function RequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Replay state
  // Replay state
  const [replayModel, setReplayModel] = useState("");
  const [replayModels, setReplayModels] = useState<{ provider: string; model: string }[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [viewMode, setViewMode] = useState<"side-by-side" | "diff">("side-by-side");

  // Manual feedback state
  const [feedbackScore, setFeedbackScore] = useState<number>(0);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

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
      // Preserve the original request's cell so the replay's EMA signal
      // lands where it belongs. Without these hints the router falls into
      // its "model-only pin" branch and defaults to general/medium,
      // polluting that cell with misclassified samples (#113).
      const replayBody: Record<string, unknown> = {
        model: replayModel,
        messages,
      };
      if (request.taskType) replayBody.routing_hint = request.taskType;
      if (request.complexity) replayBody.complexity_hint = request.complexity;
      const res = await gatewayFetchRaw("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(replayBody),
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
        <Link
          href={`/dashboard/playground?forkFrom=${request.id}`}
          className="ml-auto px-3 py-1.5 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 inline-flex items-center gap-1.5"
          title="Open this request in the Playground with messages + model pre-filled"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8h9M7.5 12h9m-9 4h6M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Fork to Playground
        </Link>
      </div>

      {/* Metadata grid */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Provider / Model</p>
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium border ${PROVIDER_COLORS[request.provider] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}>
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
            <div className="flex items-center gap-1.5 flex-wrap">
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
              {request.cached && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-300 border border-cyan-800/50">
                  cached
                </span>
              )}
              {request.usedFallback && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/50">
                  fallback
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

      {/* Fallback errors (if any attempts failed before success) */}
      {request.fallbackErrors && (() => {
        let errors: FallbackError[] = [];
        try { errors = JSON.parse(request.fallbackErrors); } catch {}
        if (errors.length === 0) return null;
        return (
          <div className="bg-amber-950/20 border border-amber-900/40 rounded-lg p-4 space-y-2">
            <h2 className="text-sm font-semibold text-amber-300">Fallback attempts</h2>
            <p className="text-xs text-amber-400/70">
              These providers were tried first and failed. The gateway then routed to the fallback chain.
            </p>
            <ul className="space-y-1.5">
              {errors.map((e, i) => (
                <li key={i} className="text-xs font-mono">
                  <span className="text-amber-300">{e.provider}/{e.model}</span>
                  <span className="text-zinc-500 mx-2">→</span>
                  <span className="text-zinc-400">{e.error}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

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
            <p className={`text-xs font-semibold uppercase tracking-widest mb-2 ${
              msg.role === "user" ? "text-blue-400" : msg.role === "assistant" ? "text-emerald-400" : "text-zinc-500"
            }`}>
              {msg.role}
            </p>
            <MessageContent content={msg.content} />
          </div>
        ))}
      </div>

      {/* Response */}
      {request.response && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-400">Response</h2>
          <div className="bg-zinc-900 border border-emerald-900/30 rounded-lg p-4">
            <p className="text-xs font-semibold uppercase tracking-widest mb-2 text-emerald-400">
              assistant
            </p>
            <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
              {request.response}
            </pre>
          </div>
        </div>
      )}

      {/* Manual Feedback */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-400">Rate this Response</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          {feedbackSubmitted ? (
            <p className="text-sm text-emerald-400">Feedback submitted. Thanks!</p>
          ) : (
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs text-zinc-500 mb-2">Score</label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setFeedbackScore(n)}
                      className={`w-9 h-9 rounded-md text-sm font-medium transition-colors ${
                        feedbackScore === n
                          ? n >= 4 ? "bg-emerald-600 text-white" : n >= 3 ? "bg-yellow-600 text-white" : "bg-red-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1">
                <label className="block text-xs text-zinc-500 mb-2">Comment (optional)</label>
                <input
                  type="text"
                  value={feedbackComment}
                  onChange={(e) => setFeedbackComment(e.target.value)}
                  placeholder="What did you think?"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-blue-500"
                />
              </div>
              <button
                onClick={async () => {
                  if (!feedbackScore) return;
                  setSubmittingFeedback(true);
                  try {
                    await gatewayFetchRaw("/v1/feedback", {
                      method: "POST",
                      body: JSON.stringify({
                        requestId: request.id,
                        score: feedbackScore,
                        comment: feedbackComment || undefined,
                      }),
                    });
                    setFeedbackSubmitted(true);
                  } catch (err) {
                    console.error("Failed to submit feedback:", err);
                  } finally {
                    setSubmittingFeedback(false);
                  }
                }}
                disabled={!feedbackScore || submittingFeedback}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
              >
                {submittingFeedback ? "..." : "Submit"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Replay */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-400">Replay</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
          <p className="text-xs text-zinc-500">
            Send the same prompt to a different model and compare results.
            {request.taskType && request.complexity && (
              <> Ratings on this replay train the <code className="text-zinc-400">{request.taskType}/{request.complexity}</code> cell, matching the original.</>
            )}
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
                <div className="flex gap-4 text-xs text-zinc-500">
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
                  <div className="flex gap-4 mt-2 text-xs text-zinc-600">
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
