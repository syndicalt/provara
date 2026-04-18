import { Hono } from "hono";
import type { Db } from "@provara/db";
import { costLogs, requests, feedback, users, apiTokens, spendBudgets } from "@provara/db";
import { and, eq, gte, lt, sql, inArray } from "drizzle-orm";
import { getAuthUser } from "../auth/admin.js";
import { tenantHasTeamAccess, tenantHasEnterpriseAccess } from "../auth/tier.js";
import {
  computeTrajectory,
  periodBounds,
  type DailyCost,
  type TrajectoryPeriod,
} from "../billing/trajectory.js";
import {
  computeDriftEvents,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
} from "../billing/drift.js";

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

async function buildSpendRows(
  db: Db,
  tenantId: string,
  dim: SpendDim,
  window: WindowBounds,
  comparison: WindowBounds | null,
): Promise<SpendRow[]> {
  const [current, prior, judgeScores] = await Promise.all([
    aggregateSpend(db, tenantId, dim, window),
    comparison ? aggregateSpend(db, tenantId, dim, comparison) : Promise.resolve(new Map()),
    aggregateJudgeScores(db, tenantId, dim, window),
  ]);

  const labels = await resolveLabels(db, tenantId, dim, Array.from(current.keys()));

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
      ...(dim === "category"
        ? { task_type: spend.taskType, complexity: spend.complexity }
        : {}),
    });
  }

  rows.sort((a, b) => b.cost_usd - a.cost_usd);
  return rows;
}

/**
 * CSV serialization for `/v1/spend/export` (#219/T8). Finance-friendly:
 * header row, one line per attribution key, explicit `currency` column
 * set to USD on every row. Empty string for null numeric cells; a
 * deleted user / revoked token still renders by its fallback label.
 */
export function spendRowsToCsv(dim: SpendDim, rows: SpendRow[]): string {
  const headers = [
    "dim",
    "key",
    "label",
    "cost_usd",
    "currency",
    "requests",
    "judged_requests",
    "quality_median",
    "quality_p25",
    "quality_p75",
    "cost_per_quality_point",
    "delta_usd",
    "delta_pct",
    ...(dim === "category" ? ["task_type", "complexity"] : []),
  ];

  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "number" ? String(v) : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(",")];
  for (const r of rows) {
    const base = [
      dim,
      r.key,
      r.label,
      r.cost_usd,
      "USD",
      r.requests,
      r.judged_requests,
      r.quality_median,
      r.quality_p25,
      r.quality_p75,
      r.cost_per_quality_point,
      r.delta_usd,
      r.delta_pct,
    ];
    if (dim === "category") {
      base.push(r.task_type ?? "", r.complexity ?? "");
    }
    lines.push(base.map(esc).join(","));
  }
  return lines.join("\n") + (rows.length > 0 ? "\n" : "");
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

    const rows = await buildSpendRows(db, authUser.tenantId, rawDim, window, comparison);
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

  /**
   * GET /v1/spend/export?dim=...&from=...&to=...&compare=prior|yoy
   *
   * CSV export with the same filters as /v1/spend/by. Tier gate is the
   * same as /by — Team+ for provider/model/category, Enterprise for
   * user/token. Filename encodes tenant + date range so finance doesn't
   * end up with a folder of `export(1).csv ... export(17).csv`.
   */
  app.get("/export", async (c) => {
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
              ? "Per-user and per-token spend export are available on the Enterprise plan."
              : "Spend export is available on Team and Enterprise plans.",
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

    const rows = await buildSpendRows(db, authUser.tenantId, rawDim, window, comparison);
    const limited = rows.slice(0, MAX_ROWS);

    const fromLabel = window.from.toISOString().slice(0, 10);
    const toLabel = window.to.toISOString().slice(0, 10);
    const filename = `spend-${authUser.tenantId}-${rawDim}-${fromLabel}-${toLabel}.csv`;

    const csv = spendRowsToCsv(rawDim, limited);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    });
  });

  /**
   * GET /v1/spend/budgets — returns the tenant's single budget row, or
   * null when nothing is configured. Team+ gate.
   *
   * PUT /v1/spend/budgets — upsert the tenant's budget. Body:
   *   {
   *     period: "monthly" | "quarterly",
   *     cap_usd: number,
   *     alert_thresholds: number[],  // e.g. [50, 75, 90, 100]
   *     alert_emails: string[],
   *     hard_stop?: boolean           // default false
   *   }
   * A PUT resets `alerted_thresholds` for the current period (the caller
   * wants the latest config to take effect cleanly).
   */
  app.get("/budgets", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }
    if (!(await tenantHasTeamAccess(db, authUser.tenantId))) {
      return c.json(
        { error: { message: "Budgets are available on Team and Enterprise plans.", type: "insufficient_tier" } },
        402,
      );
    }
    const row = await db
      .select()
      .from(spendBudgets)
      .where(eq(spendBudgets.tenantId, authUser.tenantId))
      .get();
    return c.json({ budget: row ?? null });
  });

  app.put("/budgets", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }
    if (!(await tenantHasTeamAccess(db, authUser.tenantId))) {
      return c.json(
        { error: { message: "Budgets are available on Team and Enterprise plans.", type: "insufficient_tier" } },
        402,
      );
    }
    const body = await c.req.json().catch(() => null) as {
      period?: "monthly" | "quarterly";
      cap_usd?: number;
      alert_thresholds?: number[];
      alert_emails?: string[];
      hard_stop?: boolean;
    } | null;

    if (!body || typeof body.cap_usd !== "number" || body.cap_usd <= 0) {
      return c.json(
        { error: { message: "cap_usd is required and must be > 0.", type: "invalid_request" } },
        400,
      );
    }
    const period = body.period ?? "monthly";
    if (period !== "monthly" && period !== "quarterly") {
      return c.json(
        { error: { message: "period must be 'monthly' or 'quarterly'.", type: "invalid_request" } },
        400,
      );
    }
    const thresholds = (body.alert_thresholds ?? [50, 75, 90, 100])
      .filter((t) => typeof t === "number" && t > 0 && t <= 200);
    const emails = (body.alert_emails ?? []).filter((e) => typeof e === "string" && e.includes("@"));
    const hardStop = Boolean(body.hard_stop);

    // Period-start for reset semantics: use the current period's floor so
    // the reset logic in the scheduler treats a new budget as belonging
    // to the period in which it was created.
    const now = new Date();
    const periodStart = period === "monthly"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));

    const existing = await db
      .select()
      .from(spendBudgets)
      .where(eq(spendBudgets.tenantId, authUser.tenantId))
      .get();

    if (existing) {
      await db
        .update(spendBudgets)
        .set({
          period,
          capUsd: body.cap_usd,
          alertThresholds: thresholds,
          alertEmails: emails,
          hardStop,
          alertedThresholds: [],
          periodStartedAt: periodStart,
          updatedAt: now,
        })
        .where(eq(spendBudgets.tenantId, authUser.tenantId))
        .run();
    } else {
      await db
        .insert(spendBudgets)
        .values({
          tenantId: authUser.tenantId,
          period,
          capUsd: body.cap_usd,
          alertThresholds: thresholds,
          alertEmails: emails,
          hardStop,
          alertedThresholds: [],
          periodStartedAt: periodStart,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const row = await db
      .select()
      .from(spendBudgets)
      .where(eq(spendBudgets.tenantId, authUser.tenantId))
      .get();
    return c.json({ budget: row });
  });

  /**
   * GET /v1/spend/trajectory?period=month|quarter
   *
   * Returns MTD cost for the current period, a linear-run-rate forecast,
   * the prior period's total, and an anomaly flag when the last 7 days'
   * daily average exceeds 2× the trailing 28-day baseline. Team+ gate.
   */
  app.get("/trajectory", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }
    if (!(await tenantHasTeamAccess(db, authUser.tenantId))) {
      return c.json(
        {
          error: {
            message: "Spend trajectory is available on Team and Enterprise plans.",
            type: "insufficient_tier",
          },
        },
        402,
      );
    }

    const period = (c.req.query("period") ?? "month") as TrajectoryPeriod;
    if (period !== "month" && period !== "quarter") {
      return c.json(
        { error: { message: "Invalid period. Expected one of: month, quarter", type: "invalid_request" } },
        400,
      );
    }

    const now = new Date();
    const { start } = periodBounds(now, period);
    // Fetch daily buckets from the baseline window (35 days before period start
    // covers the anomaly baseline + recent window) up to now. One row per day
    // per tenant; we sum in SQL and bucketize in Node.
    const baselineStart = new Date(start.getTime() - 35 * 24 * 60 * 60 * 1000);

    const rawRows = await db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', ${costLogs.createdAt}, 'unixepoch')`,
        cost: sql<number>`COALESCE(SUM(${costLogs.cost}), 0)`,
      })
      .from(costLogs)
      .where(
        and(
          eq(costLogs.tenantId, authUser.tenantId),
          gte(costLogs.createdAt, baselineStart),
        ),
      )
      .groupBy(sql`strftime('%Y-%m-%d', ${costLogs.createdAt}, 'unixepoch')`)
      .all();

    const daily: DailyCost[] = rawRows
      .filter((r) => r.day)
      .map((r) => ({
        date: new Date(`${r.day}T00:00:00.000Z`),
        cost: Number(r.cost) || 0,
      }));

    const trajectory = computeTrajectory(daily, now, period);

    return c.json({
      period,
      period_start: trajectory.period_start.toISOString(),
      period_end: trajectory.period_end.toISOString(),
      mtd_cost: trajectory.mtd_cost,
      projected_cost: trajectory.projected_cost,
      prior_period_cost: trajectory.prior_period_cost,
      anomaly: trajectory.anomaly,
    });
  });

  /**
   * GET /v1/spend/drift?from=<iso>&to=<iso>&window=<days>
   *
   * Enterprise-only. Returns weight-change events in the requested
   * window along with the per-provider spend mix in the N-day attribution
   * window after each change. Unique-to-Provara analytical view —
   * standalone LLM analytics tools can't connect routing decisions to
   * cost outcomes because they don't see the router.
   */
  app.get("/drift", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }
    if (!(await tenantHasEnterpriseAccess(db, authUser.tenantId))) {
      return c.json(
        {
          error: {
            message: "Weight-drift analysis is available on the Enterprise plan.",
            type: "insufficient_tier",
          },
        },
        402,
      );
    }

    const window = parseWindow(c.req.query("from"), c.req.query("to"));
    const windowRaw = c.req.query("window");
    const attributionWindowDays = windowRaw
      ? Math.min(Math.max(1, Number(windowRaw) || DEFAULT_ATTRIBUTION_WINDOW_DAYS), 90)
      : DEFAULT_ATTRIBUTION_WINDOW_DAYS;

    const events = await computeDriftEvents(db, authUser.tenantId, {
      from: window.from,
      to: window.to,
      windowDays: attributionWindowDays,
    });

    return c.json({
      period: { from: window.from.toISOString(), to: window.to.toISOString() },
      attribution_window_days: attributionWindowDays,
      events,
    });
  });

  return app;
}
