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
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  reductionPct: number;
  duplicateSourceIds: string[];
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
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    savedTokens: row.savedTokens,
    reductionPct: row.reductionPct,
    duplicateSourceIds: parseDuplicateSourceIds(row.duplicateSourceIds),
    createdAt: row.createdAt,
  };
}

export async function recordContextOptimizationEvent(
  db: Db,
  tenantId: string | null,
  result: ContextOptimizationResult,
): Promise<ContextOptimizationEvent> {
  const duplicateSourceIds = result.dropped.map((chunk) => chunk.id);
  const id = nanoid();

  await db.insert(contextOptimizationEvents).values({
    id,
    tenantId,
    inputChunks: result.metrics.inputChunks,
    outputChunks: result.metrics.outputChunks,
    droppedChunks: result.metrics.droppedChunks,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    savedTokens: result.metrics.savedTokens,
    reductionPct: result.metrics.reductionPct,
    duplicateSourceIds: JSON.stringify(duplicateSourceIds),
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
      inputTokens: sql<number>`coalesce(sum(${contextOptimizationEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${contextOptimizationEvents.outputTokens}), 0)`,
      savedTokens: sql<number>`coalesce(sum(${contextOptimizationEvents.savedTokens}), 0)`,
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
    inputTokens,
    outputTokens: row?.outputTokens ?? 0,
    savedTokens,
    reductionPct: inputTokens === 0 ? 0 : Number(((savedTokens / inputTokens) * 100).toFixed(2)),
    latestAt: latestRow?.createdAt ?? null,
  };
}
