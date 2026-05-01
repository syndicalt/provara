import type { Db } from "@provara/db";
import { firewallSettings } from "@provara/db";
import { eq } from "drizzle-orm";

export type FirewallScanMode = "signature" | "semantic" | "hybrid";
export type ToolCallAlignmentMode = "off" | "flag" | "block";

export interface FirewallSettings {
  tenantId: string | null;
  defaultScanMode: FirewallScanMode;
  toolCallAlignment: ToolCallAlignmentMode;
  streamingEnforcement: boolean;
}

export const DEFAULT_FIREWALL_SETTINGS: FirewallSettings = {
  tenantId: null,
  defaultScanMode: "signature",
  toolCallAlignment: "block",
  streamingEnforcement: true,
};

export const FIREWALL_SCAN_MODES = new Set<FirewallScanMode>(["signature", "semantic", "hybrid"]);
export const TOOL_CALL_ALIGNMENT_MODES = new Set<ToolCallAlignmentMode>(["off", "flag", "block"]);

const SELF_HOSTED_SETTINGS_KEY = "__self_hosted__";

function settingsKey(tenantId: string | null): string {
  return tenantId ?? SELF_HOSTED_SETTINGS_KEY;
}

export async function getFirewallSettings(
  db: Db,
  tenantId: string | null,
): Promise<FirewallSettings> {
  const key = settingsKey(tenantId);
  const row = await db
    .select()
    .from(firewallSettings)
    .where(eq(firewallSettings.tenantId, key))
    .get();
  if (!row) return { ...DEFAULT_FIREWALL_SETTINGS, tenantId };
  return {
    tenantId,
    defaultScanMode: row.defaultScanMode as FirewallScanMode,
    toolCallAlignment: row.toolCallAlignment as ToolCallAlignmentMode,
    streamingEnforcement: row.streamingEnforcement,
  };
}

export async function upsertFirewallSettings(
  db: Db,
  tenantId: string | null,
  patch: Partial<Omit<FirewallSettings, "tenantId">>,
): Promise<FirewallSettings> {
  const current = await getFirewallSettings(db, tenantId);
  const key = settingsKey(tenantId);
  const next = {
    defaultScanMode: patch.defaultScanMode ?? current.defaultScanMode,
    toolCallAlignment: patch.toolCallAlignment ?? current.toolCallAlignment,
    streamingEnforcement: patch.streamingEnforcement ?? current.streamingEnforcement,
  };
  const now = new Date();
  await db
    .insert(firewallSettings)
    .values({
      tenantId: key,
      ...next,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: firewallSettings.tenantId,
      set: {
        ...next,
        updatedAt: now,
      },
    })
    .run();
  return { tenantId, ...next };
}
