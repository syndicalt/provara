import type { Db } from "@provara/db";
import { costLogs, routingWeightSnapshots } from "@provara/db";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

/**
 * Drift analysis (#219/T5). Finds points where a tenant's resolved
 * routing weights changed (vs. the immediately-preceding snapshot) and,
 * for each change, computes the per-provider spend mix over the
 * following attribution window. Answers "I moved cost-weight from 0.4
 * to 0.7 last Thursday — did that actually shift the mix?".
 *
 * Last-write-wins within overlapping windows: the attribution window
 * for change N ends at change N+1's `captured_at` when they're less
 * than `windowDays` apart. Keeps the spend-mix deltas disjoint and
 * matches how ops thinks about change cause-and-effect.
 *
 * A "change" is any diff of > EPSILON_WEIGHT on any of the three
 * weight axes vs. the prior snapshot. The very first snapshot for a
 * tenant is not a change event — it's the baseline.
 */

export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 14;
export const EPSILON_WEIGHT = 0.01;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeightVec {
  quality: number;
  cost: number;
  latency: number;
}

export interface DriftEvent {
  changed_at: string;
  from_weights: WeightVec;
  to_weights: WeightVec;
  deltas: { quality: number; cost: number; latency: number };
  attribution_window_days: number;
  window_start: string;
  window_end: string;
  spend_mix: Array<{ provider: string; cost_usd: number; share_pct: number }>;
}

function weightsDifferBeyond(a: WeightVec, b: WeightVec, eps: number): boolean {
  return (
    Math.abs(a.quality - b.quality) > eps ||
    Math.abs(a.cost - b.cost) > eps ||
    Math.abs(a.latency - b.latency) > eps
  );
}

export async function computeDriftEvents(
  db: Db,
  tenantId: string,
  opts: {
    from: Date;
    to: Date;
    windowDays?: number;
    now?: Date;
  },
): Promise<DriftEvent[]> {
  const windowDays = opts.windowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS;
  const now = opts.now ?? new Date();

  // Pull all snapshots from an earlier point than `from` so we can
  // detect a change right at the boundary of the requested window
  // (the prior snapshot to compare against sits before `from`).
  const lookback = new Date(opts.from.getTime() - 60 * DAY_MS);
  const snapshots = await db
    .select()
    .from(routingWeightSnapshots)
    .where(
      and(
        eq(routingWeightSnapshots.tenantId, tenantId),
        gte(routingWeightSnapshots.capturedAt, lookback),
        lt(routingWeightSnapshots.capturedAt, opts.to),
      ),
    )
    .orderBy(asc(routingWeightSnapshots.capturedAt))
    .all();

  const events: DriftEvent[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    if (!weightsDifferBeyond(prev.weights, cur.weights, EPSILON_WEIGHT)) continue;
    if (cur.capturedAt.getTime() < opts.from.getTime()) continue;

    const windowEndIdeal = new Date(cur.capturedAt.getTime() + windowDays * DAY_MS);
    // Last-write-wins truncation: end at the next change if it lands
    // inside the ideal window, or at `now` if the window runs past
    // present.
    const nextChange = snapshots
      .slice(i + 1)
      .find((s) => weightsDifferBeyond(snapshots[i].weights, s.weights, EPSILON_WEIGHT));
    const windowEnd = new Date(
      Math.min(
        windowEndIdeal.getTime(),
        nextChange?.capturedAt.getTime() ?? Infinity,
        now.getTime(),
      ),
    );
    const effectiveWindowDays = (windowEnd.getTime() - cur.capturedAt.getTime()) / DAY_MS;
    if (effectiveWindowDays <= 0) continue;

    const mix = await providerSpendMix(db, tenantId, cur.capturedAt, windowEnd);

    events.push({
      changed_at: cur.capturedAt.toISOString(),
      from_weights: prev.weights,
      to_weights: cur.weights,
      deltas: {
        quality: round(cur.weights.quality - prev.weights.quality),
        cost: round(cur.weights.cost - prev.weights.cost),
        latency: round(cur.weights.latency - prev.weights.latency),
      },
      attribution_window_days: round(effectiveWindowDays),
      window_start: cur.capturedAt.toISOString(),
      window_end: windowEnd.toISOString(),
      spend_mix: mix,
    });
  }

  return events;
}

async function providerSpendMix(
  db: Db,
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Array<{ provider: string; cost_usd: number; share_pct: number }>> {
  const rows = await db
    .select({
      provider: costLogs.provider,
      cost: sql<number>`COALESCE(SUM(${costLogs.cost}), 0)`,
    })
    .from(costLogs)
    .where(
      and(
        eq(costLogs.tenantId, tenantId),
        gte(costLogs.createdAt, start),
        sql`${costLogs.createdAt} < ${end}`,
      ),
    )
    .groupBy(costLogs.provider)
    .all();

  const total = rows.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
  return rows
    .map((r) => ({
      provider: r.provider,
      cost_usd: Number(r.cost) || 0,
      share_pct: total > 0 ? round(((Number(r.cost) || 0) / total) * 100) : 0,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

function round(n: number, places = 4): number {
  const factor = Math.pow(10, places);
  return Math.round(n * factor) / factor;
}
