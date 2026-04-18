/**
 * Spend trajectory compute (#219/T4). Pure: no DB, no clock — takes a
 * list of `{ date, cost }` daily buckets + a reference "now" + the
 * period type ("month" | "quarter") and returns
 *
 *   { period_start, period_end, mtd_cost, projected_cost, prior_period_cost, anomaly }
 *
 * where:
 *   - `mtd_cost` is spend from period_start up to now (exclusive of now).
 *   - `projected_cost` is a straight run-rate extrapolation: if the period
 *     is 40% elapsed and $X has been spent, projected = X / 0.4. First
 *     day of the period → projected equals the full-period floor
 *     (one-day run rate × period length) so the number isn't wildly
 *     noisy on day 1.
 *   - `prior_period_cost` is the same-length spend from the preceding
 *     period (e.g. last calendar month in full). Straight total, not
 *     prorated — the UI compares against the completed prior period.
 *   - `anomaly.flagged=true` when the last 7 days' daily average is
 *     greater than 2× the trailing 28-day daily average (T4 design).
 *     The 7-day window is the most-recent 7 days preceding `now`; the
 *     trailing 28-day baseline is the 28 days preceding that 7-day
 *     window (so the two windows don't overlap).
 *
 * Keeping this pure makes the scheduler- and dashboard-side caller
 * thin and keeps the anomaly threshold easy to unit-test without
 * wiring a DB.
 */

export const ANOMALY_MULTIPLIER = 2;
export const ANOMALY_RECENT_DAYS = 7;
export const ANOMALY_BASELINE_DAYS = 28;

export type TrajectoryPeriod = "month" | "quarter";

export interface DailyCost {
  /** Midnight UTC of the day this bucket covers. */
  date: Date;
  cost: number;
}

export interface TrajectoryResult {
  period_start: Date;
  period_end: Date;
  mtd_cost: number;
  projected_cost: number;
  prior_period_cost: number;
  anomaly: { flagged: boolean; reason: string | null };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function periodBounds(now: Date, period: TrajectoryPeriod): { start: Date; end: Date } {
  if (period === "month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start, end };
  }
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
  return { start, end };
}

function priorPeriodBounds(
  period: TrajectoryPeriod,
  current: { start: Date; end: Date },
): { start: Date; end: Date } {
  if (period === "month") {
    const start = new Date(Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1));
    return { start, end: current.start };
  }
  const start = new Date(Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 3, 1));
  return { start, end: current.start };
}

function sumInRange(daily: DailyCost[], start: Date, end: Date): number {
  let total = 0;
  for (const d of daily) {
    const t = d.date.getTime();
    if (t >= start.getTime() && t < end.getTime()) total += d.cost;
  }
  return total;
}

export function computeTrajectory(
  daily: DailyCost[],
  now: Date,
  period: TrajectoryPeriod,
): TrajectoryResult {
  const { start, end } = periodBounds(now, period);
  const prior = priorPeriodBounds(period, { start, end });
  const mtd = sumInRange(daily, start, now);

  const totalDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const elapsedDays = Math.max(
    1,
    Math.round((startOfDayUTC(now).getTime() - start.getTime()) / DAY_MS) + 1,
  );
  const projected = totalDays > 0 ? (mtd / elapsedDays) * totalDays : mtd;

  const priorTotal = sumInRange(daily, prior.start, prior.end);

  // Anomaly: 7-day recent window vs 28-day trailing baseline, non-overlapping.
  const recentEnd = startOfDayUTC(now);
  const recentStart = addDays(recentEnd, -ANOMALY_RECENT_DAYS);
  const baselineEnd = recentStart;
  const baselineStart = addDays(baselineEnd, -ANOMALY_BASELINE_DAYS);

  const recentTotal = sumInRange(daily, recentStart, recentEnd);
  const baselineTotal = sumInRange(daily, baselineStart, baselineEnd);
  const recentAvg = recentTotal / ANOMALY_RECENT_DAYS;
  const baselineAvg = baselineTotal / ANOMALY_BASELINE_DAYS;

  let anomaly: { flagged: boolean; reason: string | null } = { flagged: false, reason: null };
  if (baselineAvg > 0 && recentAvg > ANOMALY_MULTIPLIER * baselineAvg) {
    anomaly = {
      flagged: true,
      reason: `Last ${ANOMALY_RECENT_DAYS}-day daily avg ($${recentAvg.toFixed(2)}) is over ${ANOMALY_MULTIPLIER}× the prior ${ANOMALY_BASELINE_DAYS}-day avg ($${baselineAvg.toFixed(2)}).`,
    };
  }

  return {
    period_start: start,
    period_end: end,
    mtd_cost: mtd,
    projected_cost: projected,
    prior_period_cost: priorTotal,
    anomaly,
  };
}
