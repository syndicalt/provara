export type ProvaraMode = "self_hosted" | "multi_tenant";

export function getMode(): ProvaraMode {
  const mode = process.env.PROVARA_MODE;
  if (mode === "multi_tenant") return "multi_tenant";
  return "self_hosted";
}

/**
 * Whether this deployment is Provara Cloud (paid managed service) vs a
 * self-hosted install (#168). Intelligence features (auto-A/B, regression
 * detection, cost migrations) and their scheduler jobs only run on Cloud —
 * self-hosters see the code but the features refuse to start without this
 * flag set. Soft enforcement per project_monetization_enforcement.md: a
 * determined fork can remove the check, but it's enough friction that the
 * 95% case opts for the Cloud hosted experience.
 */
export function isCloudDeployment(): boolean {
  return process.env.PROVARA_CLOUD === "true";
}
