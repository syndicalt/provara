import type { RouteTarget } from "../types.js";

function numFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * ε-greedy exploration rate (#103). With this probability, bypass the EMA
 * and pick uniformly at random from the full candidate list — including
 * models with zero samples. Set to 0 to disable.
 *
 * Prevents cold-start lock-in: without exploration, once one model clears
 * MIN_SAMPLES before any competitor does, it wins permanently in that cell
 * because no alternative is ever eligible for the EMA comparison.
 */
export const EXPLORATION_RATE = numFromEnv(process.env.PROVARA_EXPLORATION_RATE, 0.1);

/**
 * Higher exploration rate used when the current cell is deemed "stale" —
 * i.e. its most recent score update is older than `STALE_AFTER_DAYS`. A
 * sleeping cell accumulates no fresh signal under the normal rate
 * (10% of 0 traffic = 0), so we boost the probability of exploration
 * when traffic DOES arrive to that cell, forcing ground-truth refresh.
 */
export const STALE_EXPLORATION_RATE = numFromEnv(process.env.PROVARA_STALE_EXPLORATION_RATE, 0.5);

/**
 * Exploration rate applied when a cell has an active regression event
 * (#163). After a regression fires, the replay cycle feeds the degraded
 * model's judge scores into the EMA so its rank drops immediately — but
 * the router still needs samples on *alternative* models to promote a
 * new winner. This boosted rate accelerates that discovery.
 */
export const REGRESSED_EXPLORATION_RATE = numFromEnv(process.env.PROVARA_REGRESSED_EXPLORATION_RATE, 0.5);

/**
 * Exploration rate applied when the cell's incumbent EMA is at or below
 * `LOW_SCORE_THRESHOLD` (see `challenger.ts`). The default routing rate
 * (10%) is calibrated for healthy cells where the cost of a "wasted"
 * exploration is real. When the incumbent is *known to be poor*, that
 * cost analysis flips — every adaptive pick is already paying a
 * quality penalty, so trying a fresh candidate is the cheaper move.
 *
 * Tier-gated by the caller (`router.ts`): only Pro+ tenants opt into
 * this boost. Free-tier traffic still uses the base 10% rate so the
 * boost stays a paid-tier differentiator (#152).
 */
export const LOW_SCORE_EXPLORATION_RATE = numFromEnv(process.env.PROVARA_LOW_SCORE_EXPLORATION_RATE, 0.5);

/**
 * How long a cell can go without any score update before it's treated as
 * stale. Default 30 days. Units: milliseconds internally; the env var is
 * in days for human readability.
 */
export const STALE_AFTER_MS =
  numFromEnv(process.env.PROVARA_STALE_AFTER_DAYS, 30) * 24 * 60 * 60 * 1000;

/**
 * Returns a uniformly random eligible candidate if the ε-greedy branch
 * fires, else null. Callers fall through to the EMA-winner path on null.
 * Requires at least 2 eligible candidates — there's no meaningful choice
 * to make otherwise.
 *
 * Rate precedence: `regressed > lowScore > stale > normal`. A cell
 * firing an unresolved regression is the strongest signal we need to
 * try alternatives. Low-score sits next: an active "this incumbent is
 * known bad" signal is louder than the passive "this cell hasn't seen
 * traffic" of stale. Detection lives in `adaptive/router.ts` (stale,
 * lowScore) and `regression.ts` (regressed). The `lowScore` flag is
 * Pro+ tier-gated by `router.ts` — free-tier callers always pass
 * `lowScore: false` regardless of cell quality.
 */
export function pickExploration(
  allCandidates: RouteTarget[],
  availableProviders: Set<string>,
  options: { stale?: boolean; regressed?: boolean; lowScore?: boolean } = {},
): RouteTarget | null {
  const eligible = allCandidates.filter((c) => availableProviders.has(c.provider));
  if (eligible.length <= 1) return null;
  const rate = options.regressed
    ? REGRESSED_EXPLORATION_RATE
    : options.lowScore
    ? LOW_SCORE_EXPLORATION_RATE
    : options.stale
    ? STALE_EXPLORATION_RATE
    : EXPLORATION_RATE;
  if (Math.random() >= rate) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

/** Helper for callers: is the most-recent updatedAt past the stale threshold? */
export function isStaleTimestamp(mostRecent: Date | null | undefined): boolean {
  if (!mostRecent) return false;
  return Date.now() - mostRecent.getTime() > STALE_AFTER_MS;
}
