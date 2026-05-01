import type { Db } from "@provara/db";
import { firewallEvents } from "@provara/db";
import { nanoid } from "nanoid";
import type { GuardrailScanDecision, GuardrailScanSource } from "./engine.js";

export type FirewallEventSurface = "scan" | "tool_call_alignment";
export type FirewallEventMode = "signature" | "semantic" | "hybrid";

export interface FirewallEventInput {
  tenantId: string | null;
  requestId?: string | null;
  surface: FirewallEventSurface;
  source?: GuardrailScanSource | null;
  mode?: FirewallEventMode | null;
  decision: GuardrailScanDecision;
  action?: GuardrailScanDecision;
  passed: boolean;
  confidence?: number | null;
  riskLevel?: string | null;
  category?: string | null;
  toolName?: string | null;
  ruleName?: string | null;
  matchedContent?: string | null;
  details?: Record<string, unknown> | null;
}

export async function recordFirewallEvent(db: Db, event: FirewallEventInput): Promise<void> {
  await db.insert(firewallEvents).values({
    id: nanoid(),
    tenantId: event.tenantId,
    requestId: event.requestId ?? null,
    surface: event.surface,
    source: event.source ?? null,
    mode: event.mode ?? null,
    decision: event.decision,
    action: event.action ?? event.decision,
    passed: event.passed,
    confidence: event.confidence ?? null,
    riskLevel: event.riskLevel ?? null,
    category: event.category ?? null,
    toolName: event.toolName ?? null,
    ruleName: event.ruleName ?? null,
    matchedContent: event.matchedContent ?? null,
    details: event.details ? JSON.stringify(event.details) : null,
  }).run();
}
