import { Hono } from "hono";
import type { Db } from "@provara/db";
import { requests, costLogs, feedback } from "@provara/db";
import { sql, eq, and } from "drizzle-orm";
import { getPricing } from "../cost/pricing.js";
import type { ProviderRegistry } from "../providers/index.js";
import { modelSupportsTools } from "../providers/capabilities.js";

interface ModelStatsContext {
  db: Db;
  registry: ProviderRegistry;
}

export function createModelRoutes(ctx: ModelStatsContext) {
  const app = new Hono();

  // List all models with stats and pricing
  app.get("/stats", async (c) => {
    // Get all registered models from providers
    const registeredModels: { provider: string; model: string }[] = [];
    for (const provider of ctx.registry.list()) {
      for (const model of provider.models) {
        registeredModels.push({ provider: provider.name, model });
      }
    }

    // Get aggregated stats from requests
    const statsRows = await ctx.db
      .select({
        provider: requests.provider,
        model: requests.model,
        requestCount: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
        avgInputTokens: sql<number>`avg(${requests.inputTokens})`,
        avgOutputTokens: sql<number>`avg(${requests.outputTokens})`,
      })
      .from(requests)
      .groupBy(requests.provider, requests.model)
      .all();

    // Get cost data
    const costRows = await ctx.db
      .select({
        model: costLogs.model,
        totalCost: sql<number>`sum(${costLogs.cost})`,
      })
      .from(costLogs)
      .groupBy(costLogs.model)
      .all();

    // Get quality scores
    const qualityRows = await ctx.db
      .select({
        provider: requests.provider,
        model: requests.model,
        avgScore: sql<number>`avg(${feedback.score})`,
        feedbackCount: sql<number>`count(${feedback.id})`,
      })
      .from(feedback)
      .innerJoin(requests, eq(feedback.requestId, requests.id))
      .groupBy(requests.provider, requests.model)
      .all();

    // Build lookup maps
    const statsMap = new Map(statsRows.map((r) => [`${r.provider}/${r.model}`, r]));
    const costMap = new Map(costRows.map((r) => [r.model, r]));
    const qualityMap = new Map(qualityRows.map((r) => [`${r.provider}/${r.model}`, r]));

    // Merge everything
    const models = registeredModels.map(({ provider, model }) => {
      const key = `${provider}/${model}`;
      const stats = statsMap.get(key);
      const cost = costMap.get(model);
      const quality = qualityMap.get(key);
      const pricing = getPricing(model);

      return {
        provider,
        model,
        pricing: pricing
          ? { inputPer1M: pricing[0], outputPer1M: pricing[1] }
          : null,
        capabilities: {
          supportsTools: modelSupportsTools(provider, model),
        },
        stats: stats
          ? {
              requestCount: stats.requestCount,
              avgLatency: Math.round(stats.avgLatency || 0),
              avgInputTokens: Math.round(stats.avgInputTokens || 0),
              avgOutputTokens: Math.round(stats.avgOutputTokens || 0),
            }
          : { requestCount: 0, avgLatency: 0, avgInputTokens: 0, avgOutputTokens: 0 },
        totalCost: cost?.totalCost || 0,
        quality: quality
          ? { avgScore: quality.avgScore, feedbackCount: quality.feedbackCount }
          : null,
      };
    });

    return c.json({ models });
  });

  // Full pricing table
  app.get("/pricing", (c) => {
    const registeredModels: { provider: string; model: string; inputPer1M: number; outputPer1M: number }[] = [];
    for (const provider of ctx.registry.list()) {
      for (const model of provider.models) {
        const pricing = getPricing(model);
        registeredModels.push({
          provider: provider.name,
          model,
          inputPer1M: pricing ? pricing[0] : 0,
          outputPer1M: pricing ? pricing[1] : 0,
        });
      }
    }
    return c.json({ models: registeredModels });
  });

  return app;
}
