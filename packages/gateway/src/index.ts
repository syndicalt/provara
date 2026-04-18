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
import { isCloudDeployment } from "./config.js";
import { runUsageReportCycle } from "./billing/usage.js";
import { getStripe } from "./stripe/index.js";

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

// Intelligence-tier scheduler jobs only register on Cloud deployments (#168).
// Self-host installs load the scheduler primitive for future/core jobs but
// don't fire the paid-tier cycles. Cloud deployments register all three +
// cost-migration below.
const cloudDeployment = isCloudDeployment();

const AUTO_AB_INTERVAL_MS = parseInt(
  process.env.PROVARA_AUTO_AB_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
if (cloudDeployment) {
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
}

const BANK_POPULATE_INTERVAL_MS = parseInt(
  process.env.PROVARA_REPLAY_BANK_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
const REPLAY_CYCLE_INTERVAL_MS = parseInt(
  process.env.PROVARA_REPLAY_CYCLE_INTERVAL_MS || `${7 * 24 * 60 * 60 * 1000}`,
  10,
);
if (cloudDeployment) {
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
}
const app = await createRouter({ registry, db, dbKeys, scheduler });

// Replay cycle registered after the router because it needs access to the
// adaptive EMA writer (#163): replay judge scores feed back into
// `model_scores`, and if a regression fires we refresh the regression-cell
// table so the next routing decision boosts exploration on that cell.
if (cloudDeployment) {
  await scheduler.schedule({
    name: "replay-execute",
    intervalMs: REPLAY_CYCLE_INTERVAL_MS,
    initialDelayMs: 120_000,
    handler: async () => {
      const config = getJudgeConfig();
      const target = config.provider && config.model
        ? { provider: config.provider, model: config.model }
        : null;
      const stats = await runReplayCycle(db, registry, target, app.routingEngine.adaptive);
      if (stats.regressionsDetected > 0) {
        await app.routingEngine.regressionCellTable.refresh();
      }
      if (stats.replaysExecuted > 0 || stats.regressionsDetected > 0) {
        console.log(
          `[regression] replay cycle: evaluated=${stats.cellsEvaluated} replays=${stats.replaysExecuted} regressions=${stats.regressionsDetected} cost=$${stats.totalCostUsd.toFixed(4)}`,
        );
      }
    },
  });
}

const COST_MIGRATION_INTERVAL_MS = parseInt(
  process.env.PROVARA_COST_MIGRATION_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
if (cloudDeployment) {
  await scheduler.schedule({
    name: "cost-migration",
    intervalMs: COST_MIGRATION_INTERVAL_MS,
    initialDelayMs: 90_000,
    handler: async () => {
      // runCostMigrationCycle logs one line per scope (pool + each tenant)
      // with non-zero execution — see migrations.ts. Scheduler-level log
      // only fires for the "evaluated candidates but all skipped" case so
      // quiet cycles stay genuinely quiet.
      const stats = await runCostMigrationCycle(db);
      if (stats.executed.length > 0) {
        // Refresh the boost table so the router picks up the new migration
        // without a restart — boost applies on the very next routing decision.
        await app.routingEngine.boostTable.refresh();
      } else if (stats.evaluated > 0) {
        console.log(`[cost-migration] evaluated ${stats.evaluated} candidate(s), none executed (cooldown or caps)`);
      }
    },
  });
}

// Usage report cycle (#170). Daily sweep that computes overage per
// Pro/Team subscription and pushes Stripe meter events for the delta.
// Idempotent — safe to retry, guarded by high-water marks in the
// usage_reports table.
const USAGE_REPORT_INTERVAL_MS = parseInt(
  process.env.PROVARA_USAGE_REPORT_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
if (cloudDeployment) {
  await scheduler.schedule({
    name: "usage-report",
    intervalMs: USAGE_REPORT_INTERVAL_MS,
    initialDelayMs: 150_000,
    handler: async () => {
      const stripe = getStripe();
      if (!stripe) {
        console.warn("[usage] scheduler tick skipped — Stripe SDK not configured");
        return;
      }
      const stats = await runUsageReportCycle(db, stripe);
      if (stats.reportsWritten > 0 || stats.errors > 0) {
        console.log(
          `[usage] cycle complete: evaluated=${stats.subscriptionsEvaluated} reports=${stats.reportsWritten} delta=${stats.deltaRequestsReported} errors=${stats.errors}`,
        );
      }
    },
  });
}

// Audit-log retention purge (#210). Deletes rows older than the per-
// tier retention window (90d Free/Pro, 365d Team, 730d Enterprise).
// Daily by default; overridable via env for testing.
const AUDIT_RETENTION_INTERVAL_MS = parseInt(
  process.env.PROVARA_AUDIT_RETENTION_INTERVAL_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
await scheduler.schedule({
  name: "audit-retention",
  intervalMs: AUDIT_RETENTION_INTERVAL_MS,
  initialDelayMs: 180_000,
  handler: async () => {
    const { runAuditRetentionCycle } = await import("./scheduler/audit-retention.js");
    const stats = await runAuditRetentionCycle(db);
    if (stats.rowsDeleted > 0) {
      console.log(
        `[audit-retention] cycle complete: tenants=${stats.tenantsScanned} affected=${stats.tenantsDeleted} deleted=${stats.rowsDeleted}`,
      );
    }
  },
});

// Spend-budget alerts (#219/T7). Daily sweep that fires threshold
// emails for tenants whose current-period spend has crossed a new
// alert threshold.
const { registerBudgetAlertsJob } = await import("./scheduler/budget-alerts.js");
registerBudgetAlertsJob(scheduler, db);

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
