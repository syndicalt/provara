import type { ModelScore } from "./types.js";

export function cellKey(taskType: string, complexity: string): string {
  return `${taskType}:${complexity}`;
}

export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * In-memory score map. One entry per `(taskType, complexity, provider, model)`.
 *
 * Single-instance caveat: this map lives in process memory. Multiple gateway
 * replicas each hold a drifting copy; writes from replica-1 don't reach
 * replica-2 until the next restart. The `model_scores` table is the durable
 * source of truth so a single process recovers cleanly on boot. Horizontal
 * scaling is tracked in #50; overall state strategy in #121.
 */
export function createScoreStore() {
  const scores = new Map<string, Map<string, ModelScore>>();

  function ensureCell(ck: string): Map<string, ModelScore> {
    let cell = scores.get(ck);
    if (!cell) {
      cell = new Map();
      scores.set(ck, cell);
    }
    return cell;
  }

  return {
    get(taskType: string, complexity: string, provider: string, model: string): ModelScore | undefined {
      return scores.get(cellKey(taskType, complexity))?.get(modelKey(provider, model));
    },

    set(taskType: string, complexity: string, score: ModelScore): void {
      const cell = ensureCell(cellKey(taskType, complexity));
      cell.set(modelKey(score.provider, score.model), score);
    },

    getCellMap(taskType: string, complexity: string): Map<string, ModelScore> | undefined {
      return scores.get(cellKey(taskType, complexity));
    },

    /** Used by persistence to hydrate rows without going through `set` for each. */
    ensureCell(taskType: string, complexity: string): Map<string, ModelScore> {
      return ensureCell(cellKey(taskType, complexity));
    },

    getCellScores(taskType: string, complexity: string): ModelScore[] {
      const cell = scores.get(cellKey(taskType, complexity));
      return cell ? Array.from(cell.values()) : [];
    },

    getAllScores(): { taskType: string; complexity: string; scores: ModelScore[] }[] {
      const result: { taskType: string; complexity: string; scores: ModelScore[] }[] = [];
      for (const [ck, cell] of scores) {
        const [taskType, complexity] = ck.split(":");
        result.push({ taskType, complexity, scores: Array.from(cell.values()) });
      }
      return result;
    },
  };
}

export type ScoreStore = ReturnType<typeof createScoreStore>;
