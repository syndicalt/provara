"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "../../lib/auth-context";
import { TierBadge } from "../../components/tier-badge";
import { FAQS, FEATURE_GROUPS, PLANS, type PricingPlan } from "../../lib/pricing";

export function PricingTable() {
  const [annual, setAnnual] = useState(false);

  return (
    <>
      <TierCards annual={annual} setAnnual={setAnnual} />
      <ComparisonTable />
      <FAQ />
      <FinalCta />
    </>
  );
}

function TierCards({ annual, setAnnual }: { annual: boolean; setAnnual: (v: boolean) => void }) {
  return (
    <section id="plans" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold">Plans</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Start free, upgrade when you&apos;re ready. Every tier includes the core gateway.
          </p>
        </div>
        <div className="inline-flex items-center gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg text-xs">
          <button
            onClick={() => setAnnual(false)}
            className={`px-3 py-1.5 rounded transition-colors ${!annual ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            Monthly
          </button>
          <button
            onClick={() => setAnnual(true)}
            className={`px-3 py-1.5 rounded transition-colors ${annual ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            Annual{" "}
            <span className="text-emerald-400 text-[10px] ml-1 font-medium">save 2mo</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLANS.map((plan) => (
          <TierCard key={plan.tier} plan={plan} annual={annual} />
        ))}
      </div>
    </section>
  );
}

function TierCard({ plan, annual }: { plan: PricingPlan; annual: boolean }) {
  const { user } = useAuth();
  const isRecommended = plan.tier === "pro";
  const price = annual ? plan.priceAnnual : plan.priceMonthly;
  const suffix = annual ? "/yr" : "/mo";

  function ctaHref(): string {
    if (plan.ctaKind === "contact") return "mailto:legal@provara.xyz?subject=Provara%20Enterprise%20inquiry";
    if (plan.ctaKind === "signup") return user ? "/dashboard" : "/login";
    // checkout
    return user ? "/dashboard/billing" : `/login?return=${encodeURIComponent("/dashboard/billing")}`;
  }

  return (
    <div
      className={`relative bg-zinc-900 border rounded-xl p-6 flex flex-col ${
        isRecommended ? "border-blue-700/60 ring-1 ring-blue-700/30" : "border-zinc-800"
      }`}
    >
      {isRecommended && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 bg-blue-600 text-white text-[10px] font-semibold uppercase tracking-wider rounded-full">
          Most popular
        </span>
      )}
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold">{plan.label}</h3>
        <TierBadge tier={plan.tier} size="xs" />
      </div>
      <p className="text-xs text-zinc-500 mt-1">{plan.description}</p>

      <div className="mt-4">
        {price === null ? (
          <div className="text-2xl font-bold">Custom</div>
        ) : price === 0 ? (
          <div>
            <span className="text-3xl font-bold">$0</span>
            <span className="text-sm text-zinc-500 ml-1">forever</span>
          </div>
        ) : (
          <div>
            <span className="text-3xl font-bold">${price}</span>
            <span className="text-sm text-zinc-500 ml-1">{suffix}</span>
            {annual && plan.priceMonthly && (
              <div className="text-[11px] text-emerald-400 mt-1">
                = ${(price / 12).toFixed(2)}/mo effective
              </div>
            )}
          </div>
        )}
      </div>

      <ul className="mt-5 space-y-2 text-xs text-zinc-400 flex-1">
        {plan.highlights.map((h) => (
          <li key={h} className="flex items-start gap-2">
            <svg className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <span>{h}</span>
          </li>
        ))}
        {plan.limitations?.map((l) => (
          <li key={l} className="flex items-start gap-2 text-zinc-600">
            <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>{l}</span>
          </li>
        ))}
      </ul>

      <Link
        href={ctaHref()}
        className={`mt-6 block text-center px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
          isRecommended
            ? "bg-blue-600 hover:bg-blue-500 text-white"
            : "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700"
        }`}
      >
        {plan.ctaLabel}
      </Link>
    </div>
  );
}

function ComparisonTable() {
  return (
    <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16 border-t border-zinc-800/60">
      <div className="mb-8">
        <h2 className="text-2xl sm:text-3xl font-bold">Compare every feature</h2>
        <p className="text-sm text-zinc-400 mt-1">
          The full grid — what&apos;s in each tier, what isn&apos;t.
        </p>
      </div>

      <div className="overflow-x-auto -mx-4 sm:mx-0">
        <table className="min-w-full text-sm">
          <thead className="sticky top-14 bg-zinc-950 z-10">
            <tr className="border-b border-zinc-800">
              <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-widest text-zinc-500 w-[40%]">Feature</th>
              {PLANS.map((plan) => (
                <th key={plan.tier} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                  {plan.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURE_GROUPS.map((group) => (
              <ComparisonGroup key={group.label} label={group.label} rows={group.rows} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ComparisonGroup({
  label,
  rows,
}: {
  label: string;
  rows: (typeof FEATURE_GROUPS)[number]["rows"];
}) {
  return (
    <>
      <tr className="bg-zinc-900/40">
        <td colSpan={PLANS.length + 1} className="px-4 py-2 text-xs font-semibold uppercase tracking-widest text-blue-400">
          {label}
        </td>
      </tr>
      {rows.map((row, i) => (
        <tr key={i} className="border-b border-zinc-900/50">
          <td className="px-4 py-3 text-zinc-300 align-top">
            {row.label}
            {row.note && <div className="text-[11px] text-zinc-500 mt-0.5">{row.note}</div>}
          </td>
          {PLANS.map((plan) => (
            <td key={plan.tier} className="px-4 py-3 align-top">
              <CellValue value={row[plan.tier]} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function CellValue({ value }: { value: string | boolean }) {
  if (value === true) {
    return (
      <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    );
  }
  if (value === false) {
    return (
      <svg className="w-4 h-4 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return <span className="text-xs text-zinc-300">{value}</span>;
}

function FAQ() {
  return (
    <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16 border-t border-zinc-800/60">
      <h2 className="text-2xl sm:text-3xl font-bold mb-8">Frequently asked</h2>
      <div className="space-y-2">
        {FAQS.map((faq, i) => (
          <details
            key={i}
            className="group bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden"
          >
            <summary className="px-5 py-4 cursor-pointer flex items-center justify-between hover:bg-zinc-900/80 transition-colors list-none">
              <span className="text-sm font-medium text-zinc-200">{faq.q}</span>
              <svg
                className="w-4 h-4 text-zinc-500 transition-transform group-open:rotate-180"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="px-5 pb-5 text-sm text-zinc-400 leading-relaxed">
              {faq.a}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  const { user } = useAuth();
  return (
    <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24 text-center">
      <h2 className="text-3xl sm:text-4xl font-bold">Ready to route smarter?</h2>
      <p className="mt-3 text-zinc-400 max-w-xl mx-auto">
        Sign in with Google or GitHub. No credit card. Upgrade when you&apos;re ready.
      </p>
      <Link
        href={user ? "/dashboard" : "/login"}
        className="inline-block mt-8 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors"
      >
        {user ? "Go to dashboard" : "Start Free"}
      </Link>
      <p className="mt-6 text-xs text-zinc-600">
        Prefer to self-host?{" "}
        <a
          href="https://github.com/syndicalt/provara"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 underline"
        >
          Full source on GitHub
        </a>
        .
      </p>
    </section>
  );
}
