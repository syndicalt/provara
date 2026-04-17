"use client";

/**
 * Shared empty-state for Intelligence-tier panels (#173 hotfix) when the
 * backend tier gate returns 402. Keeps the UX honest for two distinct
 * audiences:
 *
 *   - Self-hosters (reason="not_cloud"): they already have the code,
 *     they just need to enable PROVARA_CLOUD. Link to docs, no
 *     "Upgrade" button because that implies payment.
 *
 *   - Cloud customers on Free / no sub / inactive sub: render an Upgrade
 *     CTA that points at the billing dashboard or pricing page.
 *
 * Replaced by the richer <UpgradeCta /> system landing in #169 — this
 * is deliberately minimal so it can ship as a crash hotfix without
 * blocking on full billing UX work.
 */

interface GatedPanelProps {
  reason: string;
  currentTier: string;
  upgradeUrl?: string;
  feature: string;
}

export function GatedPanel({ reason, currentTier, upgradeUrl, feature }: GatedPanelProps) {
  const isSelfHost = reason === "not_cloud";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold">{feature}</h3>
      {isSelfHost ? (
        <>
          <p className="text-xs text-zinc-500 mt-2">
            Intelligence-tier features are gated on self-hosted deployments. Set{" "}
            <code className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[11px]">PROVARA_CLOUD=true</code>{" "}
            on your gateway to enable.
          </p>
          <a
            href="https://github.com/syndicalt/provara#silent-regression-detection"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-3 text-xs text-blue-400 hover:text-blue-300"
          >
            Read the docs →
          </a>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-500 mt-2">
            {reason === "inactive_status"
              ? `Your subscription needs attention before ${feature.toLowerCase()} can resume.`
              : reason === "insufficient_tier"
              ? `${feature} is available on Pro and higher plans. Your current plan: ${currentTier}.`
              : `Upgrade to Pro to enable ${feature.toLowerCase()}.`}
          </p>
          {upgradeUrl && (
            <a
              href={upgradeUrl}
              className="inline-block mt-3 px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {reason === "inactive_status" ? "Manage billing" : "Upgrade"}
            </a>
          )}
        </>
      )}
    </div>
  );
}
