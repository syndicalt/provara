"use client";

/**
 * Small pill showing a subscription tier. Used in three places:
 *   - Dashboard sidebar under the user avatar (caller's current plan)
 *   - Gated section headers where a feature is locked behind a tier
 *   - <UpgradeCta /> as the visual target of the upgrade
 *
 * Colors are deliberately distinct so a glance is enough to read the
 * tier without squinting at text. Operator is amber because it's an
 * "out-of-band" status, not part of the normal upgrade ladder.
 */

type Tier = "free" | "pro" | "team" | "enterprise" | "selfhost_enterprise" | "operator";

const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  selfhost_enterprise: "Enterprise SH",
  operator: "Operator",
};

const TIER_CLASSES: Record<Tier, string> = {
  free: "bg-zinc-800 text-zinc-300 border-zinc-700",
  pro: "bg-blue-950/60 text-blue-300 border-blue-900/60",
  team: "bg-purple-950/60 text-purple-300 border-purple-900/60",
  enterprise: "bg-amber-950/60 text-amber-300 border-amber-900/60",
  selfhost_enterprise: "bg-amber-950/60 text-amber-300 border-amber-900/60",
  operator: "bg-emerald-950/60 text-emerald-300 border-emerald-900/60",
};

interface TierBadgeProps {
  tier: string;
  size?: "sm" | "xs";
  className?: string;
}

export function TierBadge({ tier, size = "xs", className = "" }: TierBadgeProps) {
  const normalized = (tier.toLowerCase() as Tier);
  const label = TIER_LABEL[normalized] ?? tier;
  const classes = TIER_CLASSES[normalized] ?? TIER_CLASSES.free;
  const sizing = size === "sm"
    ? "px-2 py-0.5 text-xs"
    : "px-1.5 py-0.5 text-[10px]";
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium uppercase tracking-wide ${sizing} ${classes} ${className}`}
    >
      {label}
    </span>
  );
}
