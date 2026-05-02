import type { Db } from "@provara/db";
import { alertLogs, alertRules, contextCanonicalBlocks, contextCanonicalReviewEvents } from "@provara/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter } from "../auth/tenant.js";

export const CONTEXT_POLICY_FAILURES_METRIC = "context_policy_failures";
export const CONTEXT_STALE_DRAFTS_METRIC = "context_stale_drafts";
export const CONTEXT_APPROVED_EXPORT_DELTA_METRIC = "context_approved_export_delta";

export type ContextGovernanceMetric =
  | typeof CONTEXT_POLICY_FAILURES_METRIC
  | typeof CONTEXT_STALE_DRAFTS_METRIC
  | typeof CONTEXT_APPROVED_EXPORT_DELTA_METRIC;

const DEFAULT_CONTEXT_ALERT_RULES: Record<ContextGovernanceMetric, {
  name: string;
  condition: "gt" | "lt" | "gte" | "lte";
  threshold: number;
  window: "1h" | "6h" | "24h" | "7d";
}> = {
  context_policy_failures: {
    name: "Context policy failures",
    condition: "gt",
    threshold: 0,
    window: "1h",
  },
  context_stale_drafts: {
    name: "Stale canonical review queue",
    condition: "gt",
    threshold: 0,
    window: "24h",
  },
  context_approved_export_delta: {
    name: "Approved context export change",
    condition: "gte",
    threshold: 10,
    window: "24h",
  },
};

export async function ensureContextGovernanceAlertRule(
  db: Db,
  tenantId: string | null,
  metric: ContextGovernanceMetric,
) {
  const tenantClause = tenantFilter(alertRules.tenantId, tenantId);
  const whereClause = tenantClause
    ? and(eq(alertRules.metric, metric), tenantClause)
    : eq(alertRules.metric, metric);
  const existing = await db.select().from(alertRules).where(whereClause).get();
  if (existing) return existing;

  const defaults = DEFAULT_CONTEXT_ALERT_RULES[metric];
  const id = nanoid();
  await db.insert(alertRules).values({
    id,
    tenantId,
    name: defaults.name,
    metric,
    condition: defaults.condition,
    threshold: defaults.threshold,
    window: defaults.window,
    channel: "webhook",
    webhookUrl: null,
    enabled: true,
  }).run();

  const created = await db.select().from(alertRules).where(eq(alertRules.id, id)).get();
  if (!created) throw new Error("Failed to create context governance alert rule");
  return created;
}

export async function ensureContextGovernanceAlertRules(db: Db, tenantId: string | null) {
  await ensureContextGovernanceAlertRule(db, tenantId, CONTEXT_POLICY_FAILURES_METRIC);
  await ensureContextGovernanceAlertRule(db, tenantId, CONTEXT_STALE_DRAFTS_METRIC);
  await ensureContextGovernanceAlertRule(db, tenantId, CONTEXT_APPROVED_EXPORT_DELTA_METRIC);
}

export async function recordContextPolicyFailureAlert(
  db: Db,
  tenantId: string | null,
  details: { blockId: string; decision: string; violationCount: number },
): Promise<void> {
  const rule = await ensureContextGovernanceAlertRule(db, tenantId, CONTEXT_POLICY_FAILURES_METRIC);
  if (!rule.enabled) return;

  await db.insert(alertLogs).values({
    id: nanoid(),
    ruleId: rule.id,
    ruleName: `${rule.name}: ${details.blockId} ${details.decision}`,
    metric: CONTEXT_POLICY_FAILURES_METRIC,
    value: Math.max(1, details.violationCount),
    threshold: rule.threshold,
  }).run();

  await db.update(alertRules)
    .set({ lastTriggeredAt: new Date() })
    .where(eq(alertRules.id, rule.id))
    .run();
}

export async function countStaleCanonicalDrafts(
  db: Db,
  tenantId: string | null,
  olderThan: Date,
): Promise<number> {
  const conditions = [
    eq(contextCanonicalBlocks.reviewStatus, "draft"),
    lt(contextCanonicalBlocks.updatedAt, olderThan),
  ];
  const tenantClause = tenantFilter(contextCanonicalBlocks.tenantId, tenantId);
  if (tenantClause) conditions.push(tenantClause);

  const row = await db.select({ count: sql<number>`count(*)` })
    .from(contextCanonicalBlocks)
    .where(and(...conditions))
    .get();
  return row?.count ?? 0;
}

export async function countApprovedContextDelta(
  db: Db,
  tenantId: string | null,
  since: Date,
): Promise<number> {
  const conditions = [
    eq(contextCanonicalReviewEvents.toStatus, "approved"),
    gte(contextCanonicalReviewEvents.createdAt, since),
  ];
  const tenantClause = tenantFilter(contextCanonicalReviewEvents.tenantId, tenantId);
  if (tenantClause) conditions.push(tenantClause);

  const row = await db.select({ count: sql<number>`count(*)` })
    .from(contextCanonicalReviewEvents)
    .where(and(...conditions))
    .get();
  return row?.count ?? 0;
}
