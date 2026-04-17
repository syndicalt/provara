import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@provara/db";
import { createProviderRegistry } from "./providers/index.js";
import { createRouter } from "./router.js";
import { getDecryptedKeys } from "./routes/api-keys.js";
import { loadCustomProviders } from "./providers/custom-loader.js";
import { hydrateJudgeConfig } from "./routing/judge.js";
import { hydrateRoutingConfig } from "./routing/config.js";
import { createScheduler } from "./scheduler/index.js";
import { runAutoAbCycle } from "./routing/adaptive/auto-ab.js";
import { runBankPopulationCycle, runReplayCycle } from "./routing/adaptive/regression.js";
import { runCostMigrationCycle } from "./routing/adaptive/migrations.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { getJudgeConfig } from "./routing/judge.js";

const port = parseInt(process.env.PORT || "4000", 10);

const db = createDb();
await runMigrations(db, resolve(process.cwd(), "packages/db/drizzle"));
await hydrateJudgeConfig(db);
await hydrateRoutingConfig(db);

const dbKeys = await getDecryptedKeys(db);
const registry = await createProviderRegistry({
  getKeys: () => dbKeys,
  getCustomProviders: () => loadCustomProviders(db),
});
const scheduler = createScheduler(db);
const AUTO_AB_INTERVAL_MS = parseInt(
  process.env.PROVARA_AUTO_AB_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
await scheduler.schedule({
  name: "auto-ab",
  intervalMs: AUTO_AB_INTERVAL_MS,
  initialDelayMs: 30_000,
  handler: async () => {
    const { created, resolved } = await runAutoAbCycle(db);
    if (created.length || resolved.length) {
      console.log(`[auto-ab] cycle complete: ${created.length} created, ${resolved.length} resolved`);
    }
  },
});

const BANK_POPULATE_INTERVAL_MS = parseInt(
  process.env.PROVARA_REPLAY_BANK_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
const REPLAY_CYCLE_INTERVAL_MS = parseInt(
  process.env.PROVARA_REPLAY_CYCLE_INTERVAL_MS || `${7 * 24 * 60 * 60 * 1000}`,
  10,
);
await scheduler.schedule({
  name: "replay-bank-populate",
  intervalMs: BANK_POPULATE_INTERVAL_MS,
  initialDelayMs: 60_000,
  handler: async () => {
    const embeddings = createEmbeddingProvider({ dbKeys });
    const results = await runBankPopulationCycle(db, embeddings);
    if (results.length > 0) {
      console.log(`[regression] bank populate: ${results.length} cell(s) updated`);
    }
  },
});
await scheduler.schedule({
  name: "replay-execute",
  intervalMs: REPLAY_CYCLE_INTERVAL_MS,
  initialDelayMs: 120_000,
  handler: async () => {
    const config = getJudgeConfig();
    const target = config.provider && config.model
      ? { provider: config.provider, model: config.model }
      : null;
    const stats = await runReplayCycle(db, registry, target);
    if (stats.replaysExecuted > 0 || stats.regressionsDetected > 0) {
      console.log(
        `[regression] replay cycle: evaluated=${stats.cellsEvaluated} replays=${stats.replaysExecuted} regressions=${stats.regressionsDetected} cost=$${stats.totalCostUsd.toFixed(4)}`,
      );
    }
  },
});
const app = await createRouter({ registry, db, dbKeys, scheduler });

const COST_MIGRATION_INTERVAL_MS = parseInt(
  process.env.PROVARA_COST_MIGRATION_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
await scheduler.schedule({
  name: "cost-migration",
  intervalMs: COST_MIGRATION_INTERVAL_MS,
  initialDelayMs: 90_000,
  handler: async () => {
    const stats = await runCostMigrationCycle(db);
    if (stats.executed.length > 0) {
      console.log(
        `[cost-migration] executed ${stats.executed.length} migration(s), projected $${stats.executed.reduce((s, m) => s + m.projectedMonthlySavingsUsd, 0).toFixed(2)}/mo saved`,
      );
      // Refresh the boost table so the router picks up the new migration
      // without a restart — boost applies on the very next routing decision.
      await app.routingEngine.boostTable.refresh();
    }
  },
});

scheduler.start();

// Discover available models from each provider's API at startup
registry.refreshModels().then((results) => {
  const discovered = results.filter((r) => r.discovered);
  if (discovered.length > 0) {
    console.log(`Discovered models from ${discovered.length} provider(s):`);
    for (const r of discovered) {
      console.log(`  ${r.provider}: ${r.models.length} models`);
    }
  }
}).catch((err) => {
  console.warn("Model discovery failed (using defaults):", err instanceof Error ? err.message : err);
});

console.log(`Provara gateway running on http://localhost:${port}`);
console.log(`Providers: ${registry.list().map((p) => p.name).join(", ")}`);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
