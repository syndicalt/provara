import { Hono } from "hono";
import type { Db } from "@provara/db";
import { costLogs, requests, feedback, users, apiTokens } from "@provara/db";
import { and, eq, gte, lt, sql, inArray } from "drizzle-orm";
import { getAuthUser } from "../auth/admin.js";
import { tenantHasTeamAccess, tenantHasEnterpriseAccess } from "../auth/tier.js";

/**
 * Spend intelligence API (#219). All endpoints under `/v1/spend/*` are
 * tenant-scoped via `getAuthUser`, and tier-gated inline (different dims
 * land on different tiers).
 *
 * Quality envelope is cross-cutting (#219 Approach): every row carries
 * `{ quality_median, quality_p25, quality_p75, judged_requests,
 * cost_per_quality_point }` computed over the judge-rated subset. Judge
 * rows live in `feedback` where `source='judge'`; the aggregation does
 * one extra grouped fetch for scores and merges in Node, which keeps the
 * SQL percentile-free (libSQL lacks `PERCENTILE_DISC`).
 *
 * Period comparison: `compare=prior` (default) or `compare=yoy`. Delta
 * is (current - comparison) attached to each row; rows that exist only
 * in the comparison period are not returned (a dim key with zero current
 * spend is off the dashboard by definition).
 */

export const SPEND_DIMS = ["provider", "model", "user", "token", "category"] as const;
export type SpendDim = (typeof SPEND_DIMS)[number];

const ENTERPRISE_DIMS = new Set<SpendDim>(["user", "token"]);
const DEFAULT_WINDOW_DAYS = 30;
const MAX_ROWS = 500;

export interface SpendRow {
  key: string;
  label: string;
  cost_usd: number;
  requests: number;
  judged_requests: number;
  quality_median: number | null;
  quality_p25: number | null;
  quality_p75: number | null;
  cost_per_quality_point: number | null;
  delta_usd: number | null;
  delta_pct: number | null;
  // `dim=category` additionally returns the structured task_type/complexity
  // for UIs that want to render them independently of the composite label.
  task_type?: string;
  complexity?: string;
}

interface WindowBounds {
  from: Date;
  to: Date;
}

function parseWindow(fromRaw: string | undefined, toRaw: string | undefined): WindowBounds {
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw
    ? new Date(fromRaw)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

function priorWindow(current: WindowBounds): WindowBounds {
  const span = current.to.getTime() - current.from.getTime();
  return { from: new Date(current.from.getTime() - span), to: current.from };
}

function yoyWindow(current: WindowBounds): WindowBounds {
  const shift = (d: Date) => {
    const n = new Date(d);
    n.setFullYear(n.getFullYear() - 1);
    return n;
  };
  return { from: shift(current.from), to: shift(current.to) };
}

/**
 * Linear-interpolation percentile (numpy / R type-7 default) over a
 * sorted sample. `p` is 0..1. Returns null on empty input so the UI
 * can render "no quality data" instead of a misleading zero. Judge
 * scores are integers 1..5, so halves (e.g. median of [4,5] → 4.5)
 * carry real signal and we don't round.
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const h = p * (sorted.length - 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function categoryKey(taskType: string | null, complexity: string | null): string {
  return `${taskType ?? "unknown"}+${complexity ?? "unknown"}`;
}

/**
 * Spend aggregation grouped by `dim` over [from, to). Returns a map keyed
 * by the dim's natural key. For `dim=category`, the key is
 * `${task_type}+${complexity}` and the structured fields travel alongside.
 */
async function aggregateSpend(
  db: Db,
  tenantId: string,
  dim: SpendDim,
  window: WindowBounds,
): Promise<Map<string, { cost: number; requests: number; taskType?: string; complexity?: string }>> {
  const out = new Map<string, { cost: number; requests: number; taskType?: string; complexity?: string }>();

  if (dim === "provider" || dim === "model" || dim === "user" || dim === "token") {
    const col =
      dim === "provider" ? costLogs.provider :
      dim === "model" ? costLogs.model :
      dim === "user" ? costLogs.userId :
      costLogs.apiTokenId;

    const rows = await db
      .select({
        key: col,
        cost: sql<number>`COALESCE(SUM(${costLogs.cost}), 0)`,
        requests: sql<number>`COUNT(*)`,
      })
      .from(costLogs)
      .where(
        and(
          eq(costLogs.tenantId, tenantId),
          gte(costLogs.createdAt, window.from),
          lt(costLogs.createdAt, window.to),
        ),
      )
      .groupBy(col)
      .all();

    for (const r of rows) {
      if (r.key == null) continue;
      out.set(r.key, { cost: Number(r.cost) || 0, requests: Number(r.requests) || 0 });
    }
    return out;
  }

  // dim === "category" — join cost_logs → requests for task_type/complexity.
  const rows = await db
    .select({
      taskType: requests.taskType,
      complexity: requests.complexity,
      cost: sql<number>`COALESCE(SUM(${costLogs.cost}), 0)`,
      requests: sql<number>`COUNT(*)`,
    })
    .from(costLogs)
    .innerJoin(requests, eq(costLogs.requestId, requests.id))
    .where(
      and(
        eq(costLogs.tenantId, tenantId),
        gte(costLogs.createdAt, window.from),
        lt(costLogs.createdAt, window.to),
      ),
    )
    .groupBy(requests.taskType, requests.complexity)
    .all();

  for (const r of rows) {
    const key = categoryKey(r.taskType, r.complexity);
    out.set(key, {
      cost: Number(r.cost) || 0,
      requests: Number(r.requests) || 0,
      taskType: r.taskType ?? undefined,
      complexity: r.complexity ?? undefined,
    });
  }
  return out;
}

/**
 * Pull judge scores for the current window and bucket them by the same
 * dim key the spend aggregation uses. Judge scores live in `feedback`
 * where `source='judge'`; we join to `requests` for dim fields other
 * than user/token (which are also denormalized on `cost_logs`, but
 * feedback → requests → cost_logs introduces the same join either way,
 * and requests has all dim fields).
 */
async function aggregateJudgeScores(
  db: Db,
  tenantId: string,
  dim: SpendDim,
  window: WindowBounds,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();

  const dimExpr =
    dim === "provider" ? requests.provider :
    dim === "model" ? requests.model :
    dim === "user" ? requests.userId :
    dim === "token" ? requests.apiTokenId :
    null; // category → composite

  if (dim === "category") {
    const rows = await db
      .select({
        taskType: requests.taskType,
        complexity: requests.complexity,
        score: feedback.score,
      })
      .from(feedback)
      .innerJoin(requests, eq(feedback.requestId, requests.id))
      .where(
        and(
          eq(feedback.source, "judge"),
          eq(feedback.tenantId, tenantId),
          gte(feedback.createdAt, window.from),
          lt(feedback.createdAt, window.to),
        ),
      )
      .all();

    for (const r of rows) {
      const key = categoryKey(r.taskType, r.complexity);
      const bucket = out.get(key) ?? [];
      bucket.push(r.score);
      out.set(key, bucket);
    }
    return out;
  }

  const rows = await db
    .select({
      key: dimExpr!,
      score: feedback.score,
    })
    .from(feedback)
    .innerJoin(requests, eq(feedback.requestId, requests.id))
    .where(
      and(
        eq(feedback.source, "judge"),
        eq(feedback.tenantId, tenantId),
        gte(feedback.createdAt, window.from),
        lt(feedback.createdAt, window.to),
      ),
    )
    .all();

  for (const r of rows) {
    if (r.key == null) continue;
    const bucket = out.get(r.key) ?? [];
    bucket.push(r.score);
    out.set(r.key, bucket);
  }
  return out;
}

/**
 * Resolve display labels for user/token dims in one batch. Falls back to
 * "Unknown user (<id-prefix>)" / "Revoked token (<id-prefix>)" when the
 * referenced row has been deleted — spend history outlives the user or
 * token, and the dashboard needs something human-readable.
 */
async function resolveLabels(
  db: Db,
  tenantId: string,
  dim: SpendDim,
  keys: string[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (keys.length === 0) return labels;

  if (dim === "user") {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, keys)))
      .all();
    for (const r of rows) labels.set(r.id, r.email);
    for (const k of keys) {
      if (!labels.has(k)) labels.set(k, `Unknown user (${k.slice(0, 8)})`);
    }
    return labels;
  }

  if (dim === "token") {
    const rows = await db
      .select({ id: apiTokens.id, name: apiTokens.name })
      .from(apiTokens)
      .where(and(eq(apiTokens.tenant, tenantId), inArray(apiTokens.id, keys)))
      .all();
    for (const r of rows) labels.set(r.id, r.name);
    for (const k of keys) {
      if (!labels.has(k)) labels.set(k, `Revoked token (${k.slice(0, 8)})`);
    }
    return labels;
  }

  // provider / model / category: label == key
  for (const k of keys) labels.set(k, k);
  return labels;
}

export function createSpendRoutes(db: Db) {
  const app = new Hono();

  app.get("/by", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }

    const rawDim = (c.req.query("dim") ?? "provider") as SpendDim;
    if (!SPEND_DIMS.includes(rawDim)) {
      return c.json(
        { error: { message: `Invalid dim. Expected one of: ${SPEND_DIMS.join(", ")}`, type: "invalid_request" } },
        400,
      );
    }

    const hasTier = ENTERPRISE_DIMS.has(rawDim)
      ? await tenantHasEnterpriseAccess(db, authUser.tenantId)
      : await tenantHasTeamAccess(db, authUser.tenantId);
    if (!hasTier) {
      return c.json(
        {
          error: {
            message: ENTERPRISE_DIMS.has(rawDim)
              ? "Per-user and per-token spend attribution are available on the Enterprise plan."
              : "Spend intelligence is available on Team and Enterprise plans.",
            type: "insufficient_tier",
          },
        },
        402,
      );
    }

    const window = parseWindow(c.req.query("from"), c.req.query("to"));
    const compareMode = (c.req.query("compare") ?? "prior").toLowerCase();
    const comparison =
      compareMode === "yoy" ? yoyWindow(window) :
      compareMode === "prior" ? priorWindow(window) :
      null;

    const [current, prior, judgeScores] = await Promise.all([
      aggregateSpend(db, authUser.tenantId, rawDim, window),
      comparison ? aggregateSpend(db, authUser.tenantId, rawDim, comparison) : Promise.resolve(new Map()),
      aggregateJudgeScores(db, authUser.tenantId, rawDim, window),
    ]);

    const labels = await resolveLabels(db, authUser.tenantId, rawDim, Array.from(current.keys()));

    const rows: SpendRow[] = [];
    for (const [key, spend] of current.entries()) {
      const scores = (judgeScores.get(key) ?? []).slice().sort((a, b) => a - b);
      const median = percentile(scores, 0.5);
      const p25 = percentile(scores, 0.25);
      const p75 = percentile(scores, 0.75);
      const cppq = median != null && median > 0 ? spend.cost / median : null;

      const priorCost = prior.get(key)?.cost ?? 0;
      const deltaUsd = comparison ? spend.cost - priorCost : null;
      const deltaPct = comparison
        ? priorCost > 0 ? (spend.cost - priorCost) / priorCost : null
        : null;

      rows.push({
        key,
        label: labels.get(key) ?? key,
        cost_usd: spend.cost,
        requests: spend.requests,
        judged_requests: scores.length,
        quality_median: median,
        quality_p25: p25,
        quality_p75: p75,
        cost_per_quality_point: cppq,
        delta_usd: deltaUsd,
        delta_pct: deltaPct,
        ...(rawDim === "category"
          ? { task_type: spend.taskType, complexity: spend.complexity }
          : {}),
      });
    }

    rows.sort((a, b) => b.cost_usd - a.cost_usd);
    const limited = rows.slice(0, MAX_ROWS);

    return c.json({
      dim: rawDim,
      period: { from: window.from.toISOString(), to: window.to.toISOString() },
      compare_period: comparison
        ? { from: comparison.from.toISOString(), to: comparison.to.toISOString(), mode: compareMode }
        : null,
      rows: limited,
      truncated: rows.length > MAX_ROWS,
    });
  });

  return app;
}
