export type ProvaraMode = "self_hosted" | "multi_tenant";

export function getMode(): ProvaraMode {
  const mode = process.env.PROVARA_MODE;
  if (mode === "multi_tenant") return "multi_tenant";
  return "self_hosted";
}
