import type { Db } from "@provara/db";
import { costLogs, spendBudgets } from "@provara/db";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * Spend-budget alerts (#219/T7). Two public entry points:
 *
 *   runBudgetAlertsCycle(db, deps) — scheduler job, runs daily. For each
 *     tenant with a budget row, resolves the current period window,
 *     computes spend, and fires email for any newly-crossed threshold.
 *     Idempotent within a period via the `alerted_thresholds` array;
 *     it resets when `period_started_at` trails the current period.
 *
 *   checkBudgetHardStop(db, tenantId) — hot-path gate. Returns true if
 *     the tenant has a budget with `hard_stop=true` AND period spend is
 *     >= cap. One small SELECT per chat-completions request; mirrors
 *     the existing per-token `checkSpendLimit` pattern in
 *     `auth/rate-limiter.ts`.
 *
 * Period bounds are computed with the same conventions as the
 * trajectory module (`billing/trajectory.ts`): monthly = first of the
 * current UTC month; quarterly = first of the quarter (Jan 1 / Apr 1 /
 * Jul 1 / Oct 1).
 */

export type BudgetPeriod = "monthly" | "quarterly";

export interface SendEmailFn {
  (input: { to: string; subject: string; html: string; text: string }): Promise<unknown>;
}

export interface RunBudgetAlertsDeps {
  sendEmail: SendEmailFn;
  emailBuilder: (params: BudgetAlertEmailParams) => { subject: string; html: string; text: string };
  now?: Date;
}

export interface BudgetAlertEmailParams {
  tenantId: string;
  threshold: number;
  spendUsd: number;
  capUsd: number;
  period: BudgetPeriod;
  periodStart: Date;
  periodEnd: Date;
  dashboardUrl: string;
}

export interface RunBudgetAlertsStats {
  budgetsChecked: number;
  alertsFired: number;
  periodsReset: number;
}

export function periodBoundsUTC(now: Date, period: BudgetPeriod): { start: Date; end: Date } {
  if (period === "monthly") {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
  const q = Math.floor(now.getUTCMonth() / 3);
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1)),
  };
}

async function sumSpend(db: Db, tenantId: string, start: Date, end: Date): Promise<number> {
  const row = await db
    .select({ total: sql<number>`COALESCE(SUM(${costLogs.cost}), 0)` })
    .from(costLogs)
    .where(
      and(
        eq(costLogs.tenantId, tenantId),
        gte(costLogs.createdAt, start),
        sql`${costLogs.createdAt} < ${end}`,
      ),
    )
    .get();
  return Number(row?.total ?? 0) || 0;
}

function crossedThresholds(pct: number, thresholds: number[], already: number[]): number[] {
  const alreadySet = new Set(already);
  return thresholds
    .filter((t) => pct >= t && !alreadySet.has(t))
    .sort((a, b) => a - b);
}

export async function runBudgetAlertsCycle(
  db: Db,
  deps: RunBudgetAlertsDeps,
): Promise<RunBudgetAlertsStats> {
  const now = deps.now ?? new Date();
  const budgets = await db.select().from(spendBudgets).all();

  let alertsFired = 0;
  let periodsReset = 0;

  for (const budget of budgets) {
    const period = budget.period as BudgetPeriod;
    const { start, end } = periodBoundsUTC(now, period);

    // Reset if the stored period-start is behind the current period.
    let alerted = budget.alertedThresholds;
    let periodStartedAt = budget.periodStartedAt;
    if (periodStartedAt.getTime() < start.getTime()) {
      alerted = [];
      periodStartedAt = start;
      periodsReset += 1;
    }

    const effectiveEnd = end.getTime() < now.getTime() ? end : now;
    const spend = await sumSpend(db, budget.tenantId, start, effectiveEnd);
    const pct = budget.capUsd > 0 ? (spend / budget.capUsd) * 100 : 0;

    const newlyCrossed = crossedThresholds(pct, budget.alertThresholds, alerted);

    if (newlyCrossed.length > 0) {
      for (const threshold of newlyCrossed) {
        for (const to of budget.alertEmails) {
          const email = deps.emailBuilder({
            tenantId: budget.tenantId,
            threshold,
            spendUsd: spend,
            capUsd: budget.capUsd,
            period,
            periodStart: start,
            periodEnd: end,
            dashboardUrl: "https://www.provara.xyz/dashboard/spend",
          });
          try {
            await deps.sendEmail({ to, ...email });
            alertsFired += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[budget-alerts] email to ${to} failed for tenant=${budget.tenantId} threshold=${threshold}: ${msg}`,
            );
          }
        }
      }
      alerted = [...alerted, ...newlyCrossed];
    }

    if (newlyCrossed.length > 0 || periodStartedAt !== budget.periodStartedAt) {
      await db
        .update(spendBudgets)
        .set({
          alertedThresholds: alerted,
          periodStartedAt,
          updatedAt: new Date(),
        })
        .where(eq(spendBudgets.tenantId, budget.tenantId))
        .run();
    }
  }

  return { budgetsChecked: budgets.length, alertsFired, periodsReset };
}

/**
 * Fast check for the chat-completions hot path. Returns true if the
 * tenant has an active budget with hard_stop=on and current-period
 * spend has hit or exceeded the cap. Safe to call on every request;
 * costs one select + one aggregate. Missing budget → false (no gate).
 */
export async function checkBudgetHardStop(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ blocked: boolean; spend?: number; cap?: number; period?: BudgetPeriod }> {
  const budget = await db
    .select()
    .from(spendBudgets)
    .where(eq(spendBudgets.tenantId, tenantId))
    .get();
  if (!budget || !budget.hardStop) return { blocked: false };

  const period = budget.period as BudgetPeriod;
  const { start, end } = periodBoundsUTC(now, period);
  const spend = await sumSpend(db, tenantId, start, end.getTime() < now.getTime() ? end : now);
  if (spend < budget.capUsd) return { blocked: false, spend, cap: budget.capUsd, period };
  return { blocked: true, spend, cap: budget.capUsd, period };
}
