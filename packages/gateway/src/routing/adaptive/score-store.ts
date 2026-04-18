import type { ModelScore } from "./types.js";

/**
 * Sentinel for the shared-pool row in `model_scores`. Empty string, not NULL,
 * because SQLite treats NULL values in composite PK columns as distinct —
 * `ON CONFLICT (tenant_id, ...)` does not fire for NULL and you'd accumulate
 * duplicates on every upsert. See #176/#194 for the trace; the decision lives
 * in memory `project_adaptive_isolation_state_mgmt.md`.
 *
 * This constant leaks nowhere outside the routing subsystem — API surfaces,
 * dashboards, and Privacy Policy treat the pool as "no tenant" conceptually.
 */
export const POOL_KEY = "";

export function cellKey(taskType: string, complexity: string): string {
  return `${taskType}:${complexity}`;
}

export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function resolveTenantKey(tenantId: string | null | undefined): string {
  return tenantId ?? POOL_KEY;
}

/**
 * In-memory score map. One entry per `(tenant, taskType, complexity, provider, model)`.
 *
 * Tenant dimension added by #194 (C1 of #176). The pool is keyed by `POOL_KEY`
 * (empty string). Default-arg callers (no `tenantId`) act on the pool, preserving
 * pre-tenant-scoping behavior.
 *
 * Single-instance caveat: this map lives in process memory. Multiple gateway
 * replicas each hold a drifting copy; writes from replica-1 don't reach
 * replica-2 until the next restart. The `model_scores` table is the durable
 * source of truth so a single process recovers cleanly on boot. Horizontal
 * scaling is tracked in #50; overall state strategy in #121.
 *
 * Concurrency: these Maps are mutated in-place from async contexts
 * (persistence hydrate, updateScore, updateLatency). Node.js is
 * single-threaded for JS execution so reads won't see torn *memory*,
 * but a read can still observe a half-updated logical state if a
 * reader is scheduled between two awaits inside a writer. This is
 * acceptable today because (a) there's only one event loop, (b) the
 * writes are idempotent, and (c) any observed stale read converges on
 * the next update. Do NOT introduce worker threads here without
 * switching to an immutable-snapshot pattern first. Tracked in #137.
 */
export function createScoreStore() {
  // Outer key = tenantKey (POOL_KEY for pool). Middle = cellKey. Inner = modelKey.
  const scores = new Map<string, Map<string, Map<string, ModelScore>>>();

  function ensureTenantMap(tk: string): Map<string, Map<string, ModelScore>> {
    let tenant = scores.get(tk);
    if (!tenant) {
      tenant = new Map();
      scores.set(tk, tenant);
    }
    return tenant;
  }

  function ensureCellFor(tk: string, ck: string): Map<string, ModelScore> {
    const tenant = ensureTenantMap(tk);
    let cell = tenant.get(ck);
    if (!cell) {
      cell = new Map();
      tenant.set(ck, cell);
    }
    return cell;
  }

  return {
    get(
      taskType: string,
      complexity: string,
      provider: string,
      model: string,
      tenantId?: string | null,
    ): ModelScore | undefined {
      return scores
        .get(resolveTenantKey(tenantId))
        ?.get(cellKey(taskType, complexity))
        ?.get(modelKey(provider, model));
    },

    set(
      taskType: string,
      complexity: string,
      score: ModelScore,
      tenantId?: string | null,
    ): void {
      const cell = ensureCellFor(resolveTenantKey(tenantId), cellKey(taskType, complexity));
      cell.set(modelKey(score.provider, score.model), score);
    },

    getCellMap(
      taskType: string,
      complexity: string,
      tenantId?: string | null,
    ): Map<string, ModelScore> | undefined {
      return scores.get(resolveTenantKey(tenantId))?.get(cellKey(taskType, complexity));
    },

    /** Used by persistence to hydrate rows without going through `set` for each. */
    ensureCell(
      taskType: string,
      complexity: string,
      tenantId?: string | null,
    ): Map<string, ModelScore> {
      return ensureCellFor(resolveTenantKey(tenantId), cellKey(taskType, complexity));
    },

    getCellScores(
      taskType: string,
      complexity: string,
      tenantId?: string | null,
    ): ModelScore[] {
      const cell = scores.get(resolveTenantKey(tenantId))?.get(cellKey(taskType, complexity));
      return cell ? Array.from(cell.values()) : [];
    },

    getAllScores(
      tenantId?: string | null,
    ): { taskType: string; complexity: string; scores: ModelScore[] }[] {
      const tenant = scores.get(resolveTenantKey(tenantId));
      if (!tenant) return [];
      const result: { taskType: string; complexity: string; scores: ModelScore[] }[] = [];
      for (const [ck, cell] of tenant) {
        const [taskType, complexity] = ck.split(":");
        result.push({ taskType, complexity, scores: Array.from(cell.values()) });
      }
      return result;
    },
  };
}

export type ScoreStore = ReturnType<typeof createScoreStore>;
