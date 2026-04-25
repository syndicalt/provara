import type { Db } from "@provara/db";
import { modelScores, abTests, abTestVariants } from "@provara/db";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { isVisionCapable } from "../model-capabilities.js";
import { MIN_SAMPLES } from "./scoring.js";
import { POOL_KEY } from "./score-store.js";
import type { RouteTarget } from "../types.js";

function numEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Cells whose best-known model scores at or below this threshold are
 * flagged as low-quality. 2.5 on the 1–5 quality scale is the midpoint
 * between "unusable" (1.0) and "borderline acceptable" (4.0) — anything
 * below it has clear room for a challenger to demonstrate improvement.
 *
 * Used by both Track 3 (the manual "spawn challenger" UI button —
 * available to all tiers) and Track 2 (the Pro+ low-score exploration
 * rate boost in `exploration.ts`).
 */
export const LOW_SCORE_THRESHOLD = numEnv(process.env.PROVARA_LOW_SCORE_THRESHOLD, 2.5);

export interface LowScoreCell {
  taskType: string;
  complexity: string;
  incumbent: {
    provider: string;
    model: string;
    qualityScore: number;
    sampleCount: number;
  };
  /** Number of distinct models with any score in this cell (any sample count). */
  scoredModelCount: number;
}

/**
 * Find cells whose top-scoring model is below `LOW_SCORE_THRESHOLD` and
 * is the only sufficiently-sampled candidate. The bar for "sufficiently
 * sampled" is `MIN_SAMPLES` — under that we can't trust the low score
 * isn't just noise. Result is sorted by qualityScore ascending so the
 * worst cells surface first.
 *
 * Tenant scope: this scans the pool (`tenantKey IS NULL`) by default —
 * the matching UI lives on the dashboard's pooled view. A future per-
 * tenant variant can pass `options.tenantKey` once tenant-scoped
 * dashboards exist.
 */
export async function findLowScoringCells(
  db: Db,
  options: { threshold?: number; tenantId?: string | null } = {},
): Promise<LowScoreCell[]> {
  const threshold = options.threshold ?? LOW_SCORE_THRESHOLD;
  const tenantId = options.tenantId ?? POOL_KEY;

  const rows = await db
    .select()
    .from(modelScores)
    .where(eq(modelScores.tenantId, tenantId))
    .all();

  const byCell = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.taskType}::${row.complexity}`;
    const list = byCell.get(key);
    if (list) list.push(row);
    else byCell.set(key, [row]);
  }

  const out: LowScoreCell[] = [];
  for (const [, cellRows] of byCell) {
    const eligible = cellRows.filter((r) => r.sampleCount >= MIN_SAMPLES);
    if (eligible.length === 0) continue;
    const sorted = [...eligible].sort((a, b) => b.qualityScore - a.qualityScore);
    const top = sorted[0];
    if (top.qualityScore > threshold) continue;
    // Lonely-loser semantics: only flag when there is no second eligible
    // model that could already serve as a credible challenger. If two
    // models are both above MIN_SAMPLES and both low, the existing
    // `findTieCells` path (or the user) can already pit them against
    // each other; we don't need to dilute the signal here.
    if (eligible.length > 1) continue;
    out.push({
      taskType: top.taskType,
      complexity: top.complexity,
      incumbent: {
        provider: top.provider,
        model: top.model,
        qualityScore: top.qualityScore,
        sampleCount: top.sampleCount,
      },
      scoredModelCount: cellRows.length,
    });
  }
  out.sort((a, b) => a.incumbent.qualityScore - b.incumbent.qualityScore);
  return out;
}

export interface ChallengerInput {
  taskType: string;
  complexity: string;
  incumbent: { provider: string; model: string };
  /** Full candidate pool (already filtered for vision/structured if relevant). */
  candidates: RouteTarget[];
  /** Provider names with active credentials — challengers must be in this set. */
  availableProviders: Set<string>;
  /** Models already scored in this cell (any sampleCount). Excluded from picks. */
  scoredModels?: Set<string>;
}

/**
 * Pick a capability-matched challenger different from the incumbent.
 * Selection rules, in order:
 *
 *   1. Same modality bucket — vision cells only consider vision-capable
 *      models; this prevents pitting a text model against an image task.
 *   2. Skip the incumbent.
 *   3. Skip already-scored models — the point of a challenger is to
 *      surface a new candidate; rerunning a known performer adds no
 *      information.
 *   4. Prefer a *different provider* than the incumbent (cross-family
 *      diversity). When no different-provider candidate exists, fall
 *      back to a same-provider model.
 *
 * Returns null when no eligible challenger remains. Pure function — no
 * randomization — so callers see deterministic picks given the same
 * candidate ordering. `candidates` is expected to come pre-sorted (the
 * routing engine sorts cheapest-first), which means challengers are
 * cost-biased: a tie on provider-family preference resolves to the
 * cheaper model, which is the right default for a probe.
 */
export function pickChallenger(input: ChallengerInput): RouteTarget | null {
  const { taskType, incumbent, candidates, availableProviders } = input;
  const scoredModels = input.scoredModels ?? new Set<string>();

  const requiresVision = taskType === "vision";

  function key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  const eligible = candidates.filter((c) => {
    if (!availableProviders.has(c.provider)) return false;
    if (c.provider === incumbent.provider && c.model === incumbent.model) return false;
    if (scoredModels.has(key(c.provider, c.model))) return false;
    if (requiresVision && !isVisionCapable(c.model)) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  const differentFamily = eligible.find((c) => c.provider !== incumbent.provider);
  return differentFamily ?? eligible[0];
}

export interface ChallengerSpawnInput {
  taskType: string;
  complexity: string;
  incumbent: { provider: string; model: string };
  challenger: { provider: string; model: string };
  /** Defaults to the pool (tenantId=null). */
  tenantId?: string | null;
}

export interface SpawnedChallengerTest {
  testId: string;
  taskType: string;
  complexity: string;
  incumbent: { provider: string; model: string };
  challenger: { provider: string; model: string };
}

/**
 * Create a 50/50 A/B test pitting the incumbent against the picked
 * challenger. The test is *not* marked `autoGenerated` — this is a
 * user-initiated experiment (the dashboard "Spawn Challenger" button),
 * so it lives alongside hand-crafted tests in `/dashboard/ab-tests` and
 * the auto-stop scheduler in `runAutoAbCycle` ignores it. Manual
 * lifecycle: the user resolves the test via the existing PATCH
 * /v1/admin/ab-tests/:id endpoint or deletes it.
 *
 * Tenant scoping mirrors the regular A/B-test create endpoint — pass
 * the caller's tenantId so the test only runs against their traffic.
 */
export async function spawnChallengerTest(
  db: Db,
  input: ChallengerSpawnInput,
): Promise<SpawnedChallengerTest> {
  const testId = nanoid();
  const name = `challenger: ${input.taskType}+${input.complexity} — ${input.incumbent.model} vs ${input.challenger.model}`;
  const description = `User-spawned challenger probe for low-scoring cell ${input.taskType}+${input.complexity}.`;

  await db
    .insert(abTests)
    .values({
      id: testId,
      name,
      description,
      status: "active",
      tenantId: input.tenantId ?? null,
      autoGenerated: false,
      sourceTaskType: input.taskType,
      sourceComplexity: input.complexity,
      sourceReason: `low-score challenger probe`,
    })
    .run();

  for (const variant of [input.incumbent, input.challenger]) {
    await db
      .insert(abTestVariants)
      .values({
        id: nanoid(),
        abTestId: testId,
        provider: variant.provider,
        model: variant.model,
        weight: 0.5,
        taskType: input.taskType,
        complexity: input.complexity,
      })
      .run();
  }

  return {
    testId,
    taskType: input.taskType,
    complexity: input.complexity,
    incumbent: input.incumbent,
    challenger: input.challenger,
  };
}

/**
 * Returns the set of "provider/model" keys already scored in this cell
 * (in the pool dimension), so callers can pass it into `pickChallenger`
 * to exclude rerunning known models.
 */
export async function getScoredModelsForCell(
  db: Db,
  taskType: string,
  complexity: string,
  tenantId: string = POOL_KEY,
): Promise<Set<string>> {
  const rows = await db
    .select({ provider: modelScores.provider, model: modelScores.model })
    .from(modelScores)
    .where(
      and(
        eq(modelScores.taskType, taskType),
        eq(modelScores.complexity, complexity),
        eq(modelScores.tenantId, tenantId),
      ),
    )
    .all();
  return new Set(rows.map((r) => `${r.provider}/${r.model}`));
}
