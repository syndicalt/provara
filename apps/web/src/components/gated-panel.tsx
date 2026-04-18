"use client";

import { TierBadge } from "./tier-badge";

/**
 * Shared empty-state for Intelligence-tier panels when the backend tier
 * gate returns 402. Keeps the UX honest for two distinct audiences:
 *
 *   - Self-hosters (reason="not_cloud"): they already have the code,
 *     they just need to enable PROVARA_CLOUD. Link to docs, no
 *     "Upgrade" button because that implies payment.
 *
 *   - Cloud customers on Free / no sub / inactive sub: render a richer
 *     Upgrade CTA showing current tier vs required tier with a button
 *     that routes to the dashboard billing page instead of the external
 *     pricing site. Upgraded in #169.
 */

interface GatedPanelProps {
  reason: string;
  currentTier: string;
  upgradeUrl?: string;
  feature: string;
  /** Required tier to unlock this feature. Defaults to "pro" since all
   *  current Intelligence features unlock at Pro. */
  requiredTier?: string;
}

export function GatedPanel({ reason, currentTier, upgradeUrl, feature, requiredTier = "pro" }: GatedPanelProps) {
  const isSelfHost = reason === "not_cloud";
  const isInactive = reason === "inactive_status";
  // Route Cloud users to the in-dashboard billing page rather than the
  // external pricing site — they're already signed in, they can upgrade
  // without leaving the product.
  const dashboardBillingHref = "/dashboard/billing";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{feature}</h3>
            {!isSelfHost && <TierBadge tier={requiredTier} size="xs" />}
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            {isSelfHost ? (
              <>
                Intelligence-tier features are gated on self-hosted deployments. Set{" "}
                <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[11px]">PROVARA_CLOUD=true</code>{" "}
                on your gateway to enable.
              </>
            ) : isInactive ? (
              `Your subscription needs attention before ${feature.toLowerCase()} can resume.`
            ) : reason === "insufficient_tier" ? (
              `${feature} is available on Pro and higher plans.`
            ) : (
              `Upgrade to Pro to enable ${feature.toLowerCase()}.`
            )}
          </p>
          {!isSelfHost && currentTier && currentTier !== requiredTier && (
            <div className="flex items-center gap-2 mt-3 text-[11px] text-zinc-500">
              Current plan:
              <TierBadge tier={currentTier} size="xs" />
            </div>
          )}
        </div>
      </div>
      <div className="mt-4">
        {isSelfHost ? (
          <a
            href="https://github.com/syndicalt/provara#silent-regression-detection"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Read the docs →
          </a>
        ) : (
          <a
            href={dashboardBillingHref}
            className="inline-block px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            {isInactive ? "Manage billing" : `Upgrade to ${requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)}`}
          </a>
        )}
        {upgradeUrl && !isSelfHost && (
          <a
            href={upgradeUrl}
            className="ml-2 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Compare plans →
          </a>
        )}
      </div>
    </div>
  );
}
