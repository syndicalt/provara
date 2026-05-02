import { createHash } from "node:crypto";
import type { Db } from "@provara/db";
import { contextQualityEvents } from "@provara/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tenantFilter } from "../auth/tenant.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { ChatMessage } from "../providers/types.js";
import { resolveJudgeTarget } from "../routing/judge.js";

const DEFAULT_REGRESSION_THRESHOLD = -0.5;

const CONTEXT_QUALITY_JUDGE_PROMPT = `You are a strict, impartial evaluator for RAG context optimization.

Compare two assistant answers to the same user prompt:
- RAW answer: produced with unoptimized retrieved context.
- OPTIMIZED answer: produced after context optimization.

Score each answer from 1 to 5 for whether it correctly and completely answers the prompt. Penalize missing facts, unsupported claims, irrelevant content, and ambiguity. A 5 should be rare.

Return ONLY valid JSON:
{"rawScore": N, "optimizedScore": N, "rationale": "short reason"}`;

export interface ContextQualityEvent {
  id: string;
  tenantId: string | null;
  rawScore: number;
  optimizedScore: number;
  delta: number;
  regressed: boolean;
  regressionThreshold: number;
  judgeProvider: string;
  judgeModel: string;
  promptHash: string;
  rawSourceIds: string[];
  optimizedSourceIds: string[];
  rationale: string | null;
  createdAt: Date;
}

export interface ContextQualityEvaluationInput {
  prompt: string;
  rawAnswer: string;
  optimizedAnswer: string;
  rawSourceIds?: string[];
  optimizedSourceIds?: string[];
  regressionThreshold?: number;
}

export interface ContextQualityEvaluation {
  rawScore: number;
  optimizedScore: number;
  delta: number;
  regressed: boolean;
  regressionThreshold: number;
  judge: { provider: string; model: string };
  rationale: string | null;
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

function eventFromRow(row: typeof contextQualityEvents.$inferSelect): ContextQualityEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    rawScore: row.rawScore,
    optimizedScore: row.optimizedScore,
    delta: row.delta,
    regressed: row.regressed,
    regressionThreshold: row.regressionThreshold,
    judgeProvider: row.judgeProvider,
    judgeModel: row.judgeModel,
    promptHash: row.promptHash,
    rawSourceIds: parseStringArray(row.rawSourceIds),
    optimizedSourceIds: parseStringArray(row.optimizedSourceIds),
    rationale: row.rationale,
    createdAt: row.createdAt,
  };
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function clampScore(value: unknown): number | null {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 1 || score > 5) return null;
  return Number(score.toFixed(2));
}

function parseJudgeResponse(raw: string): { rawScore: number; optimizedScore: number; rationale: string | null } | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { rawScore?: unknown; optimizedScore?: unknown; rationale?: unknown };
    const rawScore = clampScore(parsed.rawScore);
    const optimizedScore = clampScore(parsed.optimizedScore);
    if (rawScore === null || optimizedScore === null) return null;
    return {
      rawScore,
      optimizedScore,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 1000) : null,
    };
  } catch {
    return null;
  }
}

function judgeMessages(input: ContextQualityEvaluationInput): ChatMessage[] {
  return [
    { role: "system", content: CONTEXT_QUALITY_JUDGE_PROMPT },
    {
      role: "user",
      content: [
        `Prompt:\n${input.prompt}`,
        `RAW answer:\n${input.rawAnswer}`,
        `OPTIMIZED answer:\n${input.optimizedAnswer}`,
      ].join("\n\n"),
    },
  ];
}

export async function evaluateContextQuality(
  db: Db,
  registry: ProviderRegistry,
  tenantId: string | null,
  input: ContextQualityEvaluationInput,
): Promise<{ evaluation: ContextQualityEvaluation; event: ContextQualityEvent }> {
  const target = resolveJudgeTarget(registry);
  if (!target) {
    throw new Error("No judge model is configured");
  }

  const provider = registry.get(target.provider);
  if (!provider) {
    throw new Error("Configured judge provider is unavailable");
  }

  const response = await provider.complete({
    model: target.model,
    messages: judgeMessages(input),
    temperature: 0,
    max_tokens: 200,
  });
  const judged = parseJudgeResponse(response.content);
  if (!judged) {
    throw new Error("Judge returned an invalid quality score");
  }

  const regressionThreshold = input.regressionThreshold ?? DEFAULT_REGRESSION_THRESHOLD;
  const delta = Number((judged.optimizedScore - judged.rawScore).toFixed(2));
  const evaluation: ContextQualityEvaluation = {
    rawScore: judged.rawScore,
    optimizedScore: judged.optimizedScore,
    delta,
    regressed: delta <= regressionThreshold,
    regressionThreshold,
    judge: target,
    rationale: judged.rationale,
  };
  const id = nanoid();
  await db.insert(contextQualityEvents).values({
    id,
    tenantId,
    rawScore: evaluation.rawScore,
    optimizedScore: evaluation.optimizedScore,
    delta: evaluation.delta,
    regressed: evaluation.regressed,
    regressionThreshold: evaluation.regressionThreshold,
    judgeProvider: target.provider,
    judgeModel: target.model,
    promptHash: promptHash(input.prompt),
    rawSourceIds: JSON.stringify(input.rawSourceIds ?? []),
    optimizedSourceIds: JSON.stringify(input.optimizedSourceIds ?? []),
    rationale: evaluation.rationale,
  }).run();

  const row = await db.select().from(contextQualityEvents).where(eq(contextQualityEvents.id, id)).get();
  if (!row) throw new Error("Failed to record context quality event");
  return { evaluation, event: eventFromRow(row) };
}

export async function listContextQualityEvents(
  db: Db,
  tenantId: string | null,
  options: { limit?: number; regressedOnly?: boolean } = {},
): Promise<ContextQualityEvent[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const rows = await db
    .select()
    .from(contextQualityEvents)
    .where(
      options.regressedOnly
        ? and(tenantFilter(contextQualityEvents.tenantId, tenantId), eq(contextQualityEvents.regressed, true))
        : tenantFilter(contextQualityEvents.tenantId, tenantId),
    )
    .orderBy(desc(contextQualityEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map(eventFromRow);
}

export async function summarizeContextQualityEvents(db: Db, tenantId: string | null) {
  const whereClause = tenantFilter(contextQualityEvents.tenantId, tenantId);
  const row = await db
    .select({
      eventCount: sql<number>`count(*)`,
      regressedCount: sql<number>`coalesce(sum(case when ${contextQualityEvents.regressed} = 1 then 1 else 0 end), 0)`,
      avgRawScore: sql<number>`avg(${contextQualityEvents.rawScore})`,
      avgOptimizedScore: sql<number>`avg(${contextQualityEvents.optimizedScore})`,
      avgDelta: sql<number>`avg(${contextQualityEvents.delta})`,
    })
    .from(contextQualityEvents)
    .where(whereClause)
    .get();

  const latestRow = await db
    .select({ createdAt: contextQualityEvents.createdAt })
    .from(contextQualityEvents)
    .where(whereClause)
    .orderBy(desc(contextQualityEvents.createdAt))
    .limit(1)
    .get();

  return {
    eventCount: row?.eventCount ?? 0,
    regressedCount: row?.regressedCount ?? 0,
    avgRawScore: row?.avgRawScore === null || row?.avgRawScore === undefined ? null : Number(row.avgRawScore.toFixed(2)),
    avgOptimizedScore: row?.avgOptimizedScore === null || row?.avgOptimizedScore === undefined ? null : Number(row.avgOptimizedScore.toFixed(2)),
    avgDelta: row?.avgDelta === null || row?.avgDelta === undefined ? null : Number(row.avgDelta.toFixed(2)),
    latestAt: latestRow?.createdAt ?? null,
  };
}
