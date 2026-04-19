import type { Db } from "@provara/db";
import {
  promptRollouts,
  promptTemplates,
  promptVersions,
  requests,
  feedback,
} from "@provara/db";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * Prompt canary rollouts (#264). Weighted routing + hourly criteria-based
 * auto-promotion. The gateway's `/v1/prompts/:id/resolve` endpoint picks
 * canary or stable; the scheduler's `prompt-rollout-eval` job promotes
 * or reverts based on observed feedback.
 */

export interface RolloutCriteria {
  min_samples: number;
  max_avg_score_delta: number;
  window_hours: number;
}

export interface ResolvedPrompt {
  versionId: string;
  messages: unknown;
  rolloutId?: string;
  variant?: "canary" | "stable";
}

/** Resolve the version to serve for a template, respecting an active rollout.
 *  When no rollout is active, returns the template's published version.
 *  Weighted random — not sticky per user, so a single caller's traffic is
 *  distributed across canary/stable within the rollout_pct split. */
export async function resolveVersion(
  db: Db,
  templateId: string,
  tenantId: string | null,
): Promise<ResolvedPrompt | null> {
  const templateRow = await db
    .select()
    .from(promptTemplates)
    .where(
      tenantId
        ? and(eq(promptTemplates.id, templateId), eq(promptTemplates.tenantId, tenantId))
        : eq(promptTemplates.id, templateId),
    )
    .get();
  if (!templateRow) return null;

  const activeRollout = await db
    .select()
    .from(promptRollouts)
    .where(
      and(
        eq(promptRollouts.templateId, templateId),
        eq(promptRollouts.status, "active"),
      ),
    )
    .get();

  const pickVersion = async (versionId: string) => {
    const vRow = await db.select().from(promptVersions).where(eq(promptVersions.id, versionId)).get();
    if (!vRow) return null;
    try {
      return JSON.parse(vRow.messages);
    } catch {
      return null;
    }
  };

  if (activeRollout) {
    const roll = Math.random() * 100;
    const pickCanary = roll < activeRollout.rolloutPct;
    const chosenId = pickCanary ? activeRollout.canaryVersionId : activeRollout.stableVersionId;
    const messages = await pickVersion(chosenId);
    if (!messages) return null;
    return {
      versionId: chosenId,
      messages,
      rolloutId: activeRollout.id,
      variant: pickCanary ? "canary" : "stable",
    };
  }

  if (!templateRow.publishedVersionId) return null;
  const messages = await pickVersion(templateRow.publishedVersionId);
  if (!messages) return null;
  return { versionId: templateRow.publishedVersionId, messages };
}

interface RolloutStats {
  canarySamples: number;
  stableSamples: number;
  canaryAvgScore: number | null;
  stableAvgScore: number | null;
}

/** Compute canary vs stable avg score within the rollout's evaluation window.
 *  Samples are user-feedback rows joined to requests carrying the respective
 *  prompt_version_id. Judge-source feedback is included — same grading loop
 *  as live quality tracking. */
async function computeRolloutStats(
  db: Db,
  canaryVersionId: string,
  stableVersionId: string,
  windowHours: number,
): Promise<RolloutStats> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const row = await db
    .select({
      versionId: requests.promptVersionId,
      avgScore: sql<number>`avg(${feedback.score})`,
      n: sql<number>`count(${feedback.id})`,
    })
    .from(requests)
    .innerJoin(feedback, eq(feedback.requestId, requests.id))
    .where(
      and(
        sql`${requests.createdAt} >= ${since}`,
        sql`${requests.promptVersionId} IN (${canaryVersionId}, ${stableVersionId})`,
      ),
    )
    .groupBy(requests.promptVersionId)
    .all();

  let canaryStats = { n: 0, avg: null as number | null };
  let stableStats = { n: 0, avg: null as number | null };
  for (const r of row) {
    if (r.versionId === canaryVersionId) canaryStats = { n: r.n, avg: r.avgScore };
    if (r.versionId === stableVersionId) stableStats = { n: r.n, avg: r.avgScore };
  }
  return {
    canarySamples: canaryStats.n,
    stableSamples: stableStats.n,
    canaryAvgScore: canaryStats.avg,
    stableAvgScore: stableStats.avg,
  };
}

export interface RolloutDecision {
  outcome: "promote" | "revert" | "continue";
  reason: string;
  stats: RolloutStats;
}

/** Evaluate a single rollout against its criteria.
 *  Promotion: canary samples meet min, and score delta >= -max_avg_score_delta.
 *  Revert: canary samples meet min, but score delta < -max_avg_score_delta.
 *  Continue: not enough samples yet. */
export async function evaluateRollout(
  db: Db,
  rolloutId: string,
): Promise<RolloutDecision | null> {
  const rollout = await db.select().from(promptRollouts).where(eq(promptRollouts.id, rolloutId)).get();
  if (!rollout || rollout.status !== "active") return null;

  const criteria = rollout.criteria;
  const stats = await computeRolloutStats(
    db,
    rollout.canaryVersionId,
    rollout.stableVersionId,
    criteria.window_hours,
  );

  if (stats.canarySamples < criteria.min_samples) {
    return {
      outcome: "continue",
      reason: `canary samples ${stats.canarySamples} < min ${criteria.min_samples}`,
      stats,
    };
  }
  if (stats.stableSamples < criteria.min_samples) {
    return {
      outcome: "continue",
      reason: `stable samples ${stats.stableSamples} < min ${criteria.min_samples}`,
      stats,
    };
  }
  const canaryAvg = stats.canaryAvgScore ?? 0;
  const stableAvg = stats.stableAvgScore ?? 0;
  const delta = canaryAvg - stableAvg;
  if (delta < -Math.abs(criteria.max_avg_score_delta)) {
    return {
      outcome: "revert",
      reason: `canary avg ${canaryAvg.toFixed(2)} vs stable ${stableAvg.toFixed(2)} (delta ${delta.toFixed(2)}) outside threshold ${criteria.max_avg_score_delta}`,
      stats,
    };
  }
  return {
    outcome: "promote",
    reason: `canary avg ${canaryAvg.toFixed(2)} vs stable ${stableAvg.toFixed(2)} (delta ${delta.toFixed(2)}) within threshold`,
    stats,
  };
}

/** Apply a promote/revert decision: update the rollout row and, on promote,
 *  swap the template's publishedVersionId to the canary version. */
export async function applyDecision(
  db: Db,
  rolloutId: string,
  decision: RolloutDecision,
): Promise<void> {
  if (decision.outcome === "continue") return;
  const rollout = await db.select().from(promptRollouts).where(eq(promptRollouts.id, rolloutId)).get();
  if (!rollout) return;

  await db
    .update(promptRollouts)
    .set({
      status: decision.outcome === "promote" ? "promoted" : "reverted",
      completedAt: new Date(),
      completionReason: decision.reason,
    })
    .where(eq(promptRollouts.id, rolloutId))
    .run();

  if (decision.outcome === "promote") {
    await db
      .update(promptTemplates)
      .set({ publishedVersionId: rollout.canaryVersionId, updatedAt: new Date() })
      .where(eq(promptTemplates.id, rollout.templateId))
      .run();
  }
}

/** Scheduler entry — evaluate every active rollout and apply decisions. */
export async function runRolloutEvaluationCycle(db: Db): Promise<{
  evaluated: number;
  promoted: number;
  reverted: number;
}> {
  const active = await db
    .select({ id: promptRollouts.id })
    .from(promptRollouts)
    .where(eq(promptRollouts.status, "active"))
    .all();

  let promoted = 0;
  let reverted = 0;
  for (const row of active) {
    const decision = await evaluateRollout(db, row.id);
    if (!decision || decision.outcome === "continue") continue;
    await applyDecision(db, row.id, decision);
    if (decision.outcome === "promote") promoted++;
    if (decision.outcome === "revert") reverted++;
  }
  return { evaluated: active.length, promoted, reverted };
}
