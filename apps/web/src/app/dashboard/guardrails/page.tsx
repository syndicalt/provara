"use client";

import { useEffect, useState } from "react";
import { gatewayFetchRaw } from "../../../lib/gateway-client";

interface GuardrailRule {
  id: string;
  name: string;
  type: string;
  target: string;
  action: string;
  pattern: string | null;
  enabled: boolean;
  builtIn: boolean;
}

interface GuardrailLog {
  id: string;
  ruleName: string;
  target: string;
  action: string;
  matchedContent: string | null;
  createdAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  block: "bg-red-900/40 text-red-300 border-red-800/50",
  redact: "bg-amber-900/40 text-amber-300 border-amber-800/50",
  flag: "bg-blue-900/40 text-blue-300 border-blue-800/50",
};

const TYPE_LABELS: Record<string, string> = {
  pii: "PII Detection",
  content: "Content Policy",
  regex: "Custom Regex",
  token_limit: "Token Limit",
};

function AddRuleForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [type, setType] = useState("regex");
  const [target, setTarget] = useState("both");
  const [action, setAction] = useState("block");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const res = await gatewayFetchRaw("/v1/admin/guardrails", {
        method: "POST",
        body: JSON.stringify({ name, pattern, type, target, action }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error?.message || "Failed to create rule");
        return;
      }
      setOpen(false);
      setName("");
      setPattern("");
      onCreated();
    } catch {
      setError("Failed to connect to gateway");
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
        Add Custom Rule
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Add Custom Rule</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">Cancel</button>
      </div>

      {error && <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-300">{error}</div>}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. Block profanity"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <option value="regex">Custom Regex</option>
            <option value="pii">PII Detection</option>
            <option value="content">Content Policy</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-1">Regex Pattern</label>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          required
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
          placeholder="e.g. \\b(badword1|badword2)\\b"
        />
        <p className="text-xs text-zinc-500 mt-1">JavaScript-compatible regex. Tested against message content.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Apply To</label>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <option value="both">Input + Output</option>
            <option value="input">Input only</option>
            <option value="output">Output only</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Action</label>
          <select value={action} onChange={(e) => setAction(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <option value="block">Block request</option>
            <option value="redact">Redact matches</option>
            <option value="flag">Flag (log only)</option>
          </select>
        </div>
      </div>

      <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors">
        {submitting ? "Creating..." : "Create Rule"}
      </button>
    </form>
  );
}

export default function GuardrailsPage() {
  const [rules, setRules] = useState<GuardrailRule[]>([]);
  const [logs, setLogs] = useState<GuardrailLog[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    try {
      const [rulesRes, logsRes] = await Promise.all([
        gatewayFetchRaw("/v1/admin/guardrails"),
        gatewayFetchRaw("/v1/admin/guardrails/logs"),
      ]);
      const rulesData = await rulesRes.json();
      const logsData = await logsRes.json();
      setRules(rulesData.rules || []);
      setLogs(logsData.logs || []);
    } catch (err) {
      console.error("Failed to fetch guardrails:", err);
    } finally {
      setLoading(false);
    }
  }

  async function toggleRule(id: string, enabled: boolean) {
    await gatewayFetchRaw(`/v1/admin/guardrails/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    fetchData();
  }

  async function deleteRule(id: string) {
    if (!confirm("Delete this rule?")) return;
    await gatewayFetchRaw(`/v1/admin/guardrails/${id}`, { method: "DELETE" });
    fetchData();
  }

  useEffect(() => { fetchData(); }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading guardrails...</p>
      </div>
    );
  }

  const builtInRules = rules.filter((r) => r.builtIn);
  const customRules = rules.filter((r) => !r.builtIn);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Guardrails</h1>
          <p className="text-sm text-zinc-400 mt-1">Input/output filtering for PII detection, content policies, and custom patterns.</p>
        </div>
        <AddRuleForm onCreated={fetchData} />
      </div>

      {/* Built-in Rules */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Built-in Rules</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="px-4 py-3">Rule</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {builtInRules.map((rule) => (
                <tr key={rule.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="px-4 py-3">
                    <p className="font-medium">{rule.name}</p>
                    {rule.pattern && <p className="text-xs text-zinc-500 font-mono mt-0.5 truncate max-w-xs">{rule.pattern}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{TYPE_LABELS[rule.type] || rule.type}</td>
                  <td className="px-4 py-3 text-xs text-zinc-400 capitalize">{rule.target}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded border ${ACTION_COLORS[rule.action]}`}>
                      {rule.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => toggleRule(rule.id, !rule.enabled)}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                        rule.enabled
                          ? "bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60"
                          : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
                      }`}
                    >
                      {rule.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                </tr>
              ))}
              {builtInRules.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">No built-in rules loaded yet. They will appear on first request.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Custom Rules */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Custom Rules</h2>
        {customRules.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-zinc-400">No custom rules yet. Add one to start filtering content.</p>
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-3">Rule</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customRules.map((rule) => (
                  <tr key={rule.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-4 py-3">
                      <p className="font-medium">{rule.name}</p>
                      <p className="text-xs text-zinc-500 font-mono mt-0.5">{rule.pattern}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-400 capitalize">{rule.target}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded border ${ACTION_COLORS[rule.action]}`}>{rule.action}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => toggleRule(rule.id, !rule.enabled)}
                          className="text-xs text-zinc-400 hover:text-zinc-200"
                        >
                          {rule.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          onClick={() => deleteRule(rule.id)}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent Violations */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Recent Violations</h2>
        {logs.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-zinc-400">No violations recorded yet.</p>
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-3">Rule</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Matched</th>
                  <th className="px-4 py-3 text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-zinc-800/50">
                    <td className="px-4 py-3 font-medium">{log.ruleName}</td>
                    <td className="px-4 py-3 text-xs text-zinc-400 capitalize">{log.target}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded border ${ACTION_COLORS[log.action]}`}>{log.action}</span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-zinc-400 max-w-xs truncate">{log.matchedContent || "—"}</td>
                    <td className="px-4 py-3 text-right text-xs text-zinc-500">
                      {new Date(log.createdAt).toLocaleString()}
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
