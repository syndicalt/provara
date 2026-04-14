"use client";

import { useEffect, useState } from "react";
import { formatCost, formatLatency, formatNumber } from "../../../lib/format";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch(`${GATEWAY}/v1/ab-tests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          {variants.map((v, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                value={v.provider}
                onChange={(e) => {
                  const next = [...variants];
                  next[i] = { ...next[i], provider: e.target.value };
                  setVariants(next);
                }}
                placeholder="Provider (e.g. openai)"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
              <input
                value={v.model}
                onChange={(e) => {
                  const next = [...variants];
                  next[i] = { ...next[i], model: e.target.value };
                  setVariants(next);
                }}
                placeholder="Model (e.g. gpt-4o)"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
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
                className="w-20 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
              {variants.length > 2 && (
                <button
                  type="button"
                  onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                  className="text-zinc-500 hover:text-red-400 text-sm"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
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

function TestCard({ test, onUpdate }: { test: AbTest; onUpdate: () => void }) {
  const [detail, setDetail] = useState<TestDetail | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function fetchDetail() {
    const res = await fetch(`${GATEWAY}/v1/ab-tests/${test.id}`);
    const data = await res.json();
    setDetail(data);
  }

  async function updateStatus(status: string) {
    await fetch(`${GATEWAY}/v1/ab-tests/${test.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    onUpdate();
  }

  useEffect(() => {
    if (expanded) fetchDetail();
  }, [expanded]);

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

          {/* Results */}
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
                    <th className="pb-2 text-right">Cost/Request</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.results.map((r) => (
                    <tr key={`${r.provider}-${r.model}`} className="border-t border-zinc-800/50">
                      <td className="py-2 font-mono text-xs">{r.provider}/{r.model}</td>
                      <td className="py-2 text-right">{formatNumber(r.count)}</td>
                      <td className="py-2 text-right">{formatLatency(r.avgLatency)}</td>
                      <td className="py-2 text-right">{formatCost(r.totalCost)}</td>
                      <td className="py-2 text-right">{r.count > 0 ? formatCost(r.totalCost / r.count) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {detail.results.length === 0 && (
            <p className="text-sm text-zinc-500">No results yet. Send requests through the gateway to collect data.</p>
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
      const res = await fetch(`${GATEWAY}/v1/ab-tests`);
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
