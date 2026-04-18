import type { Db } from "@provara/db";
import { costLogs, modelScores, requests } from "@provara/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { calculateCost } from "../cost/pricing.js";

/**
 * Savings recommendations (#219/T6). For a tenant, per
 * (task_type, complexity) cell, compares the current high-volume
 * winner against alternates with quality delta ≤ threshold, and ranks
 * them by estimated monthly savings.
 *
 * Quality source: `model_scores.qualityScore` from the adaptive
 * router. Using what the router uses keeps recommendations aligned
 * with what the router is already optimizing.
 *
 * Data requirements per recommendation (configurable):
 *   - >= MIN_CELL_VOLUME requests on the winner in the last 30 days
 *     (avg tokens need to be meaningful)
 *   - >= MIN_ALT_SAMPLES quality-score samples on the alternate
 *   - quality_delta (winner - alternate) <= QUALITY_DELTA_THRESHOLD
 *   - alternate's modeled cost per request strictly less than the
 *     winner's observed cost per request
 *
 * Savings math:
 *   avg_in, avg_out = mean input/output tokens of winner's recent
 *                     requests in the cell
 *   current_cost_per_req = total cost / total request count
 *     (from cost_logs — uses the *actual* historical spend, not a
 *     modeled cost; handles quirks like failed-retry billing honestly)
 *   alternate_cost_per_req = calculateCost(alt_model, avg_in, avg_out)
 *   estimated_monthly_savings = monthly_volume × (current_cost_per_req
 *                                                 - alternate_cost_per_req)
 */

export const QUALITY_DELTA_THRESHOLD = Number(
  process.env.PROVARA_SAVINGS_QUALITY_DELTA ?? "0.05",
);
export const MIN_CELL_VOLUME = 30;
export const MIN_ALT_SAMPLES = 20;
export const LOOKBACK_DAYS = 30;

export interface Recommendation {
  task_type: string;
  complexity: string;
  from_provider: string;
  from_model: string;
  to_provider: string;
  to_model: string;
  quality_delta: number;
  monthly_volume: number;
  current_cost_per_req: number;
  alternate_cost_per_req: number;
  estimated_monthly_savings: number;
  confidence_samples: number;
}

export async function computeRecommendations(
  db: Db,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<Recommendation[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Per (task_type, complexity, provider, model), historical volume +
  // cost on this tenant over the lookback window. Winner per cell is
  // the row with the highest request count.
  const usage = await db
    .select({
      taskType: requests.taskType,
      complexity: requests.complexity,
      provider: requests.provider,
      model: requests.model,
      reqCount: sql<number>`COUNT(*)`,
      totalCost: sql<number>`COALESCE(SUM(${costLogs.cost}), 0)`,
      avgIn: sql<number>`COALESCE(AVG(${requests.inputTokens}), 0)`,
      avgOut: sql<number>`COALESCE(AVG(${requests.outputTokens}), 0)`,
    })
    .from(requests)
    .innerJoin(costLogs, eq(costLogs.requestId, requests.id))
    .where(
      and(
        eq(requests.tenantId, tenantId),
        gte(requests.createdAt, since),
      ),
    )
    .groupBy(requests.taskType, requests.complexity, requests.provider, requests.model)
    .all();

  // Bucket by cell.
  const cells = new Map<string, Array<typeof usage[number]>>();
  for (const row of usage) {
    if (!row.taskType || !row.complexity) continue;
    const key = `${row.taskType}|${row.complexity}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(row);
    cells.set(key, bucket);
  }

  const scores = await db
    .select()
    .from(modelScores)
    .where(eq(modelScores.tenantId, tenantId))
    .all();

  // Index scores by (cell, provider, model) for O(1) lookup.
  const scoreIdx = new Map<string, { qualityScore: number; sampleCount: number }>();
  for (const s of scores) {
    scoreIdx.set(
      `${s.taskType}|${s.complexity}|${s.provider}|${s.model}`,
      { qualityScore: s.qualityScore, sampleCount: s.sampleCount },
    );
  }

  const recs: Recommendation[] = [];
  for (const [cellKey, rows] of cells.entries()) {
    const [taskType, complexity] = cellKey.split("|");

    rows.sort((a, b) => b.reqCount - a.reqCount);
    const winner = rows[0];
    if (Number(winner.reqCount) < MIN_CELL_VOLUME) continue;

    const winnerScore = scoreIdx.get(`${taskType}|${complexity}|${winner.provider}|${winner.model}`);
    if (!winnerScore) continue;

    const winnerReqs = Number(winner.reqCount);
    const currentCostPerReq = winnerReqs > 0 ? Number(winner.totalCost) / winnerReqs : 0;
    const avgIn = Number(winner.avgIn);
    const avgOut = Number(winner.avgOut);

    // Consider every alternate with a score row, including models
    // that haven't yet been used on this tenant (non-zero reqCount
    // isn't required on the alternate).
    for (const candidate of scores) {
      if (candidate.taskType !== taskType || candidate.complexity !== complexity) continue;
      if (candidate.provider === winner.provider && candidate.model === winner.model) continue;
      if (candidate.sampleCount < MIN_ALT_SAMPLES) continue;

      const qualityDelta = winnerScore.qualityScore - candidate.qualityScore;
      if (qualityDelta > QUALITY_DELTA_THRESHOLD) continue;

      const altCostPerReq = calculateCost(candidate.model, avgIn, avgOut);
      if (altCostPerReq >= currentCostPerReq) continue;

      const savingsPerReq = currentCostPerReq - altCostPerReq;
      const estimatedMonthly = winnerReqs * savingsPerReq;

      recs.push({
        task_type: taskType,
        complexity,
        from_provider: winner.provider,
        from_model: winner.model,
        to_provider: candidate.provider,
        to_model: candidate.model,
        quality_delta: round(qualityDelta),
        monthly_volume: winnerReqs,
        current_cost_per_req: round(currentCostPerReq, 6),
        alternate_cost_per_req: round(altCostPerReq, 6),
        estimated_monthly_savings: round(estimatedMonthly, 4),
        confidence_samples: candidate.sampleCount,
      });
    }
  }

  recs.sort((a, b) => b.estimated_monthly_savings - a.estimated_monthly_savings);
  return recs;
}

function round(n: number, places = 4): number {
  const factor = Math.pow(10, places);
  return Math.round(n * factor) / factor;
}
