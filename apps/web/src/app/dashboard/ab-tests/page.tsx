"use client";

import { useEffect, useState } from "react";
import { formatCost, formatLatency, formatNumber } from "../../../lib/format";
import { gatewayFetchRaw } from "../../../lib/gateway-client";

interface AbTest {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "paused" | "completed";
  createdAt: string;
}

interface AbVariant {
  id: string;
  abTestId: string;
  provider: string;
  model: string;
  weight: number;
  taskType: string | null;
  complexity: string | null;
}

interface VariantResult {
  provider: string;
  model: string;
  count: number;
  avgLatency: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalCost: number;
  avgScore: number | null;
  feedbackCount: number;
}

interface TestDetail {
  test: AbTest;
  variants: AbVariant[];
  results: VariantResult[];
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-900/50 text-emerald-300",
  paused: "bg-yellow-900/50 text-yellow-300",
  completed: "bg-zinc-800 text-zinc-400",
};

interface ProviderInfo {
  name: string;
  models: string[];
}

function CreateTestForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState("");
  const [complexity, setComplexity] = useState("");
  const [variants, setVariants] = useState([
    { provider: "", model: "", weight: 1 },
    { provider: "", model: "", weight: 1 },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    if (open && providers.length === 0) {
      gatewayFetchRaw("/v1/providers")
        .then((r) => r.json())
        .then((d) => setProviders(d.providers || []))
        .catch(() => {});
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await gatewayFetchRaw("/v1/ab-tests", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: description || undefined,
          taskType: taskType || undefined,
          complexity: complexity || undefined,
          variants: variants.filter((v) => v.provider && v.model),
        }),
      });
      setName("");
      setDescription("");
      setTaskType("");
      setComplexity("");
      setVariants([
        { provider: "", model: "", weight: 1 },
        { provider: "", model: "", weight: 1 },
      ]);
      setOpen(false);
      onCreated();
    } catch (err) {
      console.error("Failed to create test:", err);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
      >
        New A/B Test
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Create A/B Test</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. GPT-4o vs Claude Sonnet for coding"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Task Type (scope)</label>
          <select
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="">All task types</option>
            <option value="coding">Coding</option>
            <option value="creative">Creative</option>
            <option value="summarization">Summarization</option>
            <option value="qa">Q&A</option>
            <option value="general">General</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Complexity (scope)</label>
          <select
            value={complexity}
            onChange={(e) => setComplexity(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="">All complexities</option>
            <option value="simple">Simple</option>
            <option value="medium">Medium</option>
            <option value="complex">Complex</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-2">Variants</label>
        <div className="space-y-2">
          <div className="flex gap-2 items-center text-xs text-zinc-500">
            <span className="flex-1">Provider</span>
            <span className="flex-1">Model</span>
            <span className="w-20">Weight</span>
            <span className="w-16"></span>
          </div>
          {variants.map((v, i) => {
            const selectedProvider = providers.find((p) => p.name === v.provider);
            return (
              <div key={i} className="flex gap-2 items-center">
                <select
                  value={v.provider}
                  onChange={(e) => {
                    const next = [...variants];
                    next[i] = { ...next[i], provider: e.target.value, model: "" };
                    setVariants(next);
                  }}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select provider</option>
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={v.model}
                  onChange={(e) => {
                    const next = [...variants];
                    next[i] = { ...next[i], model: e.target.value };
                    setVariants(next);
                  }}
                  disabled={!v.provider}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">Select model</option>
                  {(selectedProvider?.models || []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={v.weight}
                  onChange={(e) => {
                    const next = [...variants];
                    next[i] = { ...next[i], weight: parseFloat(e.target.value) || 0 };
                    setVariants(next);
                  }}
                  title="Traffic weight"
                  className="w-20 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                />
                {variants.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                    className="text-zinc-500 hover:text-red-400 text-sm w-16 text-right"
                  >
                    Remove
                  </button>
                ) : (
                  <span className="w-16"></span>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setVariants([...variants, { provider: "", model: "", weight: 1 }])}
          className="mt-2 text-sm text-blue-400 hover:text-blue-300"
        >
          + Add variant
        </button>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
      >
        {submitting ? "Creating..." : "Create Test"}
      </button>
    </form>
  );
}

interface AbTestRequest {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  response: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  cost: number | null;
  createdAt: string;
  feedbackScore: number | null;
  feedbackComment: string | null;
  feedbackSource: string | null;
}

function FeedbackButtons({ requestId, currentScore, onScored }: { requestId: string; currentScore: number | null; onScored: () => void }) {
  const [submitting, setSubmitting] = useState(false);

  async function submitScore(score: number) {
    setSubmitting(true);
    try {
      await gatewayFetchRaw("/v1/feedback", {
        method: "POST",
        body: JSON.stringify({ requestId, score }),
      });
      onScored();
    } catch (err) {
      console.error("Failed to submit feedback:", err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((score) => (
        <button
          key={score}
          onClick={() => submitScore(score)}
          disabled={submitting}
          className={`w-7 h-7 rounded text-xs font-medium transition-colors ${
            currentScore === score
              ? "bg-blue-600 text-white"
              : "bg-zinc-800 border border-zinc-700 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          } disabled:opacity-50`}
        >
          {score}
        </button>
      ))}
    </div>
  );
}

function RequestRow({ req, onFeedback }: { req: AbTestRequest; onFeedback: () => void }) {
  const [expanded, setExpanded] = useState(false);

  let messages: { role: string; content: string }[] = [];
  try {
    messages = JSON.parse(req.prompt);
  } catch {
    messages = [{ role: "user", content: req.prompt }];
  }
  const lastMessage = messages[messages.length - 1];

  return (
    <>
      <tr
        className="border-t border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-2 font-mono text-xs">{req.provider}/{req.model}</td>
        <td className="py-2 text-xs text-zinc-400 max-w-xs truncate">
          {lastMessage?.content?.slice(0, 80) || "—"}
          {(lastMessage?.content?.length || 0) > 80 ? "..." : ""}
        </td>
        <td className="py-2 text-right text-zinc-400 text-xs">{req.latencyMs ? formatLatency(req.latencyMs) : "—"}</td>
        <td className="py-2 text-right text-zinc-400 text-xs">{req.cost != null ? formatCost(req.cost) : "—"}</td>
        <td className="py-2 text-right">
          <FeedbackButtons requestId={req.id} currentScore={req.feedbackScore} onScored={onFeedback} />
        </td>
        <td className="py-2 text-right text-zinc-500 text-xs">{expanded ? "▾" : "▸"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="px-4 py-3 bg-zinc-800/20">
            <div className="space-y-3">
              <div>
                <p className="text-xs text-zinc-500 mb-1">Prompt</p>
                {messages.map((m, i) => (
                  <div key={i} className="mb-2">
                    <span className="text-xs text-zinc-500 capitalize">{m.role}: </span>
                    <span className="text-xs text-zinc-300 whitespace-pre-wrap">{m.content}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1">Response</p>
                <p className="text-xs text-zinc-300 whitespace-pre-wrap">{req.response || "—"}</p>
              </div>
              {req.feedbackComment && (
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Feedback Comment</p>
                  <p className="text-xs text-zinc-300">{req.feedbackComment}</p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TestCard({ test, onUpdate }: { test: AbTest; onUpdate: () => void }) {
  const [detail, setDetail] = useState<TestDetail | null>(null);
  const [testRequests, setTestRequests] = useState<AbTestRequest[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showRequests, setShowRequests] = useState(false);

  async function fetchDetail() {
    const res = await gatewayFetchRaw(`/v1/ab-tests/${test.id}`);
    const data = await res.json();
    setDetail(data);
  }

  async function fetchRequests() {
    const res = await gatewayFetchRaw(`/v1/ab-tests/${test.id}/requests?limit=20`);
    const data = await res.json();
    setTestRequests(data.requests || []);
  }

  async function updateStatus(status: string) {
    await gatewayFetchRaw(`/v1/ab-tests/${test.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    onUpdate();
  }

  useEffect(() => {
    if (expanded) {
      fetchDetail();
      fetchRequests();
    }
  }, [expanded]);

  function handleFeedbackUpdate() {
    fetchDetail();
    fetchRequests();
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-800/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[test.status]}`}>
            {test.status}
          </span>
          <span className="font-medium">{test.name}</span>
          {test.description && <span className="text-zinc-500 text-sm">{test.description}</span>}
        </div>
        <span className="text-zinc-500 text-sm">{expanded ? "▾" : "▸"}</span>
      </div>

      {expanded && detail && (
        <div className="border-t border-zinc-800 px-4 py-4 space-y-4">
          {/* Actions */}
          <div className="flex gap-2">
            {test.status === "active" && (
              <button onClick={() => updateStatus("paused")} className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 rounded text-xs">
                Pause
              </button>
            )}
            {test.status === "paused" && (
              <button onClick={() => updateStatus("active")} className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs">
                Resume
              </button>
            )}
            {test.status !== "completed" && (
              <button onClick={() => updateStatus("completed")} className="px-3 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs">
                Complete
              </button>
            )}
          </div>

          {/* Variants */}
          <div>
            <h4 className="text-sm font-medium text-zinc-400 mb-2">Variants</h4>
            <div className="grid grid-cols-2 gap-2">
              {detail.variants.map((v) => (
                <div key={v.id} className="bg-zinc-800 rounded p-3 text-sm">
                  <p className="font-mono text-xs">{v.provider}/{v.model}</p>
                  <p className="text-zinc-500 text-xs">Weight: {v.weight}</p>
                  {v.taskType && <p className="text-zinc-500 text-xs">Scope: {v.taskType}/{v.complexity}</p>}
                </div>
              ))}
            </div>
          </div>

          {/* Results with quality scores */}
          {detail.results.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-zinc-400 mb-2">Results</h4>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 text-left text-xs">
                    <th className="pb-2">Model</th>
                    <th className="pb-2 text-right">Requests</th>
                    <th className="pb-2 text-right">Avg Latency</th>
                    <th className="pb-2 text-right">Total Cost</th>
                    <th className="pb-2 text-right">Cost/Req</th>
                    <th className="pb-2 text-right">Quality</th>
                    <th className="pb-2 text-right">Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.results.map((r) => (
                    <tr key={`${r.provider}-${r.model}`} className="border-t border-zinc-800/50">
                      <td className="py-2 font-mono text-xs">{r.provider}/{r.model}</td>
                      <td className="py-2 text-right">{formatNumber(r.count)}</td>
                      <td className="py-2 text-right">{formatLatency(r.avgLatency)}</td>
                      <td className="py-2 text-right">{r.totalCost != null ? formatCost(r.totalCost) : "—"}</td>
                      <td className="py-2 text-right">{r.count > 0 && r.totalCost != null ? formatCost(r.totalCost / r.count) : "—"}</td>
                      <td className="py-2 text-right">
                        {r.avgScore != null ? (
                          <span className={`font-medium ${r.avgScore >= 4 ? "text-emerald-400" : r.avgScore >= 3 ? "text-yellow-400" : "text-red-400"}`}>
                            {r.avgScore.toFixed(1)}/5
                          </span>
                        ) : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="py-2 text-right text-zinc-500 text-xs">{r.feedbackCount || 0} rated</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {detail.results.length === 0 && (
            <p className="text-sm text-zinc-500">No results yet. Send requests through the gateway to collect data.</p>
          )}

          {/* Request evaluation */}
          {testRequests.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-zinc-400">
                  Requests ({testRequests.length})
                </h4>
                <button
                  onClick={() => setShowRequests(!showRequests)}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {showRequests ? "Hide" : "Show requests for evaluation"}
                </button>
              </div>
              {showRequests && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-zinc-500 text-left text-xs">
                      <th className="pb-2">Model</th>
                      <th className="pb-2">Prompt</th>
                      <th className="pb-2 text-right">Latency</th>
                      <th className="pb-2 text-right">Cost</th>
                      <th className="pb-2 text-right">Score</th>
                      <th className="pb-2 w-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {testRequests.map((req) => (
                      <RequestRow key={req.id} req={req} onFeedback={handleFeedbackUpdate} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AbTestsPage() {
  const [tests, setTests] = useState<AbTest[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchTests() {
    try {
      const res = await gatewayFetchRaw("/v1/ab-tests");
      const data = await res.json();
      setTests(data.tests || []);
    } catch (err) {
      console.error("Failed to fetch A/B tests:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTests();
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading A/B tests...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">A/B Tests</h1>
        <CreateTestForm onCreated={fetchTests} />
      </div>

      {tests.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-400">No A/B tests yet. Create one to start comparing models.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tests.map((test) => (
            <TestCard key={test.id} test={test} onUpdate={fetchTests} />
          ))}
        </div>
      )}
    </div>
  );
}
