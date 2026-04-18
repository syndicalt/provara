import type { Db } from "@provara/db";
import { costMigrations, modelScores, requests, appConfig } from "@provara/db";
import { and, eq, sql, desc, isNull, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { MIN_SAMPLES, getModelCost } from "./scoring.js";
import { POOL_KEY } from "./score-store.js";
import { listTenantsWithAdaptiveIsolation } from "./isolation-policy.js";
import { tenantHasIntelligenceAccess } from "../../auth/tier.js";

function numEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const parsed = parseFloat(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const parsed = parseInt(v, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Quality tolerance — a competitor within this margin of the winner is eligible. 1-5 scale. */
export const EPSILON_QUALITY = numEnv(process.env.PROVARA_COST_MIGRATION_EPSILON, 0.2);

/** Cheapest candidate must beat the incumbent by this multiplier — e.g. 0.8 = at most 80% of incumbent cost. */
export const COST_RATIO_THRESHOLD = numEnv(process.env.PROVARA_COST_MIGRATION_RATIO, 0.8);

/** Sample floor: migrations require double-confidence vs. normal routing. */
export const MIGRATION_MIN_SAMPLES = Math.max(MIN_SAMPLES * 2, intEnv(process.env.PROVARA_COST_MIGRATION_MIN_SAMPLES, MIN_SAMPLES * 2));

/** Hard cap on migrations per scheduler cycle — guards against mass reshuffle. */
export const MAX_MIGRATIONS_PER_CYCLE = intEnv(process.env.PROVARA_COST_MIGRATION_MAX_PER_CYCLE, 3);

/** Temporary boost added to the target's EMA during the grace window. */
export const GRACE_BOOST = numEnv(process.env.PROVARA_COST_MIGRATION_GRACE_BOOST, 0.3);

/** Grace window length in days — boost tapers off to zero after this. */
export const GRACE_DAYS = intEnv(process.env.PROVARA_COST_MIGRATION_GRACE_DAYS, 30);

/** Cooldown before the same cell can be re-migrated, in days. */
export const COOLDOWN_DAYS = intEnv(process.env.PROVARA_COST_MIGRATION_COOLDOWN_DAYS, 30);

const OPT_IN_CONFIG_PREFIX = "cost_migration_opt_in:";

function optInKey(tenantId: string | null): string {
  return `${OPT_IN_CONFIG_PREFIX}${tenantId ?? "_global"}`;
}

export async function isCostMigrationEnabled(db: Db, tenantId: string | null): Promise<boolean> {
  const row = await db.select().from(appConfig).where(eq(appConfig.key, optInKey(tenantId))).get();
  return row?.value === "true";
}

export async function setCostMigrationOptIn(db: Db, tenantId: string | null, enabled: boolean): Promise<void> {
  const now = new Date();
  const value = enabled ? "true" : "false";
  await db
    .insert(appConfig)
    .values({ key: optInKey(tenantId), value, updatedAt: now })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: now } })
    .run();
}

interface CellRow {
  taskType: string;
  complexity: string;
  provider: string;
  model: string;
  qualityScore: number;
  sampleCount: number;
  updatedAt: Date | null;
}

export interface MigrationCandidate {
  taskType: string;
  complexity: string;
  from: { provider: string; model: string; qualityScore: number; costPer1M: number };
  to: { provider: string; model: string; qualityScore: number; costPer1M: number };
  projectedMonthlySavingsUsd: number;
}

async function recentCellAvgTokens(db: Db, cell: { taskType: string; complexity: string; provider: string; model: string }) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const row = await db
    .select({
      count: sql<number>`count(*)`,
      avgInput: sql<number>`avg(${requests.inputTokens})`,
      avgOutput: sql<number>`avg(${requests.outputTokens})`,
    })
    .from(requests)
    .where(
      and(
        eq(requests.taskType, cell.taskType),
        eq(requests.complexity, cell.complexity),
        eq(requests.provider, cell.provider),
        eq(requests.model, cell.model),
        sql`${requests.createdAt} > ${Math.floor(thirtyDaysAgo.getTime() / 1000)}`,
      ),
    )
    .get();
  return {
    count: row?.count ?? 0,
    avgInput: row?.avgInput ?? 0,
    avgOutput: row?.avgOutput ?? 0,
  };
}

/**
 * Project monthly USD savings from swapping `from` to `to` at the cell's
 * current 30-day traffic pattern. Returns 0 when no traffic data is
 * available — migration still fires in that case (cell must have picked
 * up a winner somehow), but UI shows "$0 projected" rather than garbage.
 */
async function projectSavings(
  db: Db,
  cell: { taskType: string; complexity: string; provider: string; model: string },
  from: { costPer1M: number },
  to: { costPer1M: number },
): Promise<number> {
  const traffic = await recentCellAvgTokens(db, cell);
  if (traffic.count === 0) return 0;
  const monthlyRate = traffic.count; // requests in last 30 days ≈ current monthly rate
  const tokensPerReq = (traffic.avgInput + traffic.avgOutput);
  const costBefore = (tokensPerReq * monthlyRate / 1_000_000) * from.costPer1M;
  const costAfter = (tokensPerReq * monthlyRate / 1_000_000) * to.costPer1M;
  return Math.max(0, costBefore - costAfter);
}

/**
 * Scan model_scores for cells where a cheaper competitor is at-or-above
 * (winner - epsilon) quality with enough samples and fresh signal. Returns
 * ranked candidates for the current cycle; caller enforces the per-run
 * cap and cooldown.
 *
 * Scope: `scopeTenantId` is the DB-layer tenant key. Pass `POOL_KEY` ("")
 * for the shared-pool pass (Free/Pro), or a real tenantId for Team/Enterprise
 * tenants that maintain their own row. Pre-#196 (C3) this scanned globally —
 * a silent cross-tenant leak once tenant rows started existing.
 */
export async function findMigrationCandidates(
  db: Db,
  scopeTenantId: string = POOL_KEY,
): Promise<MigrationCandidate[]> {
  const rows = await db
    .select()
    .from(modelScores)
    .where(eq(modelScores.tenantId, scopeTenantId))
    .all();
  const cells = new Map<string, CellRow[]>();
  const now = Date.now();
  const staleCutoff = now - 30 * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    if (row.sampleCount < MIGRATION_MIN_SAMPLES) continue;
    if (!row.updatedAt || row.updatedAt.getTime() < staleCutoff) continue;
    const key = `${row.taskType}::${row.complexity}`;
    const existing = cells.get(key) ?? [];
    existing.push({
      taskType: row.taskType,
      complexity: row.complexity,
      provider: row.provider,
      model: row.model,
      qualityScore: row.qualityScore,
      sampleCount: row.sampleCount,
      updatedAt: row.updatedAt,
    });
    cells.set(key, existing);
  }

  const candidates: MigrationCandidate[] = [];
  for (const group of cells.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.qualityScore - a.qualityScore);
    const winner = sorted[0];
    const winnerCost = getModelCost(winner.model);
    if (winnerCost <= 0) continue;

    let best: { row: CellRow; cost: number } | null = null;
    for (const alt of sorted.slice(1)) {
      const altCost = getModelCost(alt.model);
      if (altCost <= 0) continue;
      if (altCost >= winnerCost * COST_RATIO_THRESHOLD) continue;
      if (winner.qualityScore - alt.qualityScore > EPSILON_QUALITY) continue;
      if (!best || altCost < best.cost) {
        best = { row: alt, cost: altCost };
      }
    }

    if (!best) continue;

    const savings = await projectSavings(
      db,
      { taskType: winner.taskType, complexity: winner.complexity, provider: winner.provider, model: winner.model },
      { costPer1M: winnerCost },
      { costPer1M: best.cost },
    );

    candidates.push({
      taskType: winner.taskType,
      complexity: winner.complexity,
      from: {
        provider: winner.provider,
        model: winner.model,
        qualityScore: winner.qualityScore,
        costPer1M: winnerCost,
      },
      to: {
        provider: best.row.provider,
        model: best.row.model,
        qualityScore: best.row.qualityScore,
        costPer1M: best.cost,
      },
      projectedMonthlySavingsUsd: savings,
    });
  }

  // Biggest savings first — we'll cap at MAX_MIGRATIONS_PER_CYCLE
  return candidates.sort((a, b) => b.projectedMonthlySavingsUsd - a.projectedMonthlySavingsUsd);
}

async function wasCellRecentlyMigrated(db: Db, tenantId: string | null, taskType: string, complexity: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const row = await db
    .select({ id: costMigrations.id })
    .from(costMigrations)
    .where(
      and(
        tenantId ? eq(costMigrations.tenantId, tenantId) : isNull(costMigrations.tenantId),
        eq(costMigrations.taskType, taskType),
        eq(costMigrations.complexity, complexity),
        sql`${costMigrations.executedAt} > ${Math.floor(cutoff.getTime() / 1000)}`,
      ),
    )
    .get();
  return Boolean(row);
}

export interface ExecutedMigration {
  id: string;
  taskType: string;
  complexity: string;
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  projectedMonthlySavingsUsd: number;
}

export async function executeMigration(
  db: Db,
  tenantId: string | null,
  candidate: MigrationCandidate,
): Promise<ExecutedMigration | null> {
  if (await wasCellRecentlyMigrated(db, tenantId, candidate.taskType, candidate.complexity)) {
    return null;
  }

  const id = nanoid();
  const graceEndsAt = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  await db
    .insert(costMigrations)
    .values({
      id,
      tenantId,
      taskType: candidate.taskType,
      complexity: candidate.complexity,
      fromProvider: candidate.from.provider,
      fromModel: candidate.from.model,
      fromCostPer1M: candidate.from.costPer1M,
      fromQualityScore: candidate.from.qualityScore,
      toProvider: candidate.to.provider,
      toModel: candidate.to.model,
      toCostPer1M: candidate.to.costPer1M,
      toQualityScore: candidate.to.qualityScore,
      projectedMonthlySavingsUsd: candidate.projectedMonthlySavingsUsd,
      graceEndsAt,
    })
    .run();

  console.log(
    `[cost-migration] ${candidate.taskType}+${candidate.complexity}: ${candidate.from.provider}/${candidate.from.model} → ${candidate.to.provider}/${candidate.to.model} (save $${candidate.projectedMonthlySavingsUsd.toFixed(2)}/mo)`,
  );

  return {
    id,
    taskType: candidate.taskType,
    complexity: candidate.complexity,
    from: { provider: candidate.from.provider, model: candidate.from.model },
    to: { provider: candidate.to.provider, model: candidate.to.model },
    projectedMonthlySavingsUsd: candidate.projectedMonthlySavingsUsd,
  };
}

export interface MigrationCycleStats {
  evaluated: number;
  executed: ExecutedMigration[];
  skippedCooldown: number;
}

/**
 * Per-scope migration pass. Returns stats for a single (scope) iteration.
 * `scope` is `null` for the shared pool; for a Team/Enterprise tenant it's
 * the tenantId. Keeps opt-in gate and cooldown semantics identical to the
 * pre-#196 global cycle — just bounded by scope.
 */
async function runCostMigrationScope(
  db: Db,
  scope: string | null,
): Promise<MigrationCycleStats> {
  const enabled = await isCostMigrationEnabled(db, scope);
  if (!enabled) {
    return { evaluated: 0, executed: [], skippedCooldown: 0 };
  }

  const dbScope = scope ?? POOL_KEY;
  const candidates = await findMigrationCandidates(db, dbScope);
  const executed: ExecutedMigration[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    if (executed.length >= MAX_MIGRATIONS_PER_CYCLE) break;
    const result = await executeMigration(db, scope, candidate);
    if (result) executed.push(result);
    else skipped++;
  }

  return { evaluated: candidates.length, executed, skippedCooldown: skipped };
}

/**
 * Top-level migration cycle — runs one pass for the shared pool and one
 * pass per Team/Enterprise tenant with isolation. Pool keeps benefiting
 * Free/Pro unchanged; tenant passes respect tier gate + per-tenant
 * opt-in + per-scope MAX_MIGRATIONS cap.
 *
 * Pre-C3 this ran once globally with `tenantId=null` hardcoded, meaning
 * tenant-scoped `model_scores` rows were invisible to it and global rows
 * were mutated on every tenant's behalf. Now the global scope is the
 * pool proper, and tenant scopes are distinct.
 */
export async function runCostMigrationCycle(db: Db): Promise<MigrationCycleStats> {
  const poolStats = await runCostMigrationScope(db, null);

  const aggregate: MigrationCycleStats = {
    evaluated: poolStats.evaluated,
    executed: [...poolStats.executed],
    skippedCooldown: poolStats.skippedCooldown,
  };

  if (poolStats.executed.length > 0) {
    const saved = poolStats.executed.reduce((s, m) => s + m.projectedMonthlySavingsUsd, 0);
    console.log(`[cost-migration] pool: executed ${poolStats.executed.length}, projected $${saved.toFixed(2)}/mo`);
  }

  const tenantIds = await listTenantsWithAdaptiveIsolation(db);
  for (const tenantId of tenantIds) {
    const hasTier = await tenantHasIntelligenceAccess(db, tenantId);
    if (!hasTier) continue;
    const stats = await runCostMigrationScope(db, tenantId);
    aggregate.evaluated += stats.evaluated;
    aggregate.executed.push(...stats.executed);
    aggregate.skippedCooldown += stats.skippedCooldown;
    if (stats.executed.length > 0) {
      const saved = stats.executed.reduce((s, m) => s + m.projectedMonthlySavingsUsd, 0);
      console.log(`[cost-migration] tenant=${tenantId}: executed ${stats.executed.length}, projected $${saved.toFixed(2)}/mo`);
    }
  }

  return aggregate;
}

/**
 * In-memory grace-boost table. The adaptive router consults this on every
 * routing decision to give migration targets a temporary EMA nudge during
 * the grace window. Loaded from DB at boot; callers must `refresh()` after
 * a new migration fires to pick it up without a restart.
 */
export interface BoostTable {
  getBoost(taskType: string, complexity: string, provider: string, model: string): number;
  refresh(): Promise<void>;
}

export function createBoostTable(db: Db): BoostTable {
  const boosts = new Map<string, number>();

  function key(taskType: string, complexity: string, provider: string, model: string): string {
    return `${taskType}::${complexity}::${provider}::${model}`;
  }

  async function refresh(): Promise<void> {
    boosts.clear();
    const now = new Date();
    const active = await db
      .select()
      .from(costMigrations)
      .where(
        and(
          isNull(costMigrations.rolledBackAt),
          gt(costMigrations.graceEndsAt, now),
        ),
      )
      .all();
    for (const row of active) {
      boosts.set(key(row.taskType, row.complexity, row.toProvider, row.toModel), GRACE_BOOST);
    }
  }

  function getBoost(taskType: string, complexity: string, provider: string, model: string): number {
    return boosts.get(key(taskType, complexity, provider, model)) ?? 0;
  }

  return { getBoost, refresh };
}

export async function listMigrations(db: Db, tenantId: string | null, limit = 100) {
  const where = tenantId ? eq(costMigrations.tenantId, tenantId) : isNull(costMigrations.tenantId);
  return db
    .select()
    .from(costMigrations)
    .where(where)
    .orderBy(desc(costMigrations.executedAt))
    .limit(limit)
    .all();
}

export async function rollbackMigration(
  db: Db,
  id: string,
  reason: string,
): Promise<boolean> {
  const row = await db.select().from(costMigrations).where(eq(costMigrations.id, id)).get();
  if (!row || row.rolledBackAt) return false;
  await db
    .update(costMigrations)
    .set({ rolledBackAt: new Date(), rollbackReason: reason })
    .where(eq(costMigrations.id, id))
    .run();
  return true;
}

export async function totalSavingsThisMonth(db: Db, tenantId: string | null): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ projected: costMigrations.projectedMonthlySavingsUsd })
    .from(costMigrations)
    .where(
      and(
        tenantId ? eq(costMigrations.tenantId, tenantId) : isNull(costMigrations.tenantId),
        isNull(costMigrations.rolledBackAt),
        sql`${costMigrations.executedAt} >= ${Math.floor(monthStart.getTime() / 1000)}`,
      ),
    )
    .all();
  return rows.reduce((s, r) => s + r.projected, 0);
}
