import type { Metadata } from "next";
import { PublicNav } from "../../components/public-nav";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing — Provara",
  description:
    "Intelligent LLM gateway pricing. Adaptive routing + silent-regression detection + cost migrations. Free tier, Pro from $29/mo, Team from $149/mo, Enterprise custom.",
  openGraph: {
    title: "Provara Pricing",
    description:
      "Your router learns, audits, and optimizes itself. Priced honestly — no markup on tokens, bring your own API keys.",
    url: "https://www.provara.xyz/pricing",
    siteName: "Provara",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Provara Pricing",
    description:
      "Your router learns, audits, and optimizes itself. Priced honestly — no markup on tokens.",
  },
};

export default function PricingPage() {
  return (
    <>
      <PublicNav />
      <main className="bg-zinc-950 min-h-screen text-zinc-100">
        <Hero />
        <PricingTable />
      </main>
    </>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Subtle gradient backdrop */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-br from-blue-950/40 via-zinc-950 to-emerald-950/20 pointer-events-none"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.08),transparent_60%)]"
      />
      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-28">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-400 mb-4">
            Pricing
          </p>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1]">
            Your router learns,
            <br />
            <span className="text-blue-400">audits, and optimizes</span>
            <br />
            itself.
          </h1>
          <p className="mt-6 text-lg text-zinc-400 leading-relaxed max-w-2xl">
            Provara is an intelligent LLM gateway that catches upstream model regressions
            automatically, A/B tests its own ambiguous routing decisions, and migrates
            to cheaper models when they reach parity. Bring your own API keys — we charge
            for the intelligence, not the tokens.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="/login"
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              Start Free
            </a>
            <a
              href="#plans"
              className="px-5 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 rounded-lg text-sm font-semibold transition-colors"
            >
              Compare plans ↓
            </a>
          </div>
          <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-xs text-zinc-500">
            <HeroStat label="No credit card to start" />
            <HeroStat label="BYOK — pay providers directly" />
            <HeroStat label="Cancel anytime" />
            <HeroStat label="Open-source self-host available" />
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroStat({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
      {label}
    </span>
  );
}
