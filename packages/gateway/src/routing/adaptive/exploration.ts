import type { RouteTarget } from "../types.js";

/**
 * ε-greedy exploration rate (#103). With this probability, bypass the EMA
 * and pick uniformly at random from the full candidate list — including
 * models with zero samples. Set to 0 to disable.
 *
 * Prevents cold-start lock-in: without exploration, once one model clears
 * MIN_SAMPLES before any competitor does, it wins permanently in that cell
 * because no alternative is ever eligible for the EMA comparison.
 */
export const EXPLORATION_RATE = parseFloat(process.env.PROVARA_EXPLORATION_RATE || "0.1");

/**
 * Returns a uniformly random eligible candidate if the ε-greedy branch
 * fires, else null. Callers fall through to the EMA-winner path on null.
 * Requires at least 2 eligible candidates — there's no meaningful choice
 * to make otherwise.
 */
export function pickExploration(
  allCandidates: RouteTarget[],
  availableProviders: Set<string>,
): RouteTarget | null {
  const eligible = allCandidates.filter((c) => availableProviders.has(c.provider));
  if (eligible.length <= 1) return null;
  if (Math.random() >= EXPLORATION_RATE) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}
