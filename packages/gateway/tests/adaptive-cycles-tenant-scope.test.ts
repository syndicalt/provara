import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { modelScores, costMigrations, requests } from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import {
  MIGRATION_MIN_SAMPLES,
  findMigrationCandidates,
  runCostMigrationCycle,
  setCostMigrationOptIn,
} from "../src/routing/adaptive/migrations.js";
import { POOL_KEY } from "../src/routing/adaptive/score-store.js";
import { listTenantsWithAdaptiveIsolation } from "../src/routing/adaptive/isolation-policy.js";

async function seedScopedScore(
  db: Db,
  scope: string,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  qualityScore: number,
  sampleCount = MIGRATION_MIN_SAMPLES,
) {
  await db.insert(modelScores).values({
    tenantId: scope,
    taskType,
    complexity,
    provider,
    model,
    qualityScore,
    sampleCount,
    updatedAt: new Date(),
  }).run();
}

async function seedRequests(db: Db, params: { provider: string; model: string; taskType: string; complexity: string; count: number }) {
  for (let i = 0; i < params.count; i++) {
    await db.insert(requests).values({
      id: `r-${params.provider}-${params.model}-${i}-${Math.random()}`,
      provider: params.provider,
      model: params.model,
      prompt: "test",
      taskType: params.taskType,
      complexity: params.complexity,
      inputTokens: 1000,
      outputTokens: 500,
      createdAt: new Date(),
    }).run();
  }
}

describe("adaptive cycle tenant scoping — C3", () => {
  afterEach(() => resetTierEnv());

  describe("findMigrationCandidates scoping", () => {
    let db: Db;
    beforeEach(async () => {
      db = await makeTestDb();
    });

    it("defaults to the pool scope (empty string tenantId)", async () => {
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "medium", count: 10 });

      const candidates = await findMigrationCandidates(db);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].from.provider).toBe("openai");
    });

    it("scopes to a single tenant and ignores pool rows + other tenants", async () => {
      // Pool rows — should NOT show up in tenant-a candidates.
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o-mini", 4.4);

      // Tenant-a rows — one cell with a migration candidate.
      await seedScopedScore(db, "tenant-a", "writing", "complex", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, "tenant-a", "writing", "complex", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "writing", complexity: "complex", count: 10 });

      // Tenant-b has nothing.
      const poolCands = await findMigrationCandidates(db, POOL_KEY);
      const tenantACands = await findMigrationCandidates(db, "tenant-a");
      const tenantBCands = await findMigrationCandidates(db, "tenant-b");

      expect(poolCands).toHaveLength(1);
      expect(poolCands[0].taskType).toBe("coding");
      expect(tenantACands).toHaveLength(1);
      expect(tenantACands[0].taskType).toBe("writing");
      expect(tenantBCands).toEqual([]);
    });
  });

  describe("listTenantsWithAdaptiveIsolation", () => {
    it("returns empty off-cloud regardless of subscriptions", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      delete process.env.PROVARA_CLOUD; // off-cloud
      const tenants = await listTenantsWithAdaptiveIsolation(db);
      expect(tenants).toEqual([]);
    });

    it("returns only Team + Enterprise active tenants", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await grantIntelligenceAccess(db, "t-ent", { tier: "enterprise" });
      await grantIntelligenceAccess(db, "t-pro", { tier: "pro" });
      process.env.PROVARA_CLOUD = "true";

      const tenants = await listTenantsWithAdaptiveIsolation(db);
      expect(tenants.sort()).toEqual(["t-ent", "t-team"]);
    });

    it("excludes canceled Team tenants", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team", status: "active" });
      await grantIntelligenceAccess(db, "t-canceled", { tier: "team" });
      process.env.PROVARA_CLOUD = "true";

      // Flip t-canceled to canceled status.
      const { subscriptions } = await import("@provara/db");
      await db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.tenantId, "t-canceled")).run();

      const tenants = await listTenantsWithAdaptiveIsolation(db);
      expect(tenants).toEqual(["t-team"]);
    });
  });

  describe("runCostMigrationCycle — pool + per-tenant", () => {
    it("pool cycle fires when only pool rows exist", async () => {
      const db = await makeTestDb();
      process.env.PROVARA_CLOUD = "true";
      await setCostMigrationOptIn(db, null, true);

      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "medium", count: 10 });

      const stats = await runCostMigrationCycle(db);
      expect(stats.executed).toHaveLength(1);

      const row = await db.select().from(costMigrations).get();
      expect(row?.tenantId).toBeNull();
    });

    it("per-tenant cycle fires for a Team tenant with tenant-scoped rows", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await setCostMigrationOptIn(db, "t-team", true);

      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "writing", complexity: "complex", count: 10 });

      const stats = await runCostMigrationCycle(db);
      expect(stats.executed).toHaveLength(1);

      const rows = await db.select().from(costMigrations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe("t-team");
    });

    it("pool + tenant cycles run independently with distinct migration rows", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await setCostMigrationOptIn(db, null, true);
      await setCostMigrationOptIn(db, "t-team", true);

      // Pool migration candidate
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "medium", count: 10 });

      // Tenant migration candidate (different cell to avoid cooldown interference)
      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "writing", complexity: "complex", count: 10 });

      const stats = await runCostMigrationCycle(db);
      expect(stats.executed).toHaveLength(2);

      const rows = await db.select().from(costMigrations).all();
      const scopes = rows.map((r) => r.tenantId).sort();
      expect(scopes).toEqual([null, "t-team"]);
    });

    it("tenant opt-in OFF → no tenant migration fires even if pool fires", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await setCostMigrationOptIn(db, null, true);
      // t-team opt-in NOT set

      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "medium", count: 10 });

      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "writing", complexity: "complex", count: 10 });

      const stats = await runCostMigrationCycle(db);
      expect(stats.executed).toHaveLength(1);
      expect(stats.executed[0].taskType).toBe("coding"); // pool only

      const rows = await db.select().from(costMigrations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBeNull();
    });

    it("pool opt-in OFF → pool cycle skipped even when tenant cycle fires", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      // pool opt-in NOT set
      await setCostMigrationOptIn(db, "t-team", true);

      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, POOL_KEY, "coding", "medium", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "coding", complexity: "medium", count: 10 });

      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o", 4.5);
      await seedScopedScore(db, "t-team", "writing", "complex", "openai", "gpt-4o-mini", 4.4);
      await seedRequests(db, { provider: "openai", model: "gpt-4o", taskType: "writing", complexity: "complex", count: 10 });

      const stats = await runCostMigrationCycle(db);
      expect(stats.executed).toHaveLength(1);
      expect(stats.executed[0].taskType).toBe("writing"); // tenant only

      const rows = await db.select().from(costMigrations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe("t-team");
    });
  });
});
