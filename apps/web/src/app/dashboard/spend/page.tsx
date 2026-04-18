"use client";

import { useCallback, useEffect, useState } from "react";
import { gatewayFetchRaw } from "../../../lib/gateway-client";

/**
 * Spend intelligence dashboard (#219/T9). Single-page surface with six
 * sections, each backed by one `/v1/spend/*` endpoint. Tier gating is
 * enforced by the gateway — if a section's endpoint responds 402, we
 * render an upgrade CTA in place of the data.
 *
 * Sections:
 *   1. Spend attribution  — /v1/spend/by (dim selector, period compare)
 *   2. Trajectory         — /v1/spend/trajectory (MTD + projection)
 *   3. Savings by quality — /v1/spend/by (same payload, ranked by
 *                            cost_per_quality_point asc)
 *   4. Weight drift       — /v1/spend/drift (Enterprise)
 *   5. Recommendations    — /v1/spend/recommendations (Enterprise)
 *   6. Budgets            — /v1/spend/budgets (CRUD)
 */

type Dim = "provider" | "model" | "user" | "token" | "category";

interface SpendByRow {
  key: string;
  label: string;
  cost_usd: number;
  requests: number;
  judged_requests: number;
  quality_median: number | null;
  quality_p25: number | null;
  quality_p75: number | null;
  cost_per_quality_point: number | null;
  delta_usd: number | null;
  delta_pct: number | null;
  task_type?: string;
  complexity?: string;
}

interface SpendByResponse {
  dim: Dim;
  period: { from: string; to: string };
  compare_period: { from: string; to: string; mode: string } | null;
  rows: SpendByRow[];
  truncated: boolean;
}

interface TrajectoryResponse {
  period: "month" | "quarter";
  period_start: string;
  period_end: string;
  mtd_cost: number;
  projected_cost: number;
  prior_period_cost: number;
  anomaly: { flagged: boolean; reason: string | null };
}

interface DriftEvent {
  changed_at: string;
  from_weights: { quality: number; cost: number; latency: number };
  to_weights: { quality: number; cost: number; latency: number };
  deltas: { quality: number; cost: number; latency: number };
  attribution_window_days: number;
  window_start: string;
  window_end: string;
  spend_mix: { provider: string; cost_usd: number; share_pct: number }[];
}

interface Recommendation {
  task_type: string;
  complexity: string;
  from_provider: string;
  from_model: string;
  to_provider: string;
  to_model: string;
  quality_delta: number;
  monthly_volume: number;
  current_cost_per_req: number;
  alternate_cost_per_req: number;
  estimated_monthly_savings: number;
  confidence_samples: number;
}

interface Budget {
  tenantId: string;
  period: "monthly" | "quarterly";
  capUsd: number;
  alertThresholds: number[];
  alertEmails: string[];
  hardStop: boolean;
  alertedThresholds: number[];
}

const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
      <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>
    </div>
  );
}

function UpgradeCard({ message }: { message: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
      <p className="text-zinc-300 font-medium">{message}</p>
      <a
        href="/dashboard/billing"
        className="inline-block mt-3 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
      >
        Upgrade
      </a>
    </div>
  );
}

function AttributionSection() {
  const [dim, setDim] = useState<Dim>("provider");
  const [data, setData] = useState<SpendByResponse | null>(null);
  const [gated, setGated] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await gatewayFetchRaw(`/v1/spend/by?dim=${dim}`);
      if (res.status === 402) { setGated(true); setData(null); return; }
      setGated(false);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [dim]);

  useEffect(() => { load(); }, [load]);

  function downloadCsv() {
    window.location.href =
      (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "") + `/v1/spend/export?dim=${dim}`;
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Spend attribution"
        subtitle="Who spent it, on what, and is the quality worth it."
      />
      {gated ? (
        <UpgradeCard message="Spend attribution is available on Team and Enterprise plans." />
      ) : (
        <>
          <div className="flex items-center gap-3">
            <select
              value={dim}
              onChange={(e) => setDim(e.target.value as Dim)}
              className="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded px-2 py-1.5 text-sm"
            >
              <option value="provider">Provider</option>
              <option value="model">Model</option>
              <option value="category">Category (task × complexity)</option>
              <option value="user">User (Enterprise)</option>
              <option value="token">API Token (Enterprise)</option>
            </select>
            <button
              onClick={downloadCsv}
              className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
            >
              Export CSV
            </button>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Key</th>
                  <th className="text-right px-4 py-2 font-medium">Spend</th>
                  <th className="text-right px-4 py-2 font-medium">Requests</th>
                  <th className="text-right px-4 py-2 font-medium">Quality (p25 / med / p75)</th>
                  <th className="text-right px-4 py-2 font-medium">$ / quality pt</th>
                  <th className="text-right px-4 py-2 font-medium">Δ vs prior</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={6} className="text-center py-4 text-zinc-500 text-sm">Loading…</td></tr>
                )}
                {!loading && data?.rows.length === 0 && (
                  <tr><td colSpan={6} className="text-center py-4 text-zinc-500 text-sm">No spend in the last 30 days.</td></tr>
                )}
                {!loading && data?.rows.map((r) => (
                  <tr key={r.key} className="border-t border-zinc-800">
                    <td className="px-4 py-2 text-zinc-200">{r.label}</td>
                    <td className="px-4 py-2 text-right text-zinc-200">{money(r.cost_usd)}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">{r.requests.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-zinc-400">
                      {r.quality_median == null ? (
                        <span className="text-zinc-600">—</span>
                      ) : (
                        <span>{r.quality_p25?.toFixed(1)} / {r.quality_median.toFixed(1)} / {r.quality_p75?.toFixed(1)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-400">
                      {r.cost_per_quality_point == null ? "—" : money(r.cost_per_quality_point)}
                    </td>
                    <td className={`px-4 py-2 text-right ${(r.delta_usd ?? 0) > 0 ? "text-red-400" : "text-green-400"}`}>
                      {r.delta_usd == null ? "—" : `${r.delta_usd >= 0 ? "+" : ""}${money(r.delta_usd)}`}
                      {r.delta_pct != null && <span className="text-zinc-600 ml-1 text-xs">({pct(r.delta_pct)})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function TrajectorySection() {
  const [data, setData] = useState<TrajectoryResponse | null>(null);
  const [gated, setGated] = useState(false);
  const [period, setPeriod] = useState<"month" | "quarter">("month");

  useEffect(() => {
    let cancel = false;
    (async () => {
      const res = await gatewayFetchRaw(`/v1/spend/trajectory?period=${period}`);
      if (cancel) return;
      if (res.status === 402) { setGated(true); setData(null); return; }
      setGated(false);
      if (res.ok) setData(await res.json());
    })();
    return () => { cancel = true; };
  }, [period]);

  return (
    <section className="space-y-3">
      <SectionHeader title="Trajectory" subtitle="How much you've spent this period, and the straight-line projection." />
      {gated ? <UpgradeCard message="Trajectory is available on Team and Enterprise plans." /> : (
        <>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as "month" | "quarter")}
            className="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded px-2 py-1.5 text-sm"
          >
            <option value="month">This month</option>
            <option value="quarter">This quarter</option>
          </select>
          {!data ? <p className="text-sm text-zinc-500">Loading…</p> : (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Spent so far</div>
                <div className="text-2xl font-semibold text-zinc-100 mt-1">{money(data.mtd_cost)}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Projected for period</div>
                <div className="text-2xl font-semibold text-zinc-100 mt-1">{money(data.projected_cost)}</div>
                <div className="text-xs text-zinc-500 mt-1">Prior: {money(data.prior_period_cost)}</div>
              </div>
              <div className={`${data.anomaly.flagged ? "bg-red-900/30 border-red-800" : "bg-zinc-900 border-zinc-800"} border rounded-lg p-4`}>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Anomaly</div>
                <div className={`mt-1 text-sm ${data.anomaly.flagged ? "text-red-300 font-semibold" : "text-zinc-400"}`}>
                  {data.anomaly.flagged ? "Flagged" : "Normal"}
                </div>
                {data.anomaly.reason && (
                  <div className="text-xs text-zinc-500 mt-1">{data.anomaly.reason}</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function DriftSection() {
  const [events, setEvents] = useState<DriftEvent[] | null>(null);
  const [gated, setGated] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const res = await gatewayFetchRaw("/v1/spend/drift");
      if (cancel) return;
      if (res.status === 402) { setGated(true); setEvents(null); return; }
      setGated(false);
      if (res.ok) {
        const body = await res.json();
        setEvents(body.events);
      }
    })();
    return () => { cancel = true; };
  }, []);

  return (
    <section className="space-y-3">
      <SectionHeader title="Weight drift × spend" subtitle="Did changing your routing weights actually shift the spend mix? Unique to Provara." />
      {gated ? <UpgradeCard message="Weight-drift analysis is available on the Enterprise plan." /> : !events ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-zinc-500">No routing-weight changes in the last 30 days.</p>
      ) : (
        <div className="space-y-3">
          {events.map((e) => (
            <div key={e.changed_at} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <div className="text-sm text-zinc-300">
                <span className="text-zinc-500">Change on</span>{" "}
                <span className="font-medium">{new Date(e.changed_at).toLocaleDateString()}</span>
              </div>
              <div className="text-xs text-zinc-400 mt-1">
                Δ quality {e.deltas.quality >= 0 ? "+" : ""}{e.deltas.quality} ·
                Δ cost {e.deltas.cost >= 0 ? "+" : ""}{e.deltas.cost} ·
                Δ latency {e.deltas.latency >= 0 ? "+" : ""}{e.deltas.latency}
                {" · "}{e.attribution_window_days}d window
              </div>
              <div className="mt-2 text-xs text-zinc-500">Spend mix after:</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {e.spend_mix.map((m) => (
                  <span key={m.provider} className="px-2 py-0.5 rounded bg-zinc-800 text-xs text-zinc-300">
                    {m.provider}: {money(m.cost_usd)} ({m.share_pct.toFixed(0)}%)
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecommendationsSection() {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [gated, setGated] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const res = await gatewayFetchRaw("/v1/spend/recommendations");
      if (cancel) return;
      if (res.status === 402) { setGated(true); setRecs(null); return; }
      setGated(false);
      if (res.ok) {
        const body = await res.json();
        setRecs(body.recommendations);
      }
    })();
    return () => { cancel = true; };
  }, []);

  return (
    <section className="space-y-3">
      <SectionHeader title="Savings recommendations" subtitle="Same-quality alternates, ranked by estimated monthly savings." />
      {gated ? <UpgradeCard message="Savings recommendations are available on the Enterprise plan." /> : !recs ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : recs.length === 0 ? (
        <p className="text-sm text-zinc-500">No savings opportunities detected — you're already on the efficient frontier.</p>
      ) : (
        <div className="space-y-2">
          {recs.map((r, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="text-sm text-zinc-200">
                  <span className="text-zinc-400">{r.task_type}+{r.complexity}:</span>{" "}
                  Switch <span className="font-medium">{r.from_model}</span> →{" "}
                  <span className="font-medium text-blue-400">{r.to_model}</span>
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  Quality Δ {r.quality_delta.toFixed(3)} · {r.monthly_volume} reqs/mo · {r.confidence_samples} graded samples
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-green-400">{money(r.estimated_monthly_savings)}</div>
                <div className="text-xs text-zinc-500">est. monthly savings</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BudgetsSection() {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [gated, setGated] = useState(false);
  const [cap, setCap] = useState<string>("");
  const [period, setPeriod] = useState<"monthly" | "quarterly">("monthly");
  const [emails, setEmails] = useState<string>("");
  const [hardStop, setHardStop] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const res = await gatewayFetchRaw("/v1/spend/budgets");
      if (cancel) return;
      if (res.status === 402) { setGated(true); setBudget(null); return; }
      setGated(false);
      if (res.ok) {
        const body = await res.json();
        setBudget(body.budget);
        if (body.budget) {
          setCap(String(body.budget.capUsd));
          setPeriod(body.budget.period);
          setEmails(body.budget.alertEmails.join(", "));
          setHardStop(body.budget.hardStop);
        }
      }
    })();
    return () => { cancel = true; };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await gatewayFetchRaw("/v1/spend/budgets", {
        method: "PUT",
        body: JSON.stringify({
          cap_usd: Number(cap),
          period,
          alert_thresholds: [50, 75, 90, 100],
          alert_emails: emails.split(",").map((e) => e.trim()).filter(Boolean),
          hard_stop: hardStop,
        }),
      });
      if (res.ok) {
        const body = await res.json();
        setBudget(body.budget);
        setSavedAt(Date.now());
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeader title="Budgets & alerts" subtitle="Set a cap, get emailed at thresholds. Optional hard stop refuses requests at 100%." />
      {gated ? <UpgradeCard message="Budgets are available on Team and Enterprise plans." /> : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-500">Cap (USD)</label>
              <input
                type="number"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                placeholder="e.g. 500"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500">Period</label>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value as "monthly" | "quarterly")}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded px-2 py-1.5 text-sm"
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500">Alert emails (comma-separated)</label>
            <input
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="finance@example.com, ops@example.com"
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={hardStop} onChange={(e) => setHardStop(e.target.checked)} />
            <span>Hard stop at 100% — refuse new requests with HTTP 402 once the cap is hit</span>
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !cap}
              className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : budget ? "Update budget" : "Create budget"}
            </button>
            {savedAt && <span className="text-xs text-zinc-500">Saved.</span>}
          </div>
          {budget && budget.alertedThresholds.length > 0 && (
            <div className="text-xs text-zinc-500">
              Already alerted this period: {budget.alertedThresholds.join("%, ")}%
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function SpendPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
      <div>
        <h1 className="text-2xl font-bold">Spend intelligence</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Attribution, trajectory, quality-adjusted spend, and savings recommendations. Team+ / Enterprise.
        </p>
      </div>

      <AttributionSection />
      <TrajectorySection />
      <DriftSection />
      <RecommendationsSection />
      <BudgetsSection />
    </div>
  );
}
