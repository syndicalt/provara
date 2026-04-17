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
 * When `options.stale` is true, the higher `STALE_EXPLORATION_RATE`
 * applies instead of the normal rate. Stale detection itself lives in
 * `adaptive/router.ts`.
 */
export function pickExploration(
  allCandidates: RouteTarget[],
  availableProviders: Set<string>,
  options: { stale?: boolean } = {},
): RouteTarget | null {
  const eligible = allCandidates.filter((c) => availableProviders.has(c.provider));
  if (eligible.length <= 1) return null;
  const rate = options.stale ? STALE_EXPLORATION_RATE : EXPLORATION_RATE;
  if (Math.random() >= rate) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

/** Helper for callers: is the most-recent updatedAt past the stale threshold? */
export function isStaleTimestamp(mostRecent: Date | null | undefined): boolean {
  if (!mostRecent) return false;
  return Date.now() - mostRecent.getTime() > STALE_AFTER_MS;
}
