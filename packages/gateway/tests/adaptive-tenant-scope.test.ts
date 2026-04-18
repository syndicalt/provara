import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { modelScores } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import { createScoreStore, POOL_KEY } from "../src/routing/adaptive/score-store.js";
import { loadScoresFromDb, persistScore } from "../src/routing/adaptive/persistence.js";
import { createAdaptiveRouter } from "../src/routing/adaptive/router.js";

/**
 * Foundation tests for #194 (C1 of #176). Verifies that the model_scores
 * tenant-scoping plumbing round-trips correctly *without* changing pool-only
 * behavior. Behavior change happens in C2 (#195).
 */
describe("adaptive tenant scope — C1 foundation", () => {
  describe("persistScore", () => {
    it("writes to the pool row when tenantId is omitted", async () => {
      const db = await makeTestDb();
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.8, 3);
      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(POOL_KEY);
      expect(rows[0].qualityScore).toBeCloseTo(0.8);
      expect(rows[0].sampleCount).toBe(3);
    });

    it("ON CONFLICT updates the pool row in place (not duplicates)", async () => {
      const db = await makeTestDb();
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.5, 1);
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.9, 2);
      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].qualityScore).toBeCloseTo(0.9);
      expect(rows[0].sampleCount).toBe(2);
    });

    it("writes tenant-scoped rows that coexist with the pool row", async () => {
      const db = await makeTestDb();
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.5, 1);
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.9, 2, "tenant-a");
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.3, 1, "tenant-b");

      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(3);

      const pool = rows.find((r) => r.tenantId === POOL_KEY);
      const a = rows.find((r) => r.tenantId === "tenant-a");
      const b = rows.find((r) => r.tenantId === "tenant-b");
      expect(pool?.qualityScore).toBeCloseTo(0.5);
      expect(a?.qualityScore).toBeCloseTo(0.9);
      expect(b?.qualityScore).toBeCloseTo(0.3);
    });

    it("ON CONFLICT within a tenant updates that tenant's row only", async () => {
      const db = await makeTestDb();
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.5, 1, "tenant-a");
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.7, 5, "tenant-a");

      const tenantRow = await db
        .select()
        .from(modelScores)
        .where(
          and(
            eq(modelScores.tenantId, "tenant-a"),
            eq(modelScores.provider, "openai"),
            eq(modelScores.model, "gpt-4"),
          ),
        )
        .get();
      expect(tenantRow?.qualityScore).toBeCloseTo(0.7);
      expect(tenantRow?.sampleCount).toBe(5);

      const total = await db.select().from(modelScores).all();
      expect(total).toHaveLength(1);
    });
  });

  describe("ScoreStore", () => {
    it("default-arg get/set operates on the pool dimension", () => {
      const store = createScoreStore();
      store.set("coding", "medium", {
        provider: "openai",
        model: "gpt-4",
        qualityScore: 0.8,
        sampleCount: 3,
        costPer1M: 0,
        avgLatencyMs: 0,
      });
      expect(store.get("coding", "medium", "openai", "gpt-4")?.qualityScore).toBeCloseTo(0.8);
    });

    it("tenant-scoped writes do not bleed across tenants or into the pool", () => {
      const store = createScoreStore();
      store.set(
        "coding",
        "medium",
        {
          provider: "openai",
          model: "gpt-4",
          qualityScore: 0.9,
          sampleCount: 1,
          costPer1M: 0,
          avgLatencyMs: 0,
        },
        "tenant-a",
      );

      expect(store.get("coding", "medium", "openai", "gpt-4", "tenant-a")?.qualityScore).toBeCloseTo(0.9);
      expect(store.get("coding", "medium", "openai", "gpt-4", "tenant-b")).toBeUndefined();
      expect(store.get("coding", "medium", "openai", "gpt-4")).toBeUndefined();
    });

    it("getAllScores is tenant-scoped", () => {
      const store = createScoreStore();
      const mk = (q: number) => ({
        provider: "openai",
        model: "gpt-4",
        qualityScore: q,
        sampleCount: 1,
        costPer1M: 0,
        avgLatencyMs: 0,
      });
      store.set("coding", "medium", mk(0.5));
      store.set("coding", "medium", mk(0.9), "tenant-a");

      expect(store.getAllScores()[0].scores[0].qualityScore).toBeCloseTo(0.5);
      expect(store.getAllScores("tenant-a")[0].scores[0].qualityScore).toBeCloseTo(0.9);
      expect(store.getAllScores("tenant-b")).toEqual([]);
    });
  });

  describe("loadScoresFromDb", () => {
    it("hydrates pool rows and tenant rows into separate store dimensions", async () => {
      const db = await makeTestDb();
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.5, 1);
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.8, 3, "tenant-a");
      await persistScore(db, "coding", "medium", "openai", "gpt-4", 0.3, 2, "tenant-b");

      const store = createScoreStore();
      await loadScoresFromDb(db, store);

      expect(store.get("coding", "medium", "openai", "gpt-4")?.qualityScore).toBeCloseTo(0.5);
      expect(store.get("coding", "medium", "openai", "gpt-4", "tenant-a")?.qualityScore).toBeCloseTo(0.8);
      expect(store.get("coding", "medium", "openai", "gpt-4", "tenant-b")?.qualityScore).toBeCloseTo(0.3);
    });
  });

  describe("router.updateScore — tier-dispatched writes (C2)", () => {
    afterEach(() => resetTierEnv());

    it("default-arg (no tenantId) updates the pool row only", async () => {
      const db = await makeTestDb();
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user");

      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(POOL_KEY);
    });

    it("Team tenant with default toggles writes tenant row only (no pool bleed)", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "tenant-a", { tier: "team" });
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.5, "user");
      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user", "tenant-a");

      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(2);

      const pool = rows.find((r) => r.tenantId === POOL_KEY);
      const tenant = rows.find((r) => r.tenantId === "tenant-a");
      expect(pool?.qualityScore).toBeCloseTo(0.5);
      expect(tenant?.qualityScore).toBeCloseTo(0.9);
    });

    it("Team tenant-a's ratings do not influence tenant-b or the pool", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "tenant-a", { tier: "team" });
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user", "tenant-a");

      expect(router.getCellScores("coding", "medium", "tenant-b")).toEqual([]);
      expect(router.getCellScores("coding", "medium")).toEqual([]);
      expect(router.getCellScores("coding", "medium", "tenant-a")).toHaveLength(1);
    });

    it("Free tenant writes to the pool even when tenantId is passed", async () => {
      const db = await makeTestDb();
      // No subscription → Free tier → always pools.
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.7, "user", "tenant-free");

      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(POOL_KEY);
    });
  });
});
