import { Hono } from "hono";
import type { Db } from "@provara/db";
import type { ProviderRegistry } from "../providers/index.js";
import { getTenantId } from "../auth/tenant.js";
import { getPricing } from "../cost/pricing.js";
import {
  findLowScoringCells,
  getScoredModelsForCell,
  pickChallenger,
  spawnChallengerTest,
} from "../routing/adaptive/challenger.js";

/**
 * Admin routes for the adaptive routing matrix's intelligence-tier-
 * adjacent surface — the manual "Spawn challenger" probe (Track 3 of the
 * lonely-low-cell initiative). These are *free-tier* endpoints: the
 * detection heuristic and challenger picker run server-side regardless
 * of subscription so every operator can see the matrix gap and act on
 * it. The Pro+ tier-gate lives one layer down in the router's
 * exploration logic (Track 2).
 */
export function createAdaptiveAdminRoutes(
  db: Db,
  getRegistry: () => ProviderRegistry,
): Hono {
  const app = new Hono();

  app.get("/low-score-cells", async (c) => {
    const cells = await findLowScoringCells(db);
    return c.json({ cells });
  });

  app.post("/spawn-challenger", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    let body: { taskType?: string; complexity?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { message: "Invalid JSON body", type: "validation_error" } },
        400,
      );
    }

    const taskType = body.taskType?.trim();
    const complexity = body.complexity?.trim();
    if (!taskType || !complexity) {
      return c.json(
        {
          error: {
            message: "taskType and complexity are required",
            type: "validation_error",
          },
        },
        400,
      );
    }

    // Re-derive incumbent from the live data so the client can't lie
    // about which model is the underperformer. Also confirms the cell
    // is *actually* low-scoring at request time — an ephemeral state
    // that may have changed since the dashboard last fetched.
    const lowCells = await findLowScoringCells(db);
    const target = lowCells.find(
      (c) => c.taskType === taskType && c.complexity === complexity,
    );
    if (!target) {
      return c.json(
        {
          error: {
            message:
              "Cell is no longer flagged as low-scoring — refresh the dashboard.",
            type: "stale_state",
          },
        },
        409,
      );
    }

    // Build the candidate pool from registered providers, cheapest
    // first. `pickChallenger` consumes the order to break ties on cost.
    const registry = getRegistry();
    const ranked: { provider: string; model: string; cost: number }[] = [];
    for (const provider of registry.list()) {
      for (const model of provider.models) {
        const pricing = getPricing(model);
        const cost = pricing ? pricing[0] + pricing[1] : 999;
        ranked.push({ provider: provider.name, model, cost });
      }
    }
    ranked.sort((a, b) => a.cost - b.cost);
    const candidates = ranked.map(({ provider, model }) => ({ provider, model }));

    const availableProviders = new Set(registry.list().map((p) => p.name));
    const scoredModels = await getScoredModelsForCell(db, taskType, complexity);

    const challenger = pickChallenger({
      taskType,
      complexity,
      incumbent: { provider: target.incumbent.provider, model: target.incumbent.model },
      candidates,
      availableProviders,
      scoredModels,
    });
    if (!challenger) {
      return c.json(
        {
          error: {
            message:
              "No eligible challenger available — every registered model is either the incumbent, already scored in this cell, or lacks the cell's required capability.",
            type: "no_challenger",
          },
        },
        409,
      );
    }

    const test = await spawnChallengerTest(db, {
      taskType,
      complexity,
      incumbent: { provider: target.incumbent.provider, model: target.incumbent.model },
      challenger,
      tenantId,
    });
    return c.json({ test }, 201);
  });

  return app;
}
