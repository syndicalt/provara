"use client";

import { useEffect, useState } from "react";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  window: string;
  channel: string;
  webhookUrl: string | null;
  enabled: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
}

interface AlertLog {
  id: string;
  ruleId: string;
  ruleName: string;
  metric: string;
  value: number;
  threshold: number;
  acknowledged: boolean;
  createdAt: string;
}

const METRICS = [
  { value: "spend", label: "Spend (USD)", unit: "$" },
  { value: "latency_avg", label: "Avg Latency (ms)", unit: "ms" },
  { value: "latency_p95", label: "P95 Latency (ms)", unit: "ms" },
  { value: "request_count", label: "Request Count", unit: "" },
];

const CONDITIONS = [
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
];

const WINDOWS = [
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

function formatMetricValue(metric: string, value: number): string {
  const info = METRICS.find((m) => m.value === metric);
  if (info?.unit === "$") return `$${value.toFixed(4)}`;
  if (info?.unit === "ms") return `${Math.round(value)}ms`;
  return value.toLocaleString();
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "Never";
  const d = new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function CreateRuleForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [metric, setMetric] = useState("spend");
  const [condition, setCondition] = useState("gt");
  const [threshold, setThreshold] = useState("");
  const [window, setWindow] = useState("1h");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await gatewayFetchRaw("/v1/admin/alerts/rules", {
        method: "POST",
        body: JSON.stringify({
          name,
          metric,
          condition,
          threshold: parseFloat(threshold),
          window,
          webhookUrl: webhookUrl || undefined,
        }),
      });
      setName(""); setThreshold(""); setWebhookUrl("");
      setOpen(false);
      onCreated();
    } catch (err) {
      console.error("Failed to create rule:", err);
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
        Create Alert
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Create Alert Rule</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">Cancel</button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="block text-sm text-zinc-400 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. High spend alert"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Metric</label>
          <select value={metric} onChange={(e) => setMetric(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Window</label>
          <select value={window} onChange={(e) => setWindow(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Condition</label>
          <select value={condition} onChange={(e) => setCondition(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Threshold</label>
          <input
            type="number"
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder={metric === "spend" ? "10.00" : "5000"}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-sm text-zinc-400 mb-1">Webhook URL (optional)</label>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="https://hooks.slack.com/..."
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
      >
        {submitting ? "Creating..." : "Create Alert"}
      </button>
    </form>
  );
}

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [history, setHistory] = useState<AlertLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [evaluating, setEvaluating] = useState(false);

  async function fetchData() {
    try {
      const [rulesData, historyData] = await Promise.all([
        gatewayClientFetch<{ rules: AlertRule[] }>("/v1/admin/alerts/rules"),
        gatewayClientFetch<{ alerts: AlertLog[] }>("/v1/admin/alerts/history"),
      ]);
      setRules(rulesData.rules || []);
      setHistory(historyData.alerts || []);
    } catch (err) {
      console.error("Failed to fetch alerts:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  async function handleToggle(rule: AlertRule) {
    await gatewayFetchRaw(`/v1/admin/alerts/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    fetchData();
  }

  async function handleDelete(rule: AlertRule) {
    if (!confirm(`Delete alert "${rule.name}"?`)) return;
    await gatewayFetchRaw(`/v1/admin/alerts/rules/${rule.id}`, { method: "DELETE" });
    fetchData();
  }

  async function handleEvaluate() {
    setEvaluating(true);
    try {
      const res = await gatewayFetchRaw("/v1/admin/alerts/evaluate", { method: "POST" });
      const data = await res.json();
      if (data.fired?.length > 0) {
        alert(`Alerts fired: ${data.fired.join(", ")}`);
      }
      fetchData();
    } catch {}
    setEvaluating(false);
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading alerts...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Alerts</h1>
          <p className="text-sm text-zinc-400 mt-1">Get notified when metrics exceed thresholds.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleEvaluate}
            disabled={evaluating || rules.length === 0}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
          >
            {evaluating ? "Checking..." : "Check Now"}
          </button>
          <CreateRuleForm onCreated={fetchData} />
        </div>
      </div>

      {/* Rules */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Alert Rules</h2>
        {rules.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-zinc-400">No alert rules yet. Create one to start monitoring.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => {
              const metricInfo = METRICS.find((m) => m.value === rule.metric);
              const condInfo = CONDITIONS.find((c) => c.value === rule.condition);
              return (
                <div
                  key={rule.id}
                  className={`bg-zinc-900 border rounded-lg px-4 py-3 flex items-center justify-between ${rule.enabled ? "border-zinc-800" : "border-zinc-800/60 opacity-60"}`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${rule.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
                    <div>
                      <p className="font-medium text-sm">{rule.name}</p>
                      <p className="text-xs text-zinc-500">
                        {metricInfo?.label} {condInfo?.label} {formatMetricValue(rule.metric, rule.threshold)} over {WINDOWS.find((w) => w.value === rule.window)?.label}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {rule.webhookUrl && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">webhook</span>
                    )}
                    <span className="text-xs text-zinc-500">
                      Last fired: {formatTimestamp(rule.lastTriggeredAt)}
                    </span>
                    <button
                      onClick={() => handleToggle(rule)}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        rule.enabled
                          ? "bg-amber-900/50 text-amber-300 hover:bg-amber-800/50"
                          : "bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/50"
                      }`}
                    >
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => handleDelete(rule)}
                      className="px-2.5 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded text-xs"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Alert History */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Alert History</h2>
        {history.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-zinc-400">No alerts have fired yet.</p>
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-3">Alert</th>
                  <th className="px-4 py-3">Metric</th>
                  <th className="px-4 py-3 text-right">Value</th>
                  <th className="px-4 py-3 text-right">Threshold</th>
                  <th className="px-4 py-3 text-right">Fired At</th>
                </tr>
              </thead>
              <tbody>
                {history.map((log) => (
                  <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-4 py-3 font-medium">{log.ruleName}</td>
                    <td className="px-4 py-3 text-zinc-400">
                      {METRICS.find((m) => m.value === log.metric)?.label || log.metric}
                    </td>
                    <td className="px-4 py-3 text-right text-red-400 font-mono text-xs">
                      {formatMetricValue(log.metric, log.value)}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 font-mono text-xs">
                      {formatMetricValue(log.metric, log.threshold)}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500 text-xs">
                      {formatTimestamp(log.createdAt)}
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
