import type { Db } from "@provara/db";
import { contextOptimizationEvents } from "@provara/db";
import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter } from "../auth/tenant.js";
import type { ContextOptimizationResult } from "./optimizer.js";

export interface ContextOptimizationEvent {
  id: string;
  tenantId: string | null;
  inputChunks: number;
  outputChunks: number;
  droppedChunks: number;
  nearDuplicateChunks: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  reductionPct: number;
  avgRelevanceScore: number | null;
  lowRelevanceChunks: number;
  rerankedChunks: number;
  avgFreshnessScore: number | null;
  staleChunks: number;
  conflictChunks: number;
  conflictGroups: number;
  conflictSourceIds: string[];
  conflictDetails: Array<{
    id: string;
    kind: string;
    chunkIds: [string, string];
    sourceIds: string[];
    topicTokens: string[];
    leftValue: string;
    rightValue: string;
  }>;
  duplicateSourceIds: string[];
  nearDuplicateSourceIds: string[];
  riskScanned: boolean;
  flaggedChunks: number;
  quarantinedChunks: number;
  riskySourceIds: string[];
  riskDetails: Array<{
    id: string;
    decision: string;
    ruleName: string | null;
    matchedContent: string | null;
  }>;
  createdAt: Date;
}

function parseDuplicateSourceIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function eventFromRow(row: typeof contextOptimizationEvents.$inferSelect): ContextOptimizationEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    inputChunks: row.inputChunks,
    outputChunks: row.outputChunks,
    droppedChunks: row.droppedChunks,
    nearDuplicateChunks: row.nearDuplicateChunks,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    savedTokens: row.savedTokens,
    reductionPct: row.reductionPct,
    avgRelevanceScore: row.avgRelevanceScore,
    lowRelevanceChunks: row.lowRelevanceChunks,
    rerankedChunks: row.rerankedChunks,
    avgFreshnessScore: row.avgFreshnessScore,
    staleChunks: row.staleChunks,
    conflictChunks: row.conflictChunks,
    conflictGroups: row.conflictGroups,
    conflictSourceIds: parseDuplicateSourceIds(row.conflictSourceIds),
    conflictDetails: parseConflictDetails(row.conflictDetails),
    duplicateSourceIds: parseDuplicateSourceIds(row.duplicateSourceIds),
    nearDuplicateSourceIds: parseDuplicateSourceIds(row.nearDuplicateSourceIds),
    riskScanned: row.riskScanned,
    flaggedChunks: row.flaggedChunks,
    quarantinedChunks: row.quarantinedChunks,
    riskySourceIds: parseDuplicateSourceIds(row.riskySourceIds),
    riskDetails: parseRiskDetails(row.riskDetails),
    createdAt: row.createdAt,
  };
}

function parseRiskDetails(value: string | null): ContextOptimizationEvent["riskDetails"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ContextOptimizationEvent["riskDetails"][number] => (
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.decision === "string" &&
      (typeof item.ruleName === "string" || item.ruleName === null) &&
      (typeof item.matchedContent === "string" || item.matchedContent === null)
    ));
  } catch {
    return [];
  }
}

function parseConflictDetails(value: string | null): ContextOptimizationEvent["conflictDetails"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ContextOptimizationEvent["conflictDetails"][number] => (
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.kind === "string" &&
      Array.isArray(item.chunkIds) &&
      item.chunkIds.length === 2 &&
      item.chunkIds.every((id: unknown) => typeof id === "string") &&
      Array.isArray(item.sourceIds) &&
      item.sourceIds.every((id: unknown) => typeof id === "string") &&
      Array.isArray(item.topicTokens) &&
      item.topicTokens.every((token: unknown) => typeof token === "string") &&
      typeof item.leftValue === "string" &&
      typeof item.rightValue === "string"
    ));
  } catch {
    return [];
  }
}

export async function recordContextOptimizationEvent(
  db: Db,
  tenantId: string | null,
  result: ContextOptimizationResult,
  options: { riskScanned?: boolean } = {},
): Promise<ContextOptimizationEvent> {
  const duplicateSourceIds = result.dropped
    .filter((chunk) => chunk.reason === "duplicate")
    .map((chunk) => chunk.id);
  const nearDuplicateSourceIds = result.dropped
    .filter((chunk) => chunk.reason === "near_duplicate")
    .map((chunk) => chunk.id);
  const conflictSourceIds = [...new Set(result.conflicts.flatMap((conflict) => conflict.sourceIds))];
  const conflictDetails = result.conflicts.map((conflict) => ({
    id: conflict.id,
    kind: conflict.kind,
    chunkIds: conflict.chunkIds,
    sourceIds: conflict.sourceIds,
    topicTokens: conflict.topicTokens,
    leftValue: conflict.leftValue,
    rightValue: conflict.rightValue,
  }));
  const riskyChunks = [...result.flagged, ...result.quarantined];
  const riskDetails = riskyChunks.map((chunk) => ({
    id: chunk.id,
    decision: chunk.decision,
    ruleName: chunk.ruleName,
    matchedContent: chunk.matchedContent,
  }));
  const riskySourceIds = riskyChunks.flatMap((chunk) => chunk.sourceIds);
  const id = nanoid();

  await db.insert(contextOptimizationEvents).values({
    id,
    tenantId,
    inputChunks: result.metrics.inputChunks,
    outputChunks: result.metrics.outputChunks,
    droppedChunks: result.metrics.droppedChunks,
    nearDuplicateChunks: result.metrics.nearDuplicateChunks,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    savedTokens: result.metrics.savedTokens,
    reductionPct: result.metrics.reductionPct,
    avgRelevanceScore: result.metrics.avgRelevanceScore,
    lowRelevanceChunks: result.metrics.lowRelevanceChunks,
    rerankedChunks: result.metrics.rerankedChunks,
    avgFreshnessScore: result.metrics.avgFreshnessScore,
    staleChunks: result.metrics.staleChunks,
    conflictChunks: result.metrics.conflictChunks,
    conflictGroups: result.metrics.conflictGroups,
    conflictSourceIds: JSON.stringify(conflictSourceIds),
    conflictDetails: JSON.stringify(conflictDetails),
    duplicateSourceIds: JSON.stringify(duplicateSourceIds),
    nearDuplicateSourceIds: JSON.stringify(nearDuplicateSourceIds),
    riskScanned: options.riskScanned ?? false,
    flaggedChunks: result.metrics.flaggedChunks,
    quarantinedChunks: result.metrics.quarantinedChunks,
    riskySourceIds: JSON.stringify(riskySourceIds),
    riskDetails: JSON.stringify(riskDetails),
  }).run();

  const row = await db
    .select()
    .from(contextOptimizationEvents)
    .where(eq(contextOptimizationEvents.id, id))
    .get();

  if (!row) throw new Error("Failed to record context optimization event");
  return eventFromRow(row);
}

export async function listContextOptimizationEvents(
  db: Db,
  tenantId: string | null,
  options: { limit?: number } = {},
): Promise<ContextOptimizationEvent[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const rows = await db
    .select()
    .from(contextOptimizationEvents)
    .where(tenantFilter(contextOptimizationEvents.tenantId, tenantId))
    .orderBy(desc(contextOptimizationEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map(eventFromRow);
}

export async function summarizeContextOptimizationEvents(db: Db, tenantId: string | null) {
  const whereClause = tenantFilter(contextOptimizationEvents.tenantId, tenantId);
  const row = await db
    .select({
      eventCount: sql<number>`count(*)`,
      inputChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.inputChunks}), 0)`,
      outputChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.outputChunks}), 0)`,
      droppedChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.droppedChunks}), 0)`,
      nearDuplicateChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.nearDuplicateChunks}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${contextOptimizationEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${contextOptimizationEvents.outputTokens}), 0)`,
      savedTokens: sql<number>`coalesce(sum(${contextOptimizationEvents.savedTokens}), 0)`,
      avgRelevanceScore: sql<number | null>`avg(${contextOptimizationEvents.avgRelevanceScore})`,
      lowRelevanceChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.lowRelevanceChunks}), 0)`,
      rerankedChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.rerankedChunks}), 0)`,
      avgFreshnessScore: sql<number | null>`avg(${contextOptimizationEvents.avgFreshnessScore})`,
      staleChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.staleChunks}), 0)`,
      conflictChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.conflictChunks}), 0)`,
      conflictGroups: sql<number>`coalesce(sum(${contextOptimizationEvents.conflictGroups}), 0)`,
      flaggedChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.flaggedChunks}), 0)`,
      quarantinedChunks: sql<number>`coalesce(sum(${contextOptimizationEvents.quarantinedChunks}), 0)`,
    })
    .from(contextOptimizationEvents)
    .where(whereClause)
    .get();

  const eventCount = row?.eventCount ?? 0;
  const inputTokens = row?.inputTokens ?? 0;
  const savedTokens = row?.savedTokens ?? 0;

  const latestRow = await db
    .select({ createdAt: contextOptimizationEvents.createdAt })
    .from(contextOptimizationEvents)
    .where(whereClause)
    .orderBy(desc(contextOptimizationEvents.createdAt))
    .limit(1)
    .get();

  return {
    eventCount,
    inputChunks: row?.inputChunks ?? 0,
    outputChunks: row?.outputChunks ?? 0,
    droppedChunks: row?.droppedChunks ?? 0,
    nearDuplicateChunks: row?.nearDuplicateChunks ?? 0,
    flaggedChunks: row?.flaggedChunks ?? 0,
    quarantinedChunks: row?.quarantinedChunks ?? 0,
    inputTokens,
    outputTokens: row?.outputTokens ?? 0,
    savedTokens,
    reductionPct: inputTokens === 0 ? 0 : Number(((savedTokens / inputTokens) * 100).toFixed(2)),
    avgRelevanceScore: row?.avgRelevanceScore === null || row?.avgRelevanceScore === undefined
      ? null
      : Number(row.avgRelevanceScore.toFixed(4)),
    lowRelevanceChunks: row?.lowRelevanceChunks ?? 0,
    rerankedChunks: row?.rerankedChunks ?? 0,
    avgFreshnessScore: row?.avgFreshnessScore === null || row?.avgFreshnessScore === undefined
      ? null
      : Number(row.avgFreshnessScore.toFixed(4)),
    staleChunks: row?.staleChunks ?? 0,
    conflictChunks: row?.conflictChunks ?? 0,
    conflictGroups: row?.conflictGroups ?? 0,
    latestAt: latestRow?.createdAt ?? null,
  };
}
