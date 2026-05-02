import type { Db } from "@provara/db";
import { contextRetrievalEvents } from "@provara/db";
import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter } from "../auth/tenant.js";
import type { ContextOptimizationResult } from "./optimizer.js";

export interface ContextRetrievalEvent {
  id: string;
  tenantId: string | null;
  optimizationEventId: string | null;
  retrievedChunks: number;
  usedChunks: number;
  unusedChunks: number;
  duplicateChunks: number;
  nearDuplicateChunks: number;
  riskyChunks: number;
  retrievedTokens: number;
  usedTokens: number;
  unusedTokens: number;
  avgRelevanceScore: number | null;
  lowRelevanceChunks: number;
  rerankedChunks: number;
  avgFreshnessScore: number | null;
  staleChunks: number;
  conflictChunks: number;
  conflictGroups: number;
  compressedChunks: number;
  compressionSavedTokens: number;
  compressionRatePct: number;
  efficiencyPct: number;
  duplicateRatePct: number;
  nearDuplicateRatePct: number;
  riskyRatePct: number;
  conflictRatePct: number;
  usedSourceIds: string[];
  unusedSourceIds: string[];
  riskySourceIds: string[];
  conflictSourceIds: string[];
  createdAt: Date;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function eventFromRow(row: typeof contextRetrievalEvents.$inferSelect): ContextRetrievalEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    optimizationEventId: row.optimizationEventId,
    retrievedChunks: row.retrievedChunks,
    usedChunks: row.usedChunks,
    unusedChunks: row.unusedChunks,
    duplicateChunks: row.duplicateChunks,
    nearDuplicateChunks: row.nearDuplicateChunks,
    riskyChunks: row.riskyChunks,
    retrievedTokens: row.retrievedTokens,
    usedTokens: row.usedTokens,
    unusedTokens: row.unusedTokens,
    avgRelevanceScore: row.avgRelevanceScore,
    lowRelevanceChunks: row.lowRelevanceChunks,
    rerankedChunks: row.rerankedChunks,
    avgFreshnessScore: row.avgFreshnessScore,
    staleChunks: row.staleChunks,
    conflictChunks: row.conflictChunks,
    conflictGroups: row.conflictGroups,
    compressedChunks: row.compressedChunks,
    compressionSavedTokens: row.compressionSavedTokens,
    compressionRatePct: row.compressionRatePct,
    efficiencyPct: row.efficiencyPct,
    duplicateRatePct: row.duplicateRatePct,
    nearDuplicateRatePct: row.nearDuplicateRatePct,
    riskyRatePct: row.riskyRatePct,
    conflictRatePct: row.conflictRatePct,
    usedSourceIds: parseStringArray(row.usedSourceIds),
    unusedSourceIds: parseStringArray(row.unusedSourceIds),
    riskySourceIds: parseStringArray(row.riskySourceIds),
    conflictSourceIds: parseStringArray(row.conflictSourceIds),
    createdAt: row.createdAt,
  };
}

export async function recordContextRetrievalEvent(
  db: Db,
  tenantId: string | null,
  result: ContextOptimizationResult,
  options: { optimizationEventId?: string | null } = {},
): Promise<ContextRetrievalEvent> {
  const riskyChunks = [...result.flagged, ...result.quarantined];
  const usedSourceIds = unique(result.optimized.map((chunk) => chunk.id));
  const riskySourceIds = unique(riskyChunks.flatMap((chunk) => chunk.sourceIds));
  const conflictSourceIds = unique(result.conflicts.flatMap((conflict) => conflict.sourceIds));
  const unusedSourceIds = unique([
    ...result.dropped.map((chunk) => chunk.id),
    ...riskySourceIds,
  ]);
  const retrievedChunks = result.metrics.inputChunks;
  const usedChunks = result.metrics.outputChunks;
  const unusedChunks = Math.max(0, retrievedChunks - usedChunks);
  const duplicateChunks = result.metrics.droppedChunks;
  const nearDuplicateChunks = result.metrics.nearDuplicateChunks;
  const conflictChunks = result.metrics.conflictChunks;
  const conflictGroups = result.metrics.conflictGroups;
  const compressedChunks = result.metrics.compressedChunks;
  const compressionSavedTokens = result.metrics.compressionSavedTokens;
  const riskyChunkCount = result.metrics.flaggedChunks + result.metrics.quarantinedChunks;
  const retrievedTokens = result.metrics.inputTokens;
  const usedTokens = result.metrics.outputTokens;
  const unusedTokens = Math.max(0, retrievedTokens - usedTokens);
  const id = nanoid();

  await db.insert(contextRetrievalEvents).values({
    id,
    tenantId,
    optimizationEventId: options.optimizationEventId ?? null,
    retrievedChunks,
    usedChunks,
    unusedChunks,
    duplicateChunks,
    nearDuplicateChunks,
    riskyChunks: riskyChunkCount,
    retrievedTokens,
    usedTokens,
    unusedTokens,
    avgRelevanceScore: result.metrics.avgRelevanceScore,
    lowRelevanceChunks: result.metrics.lowRelevanceChunks,
    rerankedChunks: result.metrics.rerankedChunks,
    avgFreshnessScore: result.metrics.avgFreshnessScore,
    staleChunks: result.metrics.staleChunks,
    conflictChunks,
    conflictGroups,
    compressedChunks,
    compressionSavedTokens,
    compressionRatePct: result.metrics.compressionRatePct,
    efficiencyPct: pct(usedTokens, retrievedTokens),
    duplicateRatePct: pct(duplicateChunks, retrievedChunks),
    nearDuplicateRatePct: pct(nearDuplicateChunks, retrievedChunks),
    riskyRatePct: pct(riskyChunkCount, retrievedChunks),
    conflictRatePct: pct(conflictChunks, retrievedChunks),
    usedSourceIds: JSON.stringify(usedSourceIds),
    unusedSourceIds: JSON.stringify(unusedSourceIds),
    riskySourceIds: JSON.stringify(riskySourceIds),
    conflictSourceIds: JSON.stringify(conflictSourceIds),
  }).run();

  const row = await db.select().from(contextRetrievalEvents).where(eq(contextRetrievalEvents.id, id)).get();
  if (!row) throw new Error("Failed to record context retrieval event");
  return eventFromRow(row);
}

export async function listContextRetrievalEvents(
  db: Db,
  tenantId: string | null,
  options: { limit?: number } = {},
): Promise<ContextRetrievalEvent[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const rows = await db
    .select()
    .from(contextRetrievalEvents)
    .where(tenantFilter(contextRetrievalEvents.tenantId, tenantId))
    .orderBy(desc(contextRetrievalEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map(eventFromRow);
}

export async function summarizeContextRetrievalEvents(db: Db, tenantId: string | null) {
  const whereClause = tenantFilter(contextRetrievalEvents.tenantId, tenantId);
  const row = await db
    .select({
      eventCount: sql<number>`count(*)`,
      retrievedChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.retrievedChunks}), 0)`,
      usedChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.usedChunks}), 0)`,
      unusedChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.unusedChunks}), 0)`,
      duplicateChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.duplicateChunks}), 0)`,
      nearDuplicateChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.nearDuplicateChunks}), 0)`,
      riskyChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.riskyChunks}), 0)`,
      retrievedTokens: sql<number>`coalesce(sum(${contextRetrievalEvents.retrievedTokens}), 0)`,
      usedTokens: sql<number>`coalesce(sum(${contextRetrievalEvents.usedTokens}), 0)`,
      unusedTokens: sql<number>`coalesce(sum(${contextRetrievalEvents.unusedTokens}), 0)`,
      avgRelevanceScore: sql<number | null>`avg(${contextRetrievalEvents.avgRelevanceScore})`,
      lowRelevanceChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.lowRelevanceChunks}), 0)`,
      rerankedChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.rerankedChunks}), 0)`,
      avgFreshnessScore: sql<number | null>`avg(${contextRetrievalEvents.avgFreshnessScore})`,
      staleChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.staleChunks}), 0)`,
      conflictChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.conflictChunks}), 0)`,
      conflictGroups: sql<number>`coalesce(sum(${contextRetrievalEvents.conflictGroups}), 0)`,
      compressedChunks: sql<number>`coalesce(sum(${contextRetrievalEvents.compressedChunks}), 0)`,
      compressionSavedTokens: sql<number>`coalesce(sum(${contextRetrievalEvents.compressionSavedTokens}), 0)`,
    })
    .from(contextRetrievalEvents)
    .where(whereClause)
    .get();

  const retrievedChunks = row?.retrievedChunks ?? 0;
  const retrievedTokens = row?.retrievedTokens ?? 0;
  const usedTokens = row?.usedTokens ?? 0;
  const latestRow = await db
    .select({ createdAt: contextRetrievalEvents.createdAt })
    .from(contextRetrievalEvents)
    .where(whereClause)
    .orderBy(desc(contextRetrievalEvents.createdAt))
    .limit(1)
    .get();

  return {
    eventCount: row?.eventCount ?? 0,
    retrievedChunks,
    usedChunks: row?.usedChunks ?? 0,
    unusedChunks: row?.unusedChunks ?? 0,
    duplicateChunks: row?.duplicateChunks ?? 0,
    nearDuplicateChunks: row?.nearDuplicateChunks ?? 0,
    riskyChunks: row?.riskyChunks ?? 0,
    retrievedTokens,
    usedTokens,
    unusedTokens: row?.unusedTokens ?? 0,
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
    compressedChunks: row?.compressedChunks ?? 0,
    compressionSavedTokens: row?.compressionSavedTokens ?? 0,
    compressionRatePct: retrievedTokens === 0
      ? 0
      : Number((((row?.compressionSavedTokens ?? 0) / retrievedTokens) * 100).toFixed(2)),
    efficiencyPct: pct(usedTokens, retrievedTokens),
    duplicateRatePct: pct(row?.duplicateChunks ?? 0, retrievedChunks),
    nearDuplicateRatePct: pct(row?.nearDuplicateChunks ?? 0, retrievedChunks),
    riskyRatePct: pct(row?.riskyChunks ?? 0, retrievedChunks),
    conflictRatePct: pct(row?.conflictChunks ?? 0, retrievedChunks),
    latestAt: latestRow?.createdAt ?? null,
  };
}
