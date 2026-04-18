"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";
import { TierBadge } from "../../../components/tier-badge";

interface Me {
  tier: string;
  includesIntelligence: boolean;
  status: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  trialEnd?: string | null;
  quotaPerMonth: number | null;
}

interface Usage {
  tier: string;
  periodStart: string;
  periodEnd: string | null;
  used: number;
  quota: number;
  quotaUnlimited: boolean;
  remaining: number;
  percentUsed: number;
}

interface PlanOption {
  label: string;
  tier: string;
  priceMonthly: number;
  priceAnnual: number;
  monthlyLookupKey: string;
  annualLookupKey: string;
  description: string;
  highlights: string[];
}

const PLAN_OPTIONS: PlanOption[] = [
  {
    label: "Pro",
    tier: "pro",
    priceMonthly: 29,
    priceAnnual: 290,
    monthlyLookupKey: "cloud_pro_monthly",
    annualLookupKey: "cloud_pro_yearly",
    description: "Individual + small team",
    highlights: [
      "100k requests/mo",
      "Auto-A/B generation",
      "Silent-regression detection",
      "Cost migrations",
      "3 seats",
    ],
  },
  {
    label: "Team",
    tier: "team",
    priceMonthly: 149,
    priceAnnual: 1490,
    monthlyLookupKey: "cloud_team_monthly",
    annualLookupKey: "cloud_team_yearly",
    description: "Growing teams",
    highlights: [
      "500k requests/mo",
      "Everything in Pro",
      "Priority support",
      "10 seats",
    ],
  },
];

const TIER_ORDER: Record<string, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
  selfhost_enterprise: 3,
  operator: 99,
};

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function BillingPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [annual, setAnnual] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const params = useSearchParams();

  useEffect(() => {
    const checkout = params.get("checkout");
    if (checkout === "success") setNotice("Checkout completed. Your subscription will activate momentarily as Stripe finalizes.");
    else if (checkout === "cancelled") setNotice("Checkout cancelled. Your current plan is unchanged.");
  }, [params]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, usageRes] = await Promise.all([
        gatewayClientFetch<Me>("/v1/billing/me"),
        gatewayClientFetch<Usage>("/v1/billing/usage"),
      ]);
      setMe(meRes);
      setUsage(usageRes);
    } catch (err) {
      console.error("billing fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openPortal() {
    setBusy("portal");
    try {
      const res = await gatewayFetchRaw("/v1/billing/portal-session", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setNotice(body?.error?.message || "Could not open billing portal.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } finally {
      setBusy(null);
    }
  }

  async function startCheckout(priceLookupKey: string) {
    setBusy(priceLookupKey);
    try {
      const res = await gatewayFetchRaw("/v1/billing/checkout-session", {
        method: "POST",
        body: JSON.stringify({ priceLookupKey }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setNotice(body?.error?.message || "Could not start checkout.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8"><p className="text-zinc-400">Loading billing...</p></div>;
  }
  if (!me) {
    return <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8"><p className="text-zinc-400">Could not load billing information.</p></div>;
  }

  const currentTierRank = TIER_ORDER[me.tier] ?? 0;
  const isOperator = me.tier === "operator";
  const showUpgrades = !isOperator && currentTierRank < TIER_ORDER.team;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Manage your Provara Cloud subscription, usage, and billing.
        </p>
      </div>

      {notice && (
        <div className="bg-blue-950/30 border border-blue-900/60 rounded-lg p-3 text-sm text-blue-200 flex items-start justify-between gap-4">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-blue-400 hover:text-blue-300 text-xs">Dismiss</button>
        </div>
      )}

      {/* Current plan */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Current plan</h2>
              <TierBadge tier={me.tier} size="sm" />
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              {me.status === "past_due"
                ? "Payment issue — update your card to stay active."
                : me.status === "trialing" && me.trialEnd
                ? `Trial ends ${formatDate(me.trialEnd)}.`
                : me.cancelAtPeriodEnd && me.currentPeriodEnd
                ? `Will cancel at the end of the billing period (${formatDate(me.currentPeriodEnd)}).`
                : me.currentPeriodEnd
                ? `Renews ${formatDate(me.currentPeriodEnd)}.`
                : isOperator
                ? "Operator bypass — billing not applicable."
                : "No active subscription. Upgrade below to enable Intelligence features."}
            </p>
          </div>
          <div className="flex gap-2">
            {me.tier !== "free" && me.tier !== "operator" && (
              <button
                onClick={openPortal}
                disabled={busy === "portal"}
                className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-50"
              >
                {busy === "portal" ? "Opening…" : "Manage billing"}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Usage */}
      {usage && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Usage this period</h2>
            <p className="text-xs text-zinc-500">
              {formatDate(usage.periodStart)}
              {usage.periodEnd ? ` – ${formatDate(usage.periodEnd)}` : ""}
            </p>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-zinc-100">{formatNumber(usage.used)}</span>
            <span className="text-sm text-zinc-500">
              / {usage.quotaUnlimited ? "∞" : formatNumber(usage.quota)} requests
            </span>
          </div>
          {!usage.quotaUnlimited && (
            <div className="mt-3 h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${
                  usage.percentUsed > 90 ? "bg-red-500" : usage.percentUsed > 70 ? "bg-amber-500" : "bg-emerald-500"
                }`}
                style={{ width: `${Math.min(100, usage.percentUsed)}%` }}
              />
            </div>
          )}
          <p className="text-xs text-zinc-500 mt-2">
            {usage.quotaUnlimited
              ? "Unlimited usage on this plan."
              : `${formatNumber(usage.remaining)} requests remaining. Overage on Pro+ plans is billed at $0.50 per 1,000 additional requests.`}
          </p>
        </section>
      )}

      {/* Upgrade options */}
      {showUpgrades && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Upgrade</h2>
              <p className="text-xs text-zinc-500 mt-1">
                Intelligence features are included on Pro and higher.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => setAnnual(false)}
                className={`px-2 py-1 rounded ${!annual ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                Monthly
              </button>
              <button
                onClick={() => setAnnual(true)}
                className={`px-2 py-1 rounded ${annual ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                Annual <span className="text-emerald-400 text-[10px] ml-1">save 2mo</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {PLAN_OPTIONS.filter((p) => TIER_ORDER[p.tier] > currentTierRank).map((plan) => {
              const lookupKey = annual ? plan.annualLookupKey : plan.monthlyLookupKey;
              const price = annual ? plan.priceAnnual : plan.priceMonthly;
              const suffix = annual ? "/yr" : "/mo";
              return (
                <div key={plan.tier} className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold">{plan.label}</h3>
                    <TierBadge tier={plan.tier} size="xs" />
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">{plan.description}</p>
                  <div className="mt-3">
                    <span className="text-3xl font-bold">${price}</span>
                    <span className="text-sm text-zinc-500">{suffix}</span>
                  </div>
                  <ul className="mt-4 space-y-1.5 text-xs text-zinc-400">
                    {plan.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-2">
                        <span className="text-emerald-400">✓</span>
                        {h}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => startCheckout(lookupKey)}
                    disabled={busy !== null}
                    className="mt-5 w-full px-3 py-2 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
                  >
                    {busy === lookupKey ? "Starting checkout…" : `Upgrade to ${plan.label}`}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-4 text-xs text-zinc-500">
            Need more? <a href="mailto:legal@provara.xyz" className="text-blue-400 hover:text-blue-300">Contact sales</a> for Enterprise pricing (unlimited seats, SLA, dedicated support).
          </div>
        </section>
      )}

      {isOperator && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <p className="text-xs text-zinc-500">
            You&apos;re signed in as a CoreLumen operator. Subscription checks are bypassed for operator accounts — you have access to all Intelligence features without a paid subscription. This is a billing bypass, not cross-tenant access.
          </p>
        </section>
      )}
    </div>
  );
}
