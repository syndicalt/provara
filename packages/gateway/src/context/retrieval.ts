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
  efficiencyPct: number;
  duplicateRatePct: number;
  nearDuplicateRatePct: number;
  riskyRatePct: number;
  usedSourceIds: string[];
  unusedSourceIds: string[];
  riskySourceIds: string[];
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
    efficiencyPct: row.efficiencyPct,
    duplicateRatePct: row.duplicateRatePct,
    nearDuplicateRatePct: row.nearDuplicateRatePct,
    riskyRatePct: row.riskyRatePct,
    usedSourceIds: parseStringArray(row.usedSourceIds),
    unusedSourceIds: parseStringArray(row.unusedSourceIds),
    riskySourceIds: parseStringArray(row.riskySourceIds),
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
  const unusedSourceIds = unique([
    ...result.dropped.map((chunk) => chunk.id),
    ...riskySourceIds,
  ]);
  const retrievedChunks = result.metrics.inputChunks;
  const usedChunks = result.metrics.outputChunks;
  const unusedChunks = Math.max(0, retrievedChunks - usedChunks);
  const duplicateChunks = result.metrics.droppedChunks;
  const nearDuplicateChunks = result.metrics.nearDuplicateChunks;
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
    efficiencyPct: pct(usedTokens, retrievedTokens),
    duplicateRatePct: pct(duplicateChunks, retrievedChunks),
    nearDuplicateRatePct: pct(nearDuplicateChunks, retrievedChunks),
    riskyRatePct: pct(riskyChunkCount, retrievedChunks),
    usedSourceIds: JSON.stringify(usedSourceIds),
    unusedSourceIds: JSON.stringify(unusedSourceIds),
    riskySourceIds: JSON.stringify(riskySourceIds),
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
    efficiencyPct: pct(usedTokens, retrievedTokens),
    duplicateRatePct: pct(row?.duplicateChunks ?? 0, retrievedChunks),
    nearDuplicateRatePct: pct(row?.nearDuplicateChunks ?? 0, retrievedChunks),
    riskyRatePct: pct(row?.riskyChunks ?? 0, retrievedChunks),
    latestAt: latestRow?.createdAt ?? null,
  };
}
