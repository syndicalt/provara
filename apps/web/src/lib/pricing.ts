/**
 * Canonical pricing constants — consumed by both /dashboard/billing
 * (signed-in upgrade cards) and /pricing (public marketing page).
 *
 * Single source of truth prevents drift between the two surfaces.
 * When you change prices here, update Stripe's product catalog and
 * `packages/gateway/src/routes/billing.ts` (TIER_QUOTAS) to match.
 */

export type PricingTier = "free" | "pro" | "team" | "enterprise";

export interface PricingPlan {
  tier: PricingTier;
  label: string;
  description: string;
  priceMonthly: number | null; // null = custom pricing
  priceAnnual: number | null;
  monthlyLookupKey: string | null;
  annualLookupKey: string | null;
  /** Short marketing bullets shown on tier cards (3-5 items). */
  highlights: string[];
  /** What you DON'T get — shown on the compare table for transparency. */
  limitations?: string[];
  /** Primary CTA button label shown on the tier card. */
  ctaLabel: string;
  /** "Sold out" / "Contact sales" / routed to Stripe checkout. */
  ctaKind: "signup" | "checkout" | "contact";
}

export const PLANS: PricingPlan[] = [
  {
    tier: "free",
    label: "Free",
    description: "Try Provara Cloud with no credit card.",
    priceMonthly: 0,
    priceAnnual: 0,
    monthlyLookupKey: "cloud_free",
    annualLookupKey: null,
    highlights: [
      "10,000 requests/mo",
      "Full dashboard + analytics",
      "Adaptive routing",
      "A/B testing",
      "LLM-as-judge sampling",
      "1 seat",
    ],
    limitations: [
      "No auto-A/B generation",
      "No silent-regression detection",
      "No auto cost migrations",
    ],
    ctaLabel: "Start Free",
    ctaKind: "signup",
  },
  {
    tier: "pro",
    label: "Pro",
    description: "Individual developers and small side projects.",
    priceMonthly: 29,
    priceAnnual: 290,
    monthlyLookupKey: "cloud_pro_monthly",
    annualLookupKey: "cloud_pro_yearly",
    highlights: [
      "100,000 requests/mo",
      "Auto-A/B generation",
      "Silent-regression detection",
      "Auto cost migrations",
      "3 seats",
      "Email support",
    ],
    ctaLabel: "Start Pro",
    ctaKind: "checkout",
  },
  {
    tier: "team",
    label: "Team",
    description: "Growing teams shipping AI features.",
    priceMonthly: 149,
    priceAnnual: 1490,
    monthlyLookupKey: "cloud_team_monthly",
    annualLookupKey: "cloud_team_yearly",
    highlights: [
      "500,000 requests/mo",
      "Everything in Pro",
      "10 seats",
      "Priority support",
      "Team invites + SSO-ready",
    ],
    ctaLabel: "Start Team",
    ctaKind: "checkout",
  },
  {
    tier: "enterprise",
    label: "Enterprise",
    description: "Volume, dedicated support, custom terms.",
    priceMonthly: null,
    priceAnnual: null,
    monthlyLookupKey: null,
    annualLookupKey: null,
    highlights: [
      "Custom request volume",
      "Unlimited seats",
      "SAML SSO",
      "Dedicated SLA",
      "Priority support channel",
      "Custom invoicing",
    ],
    ctaLabel: "Contact Sales",
    ctaKind: "contact",
  },
];

/** Metered overage rate shared across Pro and Team tiers. */
export const OVERAGE_RATE_PER_1K = 0.5;

/**
 * Feature matrix for the comparison table. Rows are grouped by
 * category so the UI can render section headers between them.
 */
export interface FeatureRow {
  label: string;
  free: string | boolean;
  pro: string | boolean;
  team: string | boolean;
  enterprise: string | boolean;
  note?: string;
}

export interface FeatureGroup {
  label: string;
  rows: FeatureRow[];
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    label: "Core Gateway",
    rows: [
      { label: "OpenAI-compatible API", free: true, pro: true, team: true, enterprise: true },
      { label: "Multi-provider routing (OpenAI, Anthropic, Google, xAI, Mistral, Z.ai, Ollama, custom)", free: true, pro: true, team: true, enterprise: true },
      { label: "Classifier + adaptive routing", free: true, pro: true, team: true, enterprise: true },
      { label: "A/B testing (manual)", free: true, pro: true, team: true, enterprise: true },
      { label: "LLM-as-judge quality scoring", free: true, pro: true, team: true, enterprise: true },
      { label: "Semantic + exact cache", free: true, pro: true, team: true, enterprise: true },
      { label: "Guardrails (PII detection, content policies, regex)", free: true, pro: true, team: true, enterprise: true },
      { label: "Request logs + replay", free: true, pro: true, team: true, enterprise: true },
      { label: "Monthly request quota", free: "10k", pro: "100k", team: "500k", enterprise: "Custom" },
      { label: "Overage billing", free: "Hard cutoff", pro: "$0.50 / 1k", team: "$0.50 / 1k", enterprise: "Custom" },
    ],
  },
  {
    label: "Intelligence",
    rows: [
      { label: "Auto-A/B generation — spawns experiments on tied cells automatically", free: false, pro: true, team: true, enterprise: true },
      { label: "Silent-regression detection with closed-loop rerouting", free: false, pro: true, team: true, enterprise: true },
      { label: "Auto cost migrations with projected savings", free: false, pro: true, team: true, enterprise: true },
      { label: "Background scheduler observability", free: false, pro: true, team: true, enterprise: true },
    ],
  },
  {
    label: "Team & Admin",
    rows: [
      { label: "Seats", free: "1", pro: "3", team: "10", enterprise: "Unlimited" },
      { label: "Team invites", free: false, pro: true, team: true, enterprise: true, note: "Coming soon" },
      { label: "Role-based access (owner / member)", free: true, pro: true, team: true, enterprise: true },
      { label: "API token scoping + rate limits", free: true, pro: true, team: true, enterprise: true },
      { label: "Audit logs", free: false, pro: false, team: true, enterprise: true },
      { label: "SAML SSO", free: false, pro: false, team: false, enterprise: true },
    ],
  },
  {
    label: "Support & SLA",
    rows: [
      { label: "Community support (GitHub Discussions)", free: true, pro: true, team: true, enterprise: true },
      { label: "Email support", free: false, pro: true, team: true, enterprise: true },
      { label: "Priority response", free: false, pro: false, team: true, enterprise: true },
      { label: "Dedicated support channel", free: false, pro: false, team: false, enterprise: true },
      { label: "Custom SLA", free: false, pro: false, team: false, enterprise: true },
      { label: "Invoice billing", free: false, pro: false, team: false, enterprise: true },
    ],
  },
];

export const FAQS = [
  {
    q: "Can I self-host instead?",
    a: "Yes. The core gateway is open-source and self-hostable — you get the full routing engine, judge, A/B testing, adaptive matrix, guardrails, and analytics. Intelligence features (auto-A/B, silent-regression detection, cost migrations) are Cloud-only. A commercial self-host license with support is available for enterprise teams that need isolation.",
  },
  {
    q: "What happens if I go over my monthly request quota?",
    a: "On Pro and Team, overage requests keep flowing — you're billed $0.50 per 1,000 additional requests. On Free, requests stop at the quota and you'll need to upgrade or wait for the next billing period. Overage is billed on the same invoice as your subscription; no separate surprise charge.",
  },
  {
    q: "Do you mark up my provider costs?",
    a: "No. You bring your own API keys for OpenAI, Anthropic, Google, etc., and pay those providers directly. Provara's pricing is for the routing, analytics, and Intelligence layer on top — not a margin on tokens.",
  },
  {
    q: "Can I change plans anytime?",
    a: "Yes. Upgrade or downgrade from the dashboard; changes prorate automatically. Annual plans get two months free versus monthly. Cancellations stop renewal at the end of your current period — no refunds for partial months, but you keep access until the period ends.",
  },
  {
    q: "Is Provara SOC 2 certified?",
    a: "Not yet. We're a young product. Security posture today: AES-256-GCM for API keys at rest, OAuth-only sign-in (Google and GitHub, both with verified email), tenant-isolated data, encrypted TLS everywhere. SOC 2 Type II is on the roadmap for 2026 H2 as Enterprise customers begin to require it.",
  },
  {
    q: "How do I talk to a human about Enterprise pricing?",
    a: "Email legal@provara.xyz — include your expected request volume, team size, and any compliance or SLA requirements. We'll get back within one business day with a tailored quote.",
  },
];
