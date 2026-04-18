import type { Db } from "@provara/db";
import {
  replayBank,
  regressionEvents,
  requests,
  feedback,
  appConfig,
} from "@provara/db";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ProviderRegistry } from "../../providers/index.js";
import type { EmbeddingProvider } from "../../embeddings/index.js";
import { cosineSimilarity, encodeEmbedding, decodeEmbedding } from "../../embeddings/index.js";
import { calculateCost } from "../../cost/pricing.js";
import { tenantHasIntelligenceAccess } from "../../auth/tier.js";

function numEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Cap of entries per (tenant × cell × model) in the replay bank. */
export const REPLAY_BANK_MAX_PER_CELL = intEnv(process.env.PROVARA_REPLAY_BANK_MAX, 25);

/** Minimum score a historical prompt must have to enter the bank. */
export const REPLAY_BANK_MIN_SCORE = numEnv(process.env.PROVARA_REPLAY_BANK_MIN_SCORE, 4);

/** Replays per cycle per cell when the replay job fires. */
export const REPLAY_SAMPLE_K = intEnv(process.env.PROVARA_REPLAY_SAMPLE_K, 5);

/** A regression fires when `replayMean - originalMean` falls below this. */
export const REGRESSION_DELTA_THRESHOLD = numEnv(process.env.PROVARA_REGRESSION_DELTA, -0.5);

/** Default weekly per-tenant budget, in USD. Prevents runaway costs when judge or replay loops misbehave. */
export const REPLAY_WEEKLY_BUDGET_USD = numEnv(process.env.PROVARA_REPLAY_BUDGET_USD, 5);

/** Minimum cosine distance between a new candidate and existing bank entries. 1 − similarity. */
export const REPLAY_DIVERSITY_THRESHOLD = numEnv(process.env.PROVARA_REPLAY_DIVERSITY, 0.1);

const OPT_IN_CONFIG_PREFIX = "regression_opt_in:";
const BUDGET_USAGE_PREFIX = "regression_budget:";

function optInKey(tenantId: string | null): string {
  return `${OPT_IN_CONFIG_PREFIX}${tenantId ?? "_global"}`;
}

function budgetKey(tenantId: string | null): string {
  // Week is ISO week-of-year. Roll over automatically by including it.
  const now = new Date();
  const year = now.getUTCFullYear();
  const week = Math.ceil(
    ((now.getTime() - Date.UTC(year, 0, 1)) / 86400000 + new Date(Date.UTC(year, 0, 1)).getUTCDay() + 1) / 7,
  );
  return `${BUDGET_USAGE_PREFIX}${tenantId ?? "_global"}:${year}-${week}`;
}

export async function isRegressionDetectionEnabled(db: Db, tenantId: string | null): Promise<boolean> {
  const row = await db.select().from(appConfig).where(eq(appConfig.key, optInKey(tenantId))).get();
  return row?.value === "true";
}

export async function setRegressionOptIn(db: Db, tenantId: string | null, enabled: boolean): Promise<void> {
  const now = new Date();
  const value = enabled ? "true" : "false";
  await db
    .insert(appConfig)
    .values({ key: optInKey(tenantId), value, updatedAt: now })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: now } })
    .run();
}

async function getBudgetUsage(db: Db, tenantId: string | null): Promise<number> {
  const row = await db.select().from(appConfig).where(eq(appConfig.key, budgetKey(tenantId))).get();
  if (!row) return 0;
  const parsed = parseFloat(row.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function addBudgetUsage(db: Db, tenantId: string | null, costUsd: number): Promise<void> {
  const current = await getBudgetUsage(db, tenantId);
  const next = current + costUsd;
  const now = new Date();
  await db
    .insert(appConfig)
    .values({ key: budgetKey(tenantId), value: next.toString(), updatedAt: now })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: next.toString(), updatedAt: now } })
    .run();
}

export async function getBudgetStatus(db: Db, tenantId: string | null) {
  const used = await getBudgetUsage(db, tenantId);
  return { used, limit: REPLAY_WEEKLY_BUDGET_USD, remaining: Math.max(0, REPLAY_WEEKLY_BUDGET_USD - used) };
}

interface CellGroup {
  tenantId: string | null;
  taskType: string;
  complexity: string;
  provider: string;
  model: string;
}

async function distinctEligibleCells(db: Db): Promise<CellGroup[]> {
  const rows = await db
    .select({
      tenantId: requests.tenantId,
      taskType: requests.taskType,
      complexity: requests.complexity,
      provider: requests.provider,
      model: requests.model,
    })
    .from(requests)
    .groupBy(requests.tenantId, requests.taskType, requests.complexity, requests.provider, requests.model)
    .all();
  return rows.filter(
    (r): r is CellGroup => r.taskType !== null && r.complexity !== null,
  );
}

/**
 * Pull candidate prompts for the bank. Uses the most recent high-rated
 * requests for the (tenant, cell, model) combo, joined with their
 * feedback score. Returns candidates sorted by recency — embedding-based
 * diversity filtering happens in `populateBankForCell`.
 *
 * Only judge-scored feedback qualifies (#160). User ratings are systematically
 * more generous than the judge ("A 5 should be rare" per the judge prompt),
 * so mixing user baselines with judge replays produced a consistent false-
 * positive regression signal on every cell. Restricting to judge source
 * means baseline and replay come from the same grader — apples to apples.
 */
async function fetchCandidates(db: Db, cell: CellGroup, limit = 200) {
  const baseWhere = and(
    cell.tenantId ? eq(requests.tenantId, cell.tenantId) : isNull(requests.tenantId),
    eq(requests.taskType, cell.taskType),
    eq(requests.complexity, cell.complexity),
    eq(requests.provider, cell.provider),
    eq(requests.model, cell.model),
  );
  return db
    .select({
      id: requests.id,
      prompt: requests.prompt,
      response: requests.response,
      createdAt: requests.createdAt,
      score: feedback.score,
      source: feedback.source,
    })
    .from(requests)
    .innerJoin(feedback, eq(feedback.requestId, requests.id))
    .where(
      and(
        baseWhere,
        eq(feedback.source, "judge"),
        sql`${feedback.score} >= ${REPLAY_BANK_MIN_SCORE}`,
      ),
    )
    .orderBy(desc(requests.createdAt))
    .limit(limit)
    .all();
}

export interface BankPopulateResult {
  tenantId: string | null;
  taskType: string;
  complexity: string;
  provider: string;
  model: string;
  added: number;
  skipped: number;
}

async function populateBankForCell(
  db: Db,
  embeddings: EmbeddingProvider | null,
  cell: CellGroup,
): Promise<BankPopulateResult> {
  const existing = await db
    .select()
    .from(replayBank)
    .where(
      and(
        cell.tenantId ? eq(replayBank.tenantId, cell.tenantId) : isNull(replayBank.tenantId),
        eq(replayBank.taskType, cell.taskType),
        eq(replayBank.complexity, cell.complexity),
        eq(replayBank.provider, cell.provider),
        eq(replayBank.model, cell.model),
      ),
    )
    .all();

  if (existing.length >= REPLAY_BANK_MAX_PER_CELL) {
    return { ...cell, added: 0, skipped: 0 };
  }

  const seen = new Set(existing.map((e) => e.sourceRequestId).filter(Boolean));
  const existingEmbeddings = existing
    .map((e) => (e.embedding ? decodeEmbedding(e.embedding) : null))
    .filter((v): v is number[] => Array.isArray(v));

  const candidates = await fetchCandidates(db, cell);
  let added = 0;
  let skipped = 0;
  const slots = REPLAY_BANK_MAX_PER_CELL - existing.length;

  for (const candidate of candidates) {
    if (added >= slots) break;
    if (seen.has(candidate.id)) {
      skipped++;
      continue;
    }

    // Extract the last user message for embedding — the full JSON prompt
    // includes roles and is noisy for diversity comparison.
    const text = extractLastUserText(candidate.prompt);
    if (!text) {
      skipped++;
      continue;
    }

    let embedding: number[] | null = null;
    if (embeddings) {
      try {
        embedding = await embeddings.embed(text);
      } catch (err) {
        // Embedding failures are non-fatal — we still store the entry,
        // just without diversity filtering. Log once per cycle.
        console.warn(
          `[regression] embed failed for ${cell.provider}/${cell.model}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (embedding && existingEmbeddings.length > 0) {
      const maxSim = existingEmbeddings.reduce(
        (m, e) => Math.max(m, cosineSimilarity(e, embedding!)),
        0,
      );
      if (1 - maxSim < REPLAY_DIVERSITY_THRESHOLD) {
        skipped++;
        continue;
      }
    }

    await db
      .insert(replayBank)
      .values({
        id: nanoid(),
        tenantId: cell.tenantId,
        taskType: cell.taskType,
        complexity: cell.complexity,
        provider: cell.provider,
        model: cell.model,
        prompt: candidate.prompt,
        response: candidate.response ?? "",
        originalScore: candidate.score,
        originalScoreSource: (candidate.source as "user" | "judge") ?? "user",
        sourceRequestId: candidate.id,
        embedding: embedding ? encodeEmbedding(embedding) : null,
        embeddingDim: embedding ? embedding.length : null,
        embeddingModel: embedding && embeddings ? embeddings.model : null,
      })
      .run();

    if (embedding) existingEmbeddings.push(embedding);
    seen.add(candidate.id);
    added++;
  }

  return { ...cell, added, skipped };
}

function extractLastUserText(promptJson: string): string {
  try {
    const messages = JSON.parse(promptJson) as Array<{ role: string; content: string }>;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    return lastUser?.content ?? "";
  } catch {
    return promptJson.slice(0, 2000);
  }
}

/**
 * Top-level bank population cycle — iterate eligible cells across all
 * opted-in tenants, append new high-quality prompts. Cells whose tenant
 * has opted out are skipped. Idempotent; safe to call on a daily cron.
 */
export async function runBankPopulationCycle(
  db: Db,
  embeddings: EmbeddingProvider | null,
): Promise<BankPopulateResult[]> {
  const cells = await distinctEligibleCells(db);
  const results: BankPopulateResult[] = [];
  for (const cell of cells) {
    // Tier gate (#168): even if the tenant has opted in, skip cells owned
    // by tenants without Intelligence access. Prevents cross-tier leakage
    // if a tenant downgrades from Pro → Free with opt-in still flagged.
    const hasTier = await tenantHasIntelligenceAccess(db, cell.tenantId);
    if (!hasTier) continue;
    const optedIn = await isRegressionDetectionEnabled(db, cell.tenantId);
    if (!optedIn) continue;
    const result = await populateBankForCell(db, embeddings, cell);
    if (result.added > 0) results.push(result);
  }
  return results;
}

const JUDGE_COMPARISON_PROMPT = `You are a strict, impartial judge. The user is running a REGRESSION CHECK: the same prompt was answered at two different times with two responses. Rate the NEW response's quality on the same 1–5 scale used for the original. Consider accuracy, relevance, and coherence. Return ONLY JSON like {"score": N} with no other text.`;

interface JudgeScoreResult {
  score: number | null;
  costUsd: number;
}

async function scoreReplayWithJudge(
  registry: ProviderRegistry,
  judgeTarget: { provider: string; model: string },
  userPrompt: string,
  newResponse: string,
): Promise<JudgeScoreResult> {
  const provider = registry.get(judgeTarget.provider);
  if (!provider) return { score: null, costUsd: 0 };

  const res = await provider.complete({
    model: judgeTarget.model,
    messages: [
      { role: "system", content: JUDGE_COMPARISON_PROMPT },
      {
        role: "user",
        content: `**User prompt:**\n${userPrompt}\n\n**New response:**\n${newResponse}`,
      },
    ],
    temperature: 0,
    max_tokens: 40,
  });

  const cost = calculateCost(judgeTarget.model, res.usage.inputTokens, res.usage.outputTokens);
  const match = res.content.match(/\{[\s\S]*\}/);
  if (!match) return { score: null, costUsd: cost };
  try {
    const parsed = JSON.parse(match[0]);
    const score = Number(parsed.score);
    return { score: score >= 1 && score <= 5 ? score : null, costUsd: cost };
  } catch {
    return { score: null, costUsd: cost };
  }
}

export interface ReplayCycleStats {
  cellsEvaluated: number;
  replaysExecuted: number;
  regressionsDetected: number;
  totalCostUsd: number;
  budgetSkipped: number;
}

/**
 * Narrow interface the replay cycle uses to write judge scores back into
 * the adaptive router's EMA (#163). Typed as a thin subset so this module
 * doesn't need to import the full AdaptiveRouter and create a cycle.
 *
 * `tenantId` widened in #196 (C3) so regression-driven EMA updates honor
 * the cell's tenant scoping. Pre-C3, the replay cycle dropped tenantId
 * on the floor and every update landed in the pool — invisible for
 * Team/Enterprise tenants whose policy has `writesPool: false`.
 */
export interface AdaptiveScoreWriter {
  updateScore(
    taskType: string,
    complexity: string,
    provider: string,
    model: string,
    score: number,
    source: "user" | "judge",
    tenantId?: string | null,
  ): Promise<void>;
}

export async function runReplayCycle(
  db: Db,
  registry: ProviderRegistry,
  judgeTarget: { provider: string; model: string } | null,
  adaptive?: AdaptiveScoreWriter | null,
): Promise<ReplayCycleStats> {
  if (!judgeTarget) {
    return { cellsEvaluated: 0, replaysExecuted: 0, regressionsDetected: 0, totalCostUsd: 0, budgetSkipped: 0 };
  }

  const cells = await distinctEligibleCells(db);
  const stats: ReplayCycleStats = {
    cellsEvaluated: 0,
    replaysExecuted: 0,
    regressionsDetected: 0,
    totalCostUsd: 0,
    budgetSkipped: 0,
  };

  for (const cell of cells) {
    // Same two-gate pattern as populate: tier check first, opt-in second.
    const hasTier = await tenantHasIntelligenceAccess(db, cell.tenantId);
    if (!hasTier) continue;
    const optedIn = await isRegressionDetectionEnabled(db, cell.tenantId);
    if (!optedIn) continue;

    const budget = await getBudgetStatus(db, cell.tenantId);
    if (budget.remaining <= 0) {
      stats.budgetSkipped++;
      continue;
    }

    const bankEntries = await db
      .select()
      .from(replayBank)
      .where(
        and(
          cell.tenantId ? eq(replayBank.tenantId, cell.tenantId) : isNull(replayBank.tenantId),
          eq(replayBank.taskType, cell.taskType),
          eq(replayBank.complexity, cell.complexity),
          eq(replayBank.provider, cell.provider),
          eq(replayBank.model, cell.model),
        ),
      )
      .orderBy(sql`COALESCE(${replayBank.lastReplayedAt}, 0) ASC`)
      .limit(REPLAY_SAMPLE_K)
      .all();

    if (bankEntries.length < 2) continue;
    stats.cellsEvaluated++;

    const runtime = registry.get(cell.provider);
    if (!runtime) continue;

    const originalScores: number[] = [];
    const replayScores: number[] = [];
    let cellCost = 0;

    for (const entry of bankEntries) {
      const currentBudget = await getBudgetStatus(db, cell.tenantId);
      if (currentBudget.remaining - cellCost <= 0) {
        stats.budgetSkipped++;
        break;
      }
      const userText = extractLastUserText(entry.prompt);
      if (!userText) continue;

      try {
        const completion = await runtime.complete({
          model: cell.model,
          messages: [{ role: "user", content: userText }],
          temperature: 0,
          max_tokens: 500,
        });
        const replayCost = calculateCost(
          cell.model,
          completion.usage.inputTokens,
          completion.usage.outputTokens,
        );
        cellCost += replayCost;

        const { score, costUsd: judgeCost } = await scoreReplayWithJudge(
          registry,
          judgeTarget,
          userText,
          completion.content,
        );
        cellCost += judgeCost;

        if (score !== null) {
          originalScores.push(entry.originalScore);
          replayScores.push(score);
          stats.replaysExecuted++;
          // Feed the judge score back into the adaptive EMA (#163). Treats
          // replay scores identically to live-traffic judge scores — same
          // grader, same 1–5 scale. Result: when the current model has
          // degraded, its EMA drops on the very next routing decision
          // instead of waiting for natural judge sampling to catch up.
          if (adaptive) {
            try {
              await adaptive.updateScore(
                cell.taskType,
                cell.complexity,
                cell.provider,
                cell.model,
                score,
                "judge",
                cell.tenantId,
              );
            } catch (err) {
              console.warn(
                `[regression] feeding adaptive EMA failed for ${cell.provider}/${cell.model}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }

        await db
          .update(replayBank)
          .set({ lastReplayedAt: new Date() })
          .where(eq(replayBank.id, entry.id))
          .run();
      } catch (err) {
        console.warn(
          `[regression] replay failed ${cell.provider}/${cell.model}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    await addBudgetUsage(db, cell.tenantId, cellCost);
    stats.totalCostUsd += cellCost;

    if (originalScores.length >= 2 && replayScores.length >= 2) {
      const originalMean = mean(originalScores);
      const replayMean = mean(replayScores);
      const delta = replayMean - originalMean;
      if (delta <= REGRESSION_DELTA_THRESHOLD) {
        // Dedupe (#160): if an unresolved event already exists for this
        // (tenant, cell, model), update it in place with the latest
        // measurements and accumulate cost. Preserve `detectedAt` so the UI
        // continues to show "this has been regressing since X". Once the
        // operator dismisses via `resolveRegressionEvent`, new events can
        // fire again on the next cycle.
        const existing = await db
          .select()
          .from(regressionEvents)
          .where(
            and(
              cell.tenantId ? eq(regressionEvents.tenantId, cell.tenantId) : isNull(regressionEvents.tenantId),
              eq(regressionEvents.taskType, cell.taskType),
              eq(regressionEvents.complexity, cell.complexity),
              eq(regressionEvents.provider, cell.provider),
              eq(regressionEvents.model, cell.model),
              isNull(regressionEvents.resolvedAt),
            ),
          )
          .get();

        if (existing) {
          await db
            .update(regressionEvents)
            .set({
              replayCount: replayScores.length,
              originalMean,
              replayMean,
              delta,
              costUsd: existing.costUsd + cellCost,
            })
            .where(eq(regressionEvents.id, existing.id))
            .run();
        } else {
          await db
            .insert(regressionEvents)
            .values({
              id: nanoid(),
              tenantId: cell.tenantId,
              taskType: cell.taskType,
              complexity: cell.complexity,
              provider: cell.provider,
              model: cell.model,
              replayCount: replayScores.length,
              originalMean,
              replayMean,
              delta,
              costUsd: cellCost,
            })
            .run();
        }
        stats.regressionsDetected++;
        console.warn(
          `[regression] detected ${cell.provider}/${cell.model} on ${cell.taskType}+${cell.complexity}: Δ=${delta.toFixed(2)}`,
        );
      }
    }
  }

  return stats;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export async function listRegressionEvents(
  db: Db,
  tenantId: string | null,
  options: { unresolvedOnly?: boolean } = {},
) {
  const conditions = [
    tenantId ? eq(regressionEvents.tenantId, tenantId) : undefined,
    options.unresolvedOnly ? isNull(regressionEvents.resolvedAt) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select()
    .from(regressionEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(regressionEvents.detectedAt))
    .limit(100)
    .all();
  return rows;
}

export async function resolveRegressionEvent(
  db: Db,
  id: string,
  note: string | null,
): Promise<boolean> {
  const existing = await db.select().from(regressionEvents).where(eq(regressionEvents.id, id)).get();
  if (!existing) return false;
  await db
    .update(regressionEvents)
    .set({ resolvedAt: new Date(), resolutionNote: note })
    .where(eq(regressionEvents.id, id))
    .run();
  return true;
}

/**
 * In-memory lookup for "does this cell have an active regression?" (#163).
 * The adaptive router consults this on every routing decision to decide
 * whether to boost the ε-greedy exploration rate for the cell. Cell-scoped
 * rather than model-scoped — any unresolved regression on a cell forces
 * exploration so the router samples alternatives and converges on a new
 * winner faster.
 *
 * Mirrors the cost-migration boost table (#153). Loaded at boot and
 * refreshed by callers after a replay cycle (new detections possible)
 * or an event resolution (alert cleared).
 */
export interface RegressionCellTable {
  isRegressing(taskType: string, complexity: string): boolean;
  refresh(): Promise<void>;
}

export function createRegressionCellTable(db: Db): RegressionCellTable {
  const cells = new Set<string>();

  function key(taskType: string, complexity: string): string {
    return `${taskType}::${complexity}`;
  }

  async function refresh(): Promise<void> {
    cells.clear();
    const active = await db
      .select({
        taskType: regressionEvents.taskType,
        complexity: regressionEvents.complexity,
      })
      .from(regressionEvents)
      .where(isNull(regressionEvents.resolvedAt))
      .all();
    for (const row of active) {
      cells.add(key(row.taskType, row.complexity));
    }
  }

  function isRegressing(taskType: string, complexity: string): boolean {
    return cells.has(key(taskType, complexity));
  }

  return { isRegressing, refresh };
}
