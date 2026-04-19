import type { Db } from "@provara/db";
import { costLogs, feedback, modelScores, requests } from "@provara/db";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { DEMO_CELLS, DEMO_TENANT_ID, DEMO_USER_IDS } from "./seed.js";

/**
 * Demo-tenant live tick (#229 follow-up). Fires every 5 minutes; each
 * run appends 1–3 fresh requests to `t_demo` with realistic timestamps,
 * emits judge feedback on ~40% of them, and nudges the `model_scores`
 * EMA for the (cell, model) it touched. The effect on the dashboard:
 * if a visitor sits on the spend trajectory, quality, or adaptive
 * matrix page, they see numbers change in-session rather than a
 * frozen snapshot.
 *
 * The tick operates within the optimized phase of the narrative arc
 * (cheap models, high quality) so the live additions reinforce rather
 * than contradict the story the historical seed is telling. The
 * nightly `demo-reseed` job wipes the whole tenant, so tick-induced
 * drift never accumulates past 24 hours.
 *
 * Guardrails:
 *   - Only writes rows scoped to `t_demo`
 *   - Uses deterministic nanoid-style IDs so concurrent ticks don't
 *     clash even if an edge case fires them too close together
 *   - Bails cleanly if the demo tenant hasn't been seeded yet (no
 *     user rows) — means the scheduler came up before the seed did
 *     on a fresh deploy; next reseed will fix it
 */

const TICK_MODELS: Array<{ provider: string; model: string; costInPer1M: number; costOutPer1M: number }> = [
  { provider: "openai", model: "gpt-4.1-nano", costInPer1M: 0.1, costOutPer1M: 0.4 },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", costInPer1M: 0.8, costOutPer1M: 4 },
  { provider: "google", model: "gemini-2.0-flash", costInPer1M: 0.1, costOutPer1M: 0.4 },
  { provider: "openai", model: "gpt-4.1-mini", costInPer1M: 0.4, costOutPer1M: 1.6 },
  { provider: "google", model: "gemini-2.5-flash", costInPer1M: 0.15, costOutPer1M: 0.6 },
];

function costFor(
  m: { costInPer1M: number; costOutPer1M: number },
  inputTokens: number,
  outputTokens: number,
): number {
  return Number(
    ((inputTokens / 1_000_000) * m.costInPer1M +
      (outputTokens / 1_000_000) * m.costOutPer1M).toFixed(6),
  );
}

const EMA_ALPHA = 0.1;
function nudgeEma(previous: number, newSample: number): number {
  return previous + EMA_ALPHA * (newSample - previous);
}

export interface DemoTickStats {
  requestsAdded: number;
  feedbackAdded: number;
  scoresTouched: number;
  skippedNoTenant: boolean;
}

export async function runDemoTick(db: Db, now: Date = new Date()): Promise<DemoTickStats> {
  const stats: DemoTickStats = {
    requestsAdded: 0,
    feedbackAdded: 0,
    scoresTouched: 0,
    skippedNoTenant: false,
  };

  // Bail if the demo tenant isn't seeded — the nightly reseed job will
  // populate it and the next tick can then append. Avoids FK confusion
  // and empty-chart flicker.
  const sampleReq = await db
    .select({ id: requests.id })
    .from(requests)
    .where(eq(requests.tenantId, DEMO_TENANT_ID))
    .limit(1)
    .get();
  if (!sampleReq) {
    stats.skippedNoTenant = true;
    return stats;
  }

  // 1–3 new requests, spaced a few seconds apart within this tick.
  const count = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const model = TICK_MODELS[Math.floor(Math.random() * TICK_MODELS.length)];
    const cell = DEMO_CELLS[Math.floor(Math.random() * DEMO_CELLS.length)];
    const user = DEMO_USER_IDS[Math.floor(Math.random() * DEMO_USER_IDS.length)];
    const apiTokenId = i % 2 === 0 ? "tok_demo_production" : "tok_demo_staging";
    const inputTokens = 350 + Math.floor(Math.random() * 700);
    const outputTokens = 180 + Math.floor(Math.random() * 500);
    const cost = costFor(model, inputTokens, outputTokens);
    const createdAt = new Date(now.getTime() - i * 30_000); // spread over the tick
    const reqId = `req_demo_live_${now.getTime()}_${i}_${nanoid(6)}`;

    await db.insert(requests).values({
      id: reqId,
      provider: model.provider,
      model: model.model,
      prompt: JSON.stringify([{ role: "user", content: "live demo prompt" }]),
      response: "live demo response",
      inputTokens,
      outputTokens,
      latencyMs: 250 + Math.floor(Math.random() * 1500),
      cost,
      taskType: cell.taskType,
      complexity: cell.complexity,
      routedBy: "adaptive",
      usedFallback: false,
      cached: false,
      cacheSource: null,
      tokensSavedInput: null,
      tokensSavedOutput: null,
      fallbackErrors: null,
      tenantId: DEMO_TENANT_ID,
      userId: user,
      apiTokenId,
      abTestId: null,
      createdAt,
    }).run();

    await db.insert(costLogs).values({
      id: `cl_demo_live_${now.getTime()}_${i}_${nanoid(6)}`,
      requestId: reqId,
      tenantId: DEMO_TENANT_ID,
      provider: model.provider,
      model: model.model,
      inputTokens,
      outputTokens,
      cost,
      userId: user,
      apiTokenId,
      createdAt,
    }).run();
    stats.requestsAdded++;

    // Judge feedback on ~40% of tick requests. Score 3–5 weighted
    // toward the high end so the quality narrative holds.
    if (Math.random() < 0.4) {
      const score = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5
      await db.insert(feedback).values({
        id: `fb_demo_live_${now.getTime()}_${i}_${nanoid(6)}`,
        requestId: reqId,
        tenantId: DEMO_TENANT_ID,
        score,
        comment: null,
        source: "judge",
        createdAt,
      }).run();
      stats.feedbackAdded++;

      // Nudge the model_scores EMA for this (cell, model). Maps the
      // 1–5 integer score onto the 0–1 qualityScore axis via /5 so a
      // judge score of 4.5 lands near 0.9 in the scoring metric.
      const qualityAsFraction = score / 5;
      const existing = await db
        .select()
        .from(modelScores)
        .where(
          and(
            eq(modelScores.tenantId, DEMO_TENANT_ID),
            eq(modelScores.taskType, cell.taskType),
            eq(modelScores.complexity, cell.complexity),
            eq(modelScores.provider, model.provider),
            eq(modelScores.model, model.model),
          ),
        )
        .get();
      if (existing) {
        await db
          .update(modelScores)
          .set({
            qualityScore: Number(nudgeEma(existing.qualityScore, qualityAsFraction).toFixed(4)),
            sampleCount: existing.sampleCount + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(modelScores.tenantId, DEMO_TENANT_ID),
              eq(modelScores.taskType, cell.taskType),
              eq(modelScores.complexity, cell.complexity),
              eq(modelScores.provider, model.provider),
              eq(modelScores.model, model.model),
            ),
          )
          .run();
        stats.scoresTouched++;
      }
    }
  }

  return stats;
}
