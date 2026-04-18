import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { modelScores, adaptiveIsolationPreferencesLog } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import { POOL_KEY } from "../src/routing/adaptive/score-store.js";
import { getTenantIsolationPolicy } from "../src/routing/adaptive/isolation-policy.js";
import { updateIsolationPreferences, getIsolationPreferences } from "../src/routing/adaptive/isolation-preferences.js";
import { createAdaptiveRouter } from "../src/routing/adaptive/router.js";
import type { RoutingProfile } from "../src/routing/adaptive/types.js";

/**
 * C2 (#195) — tier-aware adaptive routing tests. Verifies the four-
 * dimensional isolation policy (tenant reads/writes × pool reads/writes)
 * across the Free/Pro/Team/Enterprise tiers and the opt-in toggles.
 */
describe("adaptive isolation policy — C2", () => {
  afterEach(() => resetTierEnv());

  describe("getTenantIsolationPolicy", () => {
    it("returns Free-equivalent policy for self-host (no PROVARA_CLOUD)", async () => {
      const db = await makeTestDb();
      const policy = await getTenantIsolationPolicy(db, "any-tenant");
      expect(policy.tier).toBe("free");
      expect(policy).toMatchObject({
        writesTenantRow: false,
        writesPool: true,
        readsTenantRow: false,
        readsPool: true,
      });
    });

    it("returns Free policy for unauthenticated caller on Cloud", async () => {
      const db = await makeTestDb();
      process.env.PROVARA_CLOUD = "true";
      const policy = await getTenantIsolationPolicy(db, null);
      expect(policy.tier).toBe("free");
      expect(policy.writesTenantRow).toBe(false);
      expect(policy.readsPool).toBe(true);
    });

    it("returns Free policy for an unsubscribed tenant on Cloud", async () => {
      const db = await makeTestDb();
      process.env.PROVARA_CLOUD = "true";
      const policy = await getTenantIsolationPolicy(db, "no-sub");
      expect(policy.tier).toBe("free");
      expect(policy.writesTenantRow).toBe(false);
    });

    it("returns Pro policy for a Pro subscriber", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-pro", { tier: "pro" });
      const policy = await getTenantIsolationPolicy(db, "t-pro");
      expect(policy.tier).toBe("pro");
      expect(policy.writesTenantRow).toBe(false);
      expect(policy.writesPool).toBe(true);
      expect(policy.readsPool).toBe(true);
    });

    it("returns isolated Team policy by default (both toggles off)", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      const policy = await getTenantIsolationPolicy(db, "t-team");
      expect(policy.tier).toBe("team");
      expect(policy).toMatchObject({
        writesTenantRow: true,
        writesPool: false,
        readsTenantRow: true,
        readsPool: false,
      });
    });

    it("returns isolated Enterprise policy by default", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-ent", { tier: "enterprise" });
      const policy = await getTenantIsolationPolicy(db, "t-ent");
      expect(policy.tier).toBe("enterprise");
      expect(policy.writesPool).toBe(false);
      expect(policy.readsPool).toBe(false);
    });

    it("flips readsPool when a Team tenant opts in to consume the pool", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { consumesPool: true }, "u-admin");
      const policy = await getTenantIsolationPolicy(db, "t-team");
      expect(policy.readsPool).toBe(true);
      expect(policy.readsTenantRow).toBe(true); // tenant row still consulted first
      expect(policy.writesPool).toBe(false);
    });

    it("flips writesPool when a Team tenant opts in to contribute", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { contributesPool: true }, "u-admin");
      const policy = await getTenantIsolationPolicy(db, "t-team");
      expect(policy.writesPool).toBe(true);
      expect(policy.writesTenantRow).toBe(true); // tenant row still written
      expect(policy.readsPool).toBe(false);
    });
  });

  describe("updateIsolationPreferences", () => {
    it("rejects toggle changes for Free tenants", async () => {
      const db = await makeTestDb();
      process.env.PROVARA_CLOUD = "true";
      await expect(
        updateIsolationPreferences(db, "t-free", { consumesPool: true }, "u-admin"),
      ).rejects.toThrow(/cannot modify isolation preferences/);
    });

    it("rejects toggle changes for Pro tenants", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-pro", { tier: "pro" });
      await expect(
        updateIsolationPreferences(db, "t-pro", { consumesPool: true }, "u-admin"),
      ).rejects.toThrow(/cannot modify isolation preferences/);
    });

    it("logs an audit entry on first flip", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { contributesPool: true }, "u-owner");

      const logs = await db
        .select()
        .from(adaptiveIsolationPreferencesLog)
        .where(eq(adaptiveIsolationPreferencesLog.tenantId, "t-team"))
        .all();
      expect(logs).toHaveLength(1);
      expect(logs[0].field).toBe("contributes_pool");
      expect(logs[0].oldValue).toBe(false);
      expect(logs[0].newValue).toBe(true);
      expect(logs[0].changedBy).toBe("u-owner");
    });

    it("is idempotent — no log entry when the value doesn't change", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { consumesPool: true }, "u-owner");
      await updateIsolationPreferences(db, "t-team", { consumesPool: true }, "u-owner");

      const logs = await db
        .select()
        .from(adaptiveIsolationPreferencesLog)
        .where(eq(adaptiveIsolationPreferencesLog.tenantId, "t-team"))
        .all();
      expect(logs).toHaveLength(1);
    });

    it("logs each changed field independently", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(
        db,
        "t-team",
        { consumesPool: true, contributesPool: true },
        "u-owner",
      );

      const logs = await db
        .select()
        .from(adaptiveIsolationPreferencesLog)
        .where(eq(adaptiveIsolationPreferencesLog.tenantId, "t-team"))
        .orderBy(adaptiveIsolationPreferencesLog.field)
        .all();
      expect(logs).toHaveLength(2);
      expect(logs.map((l) => l.field).sort()).toEqual(["consumes_pool", "contributes_pool"]);
    });

    it("round-trips through getIsolationPreferences", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      expect(await getIsolationPreferences(db, "t-team")).toEqual({
        consumesPool: false,
        contributesPool: false,
      });
      await updateIsolationPreferences(db, "t-team", { consumesPool: true }, "u-owner");
      expect(await getIsolationPreferences(db, "t-team")).toEqual({
        consumesPool: true,
        contributesPool: false,
      });
    });
  });

  describe("router.updateScore — write dispatch by tier", () => {
    it("Team tenant with contributesPool ON writes both tenant row and pool", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { contributesPool: true }, "u-admin");
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.8, "user", "t-team");

      const rows = await db.select().from(modelScores).orderBy(modelScores.tenantId).all();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.tenantId === POOL_KEY)?.qualityScore).toBeCloseTo(0.8);
      expect(rows.find((r) => r.tenantId === "t-team")?.qualityScore).toBeCloseTo(0.8);
    });

    it("Enterprise tenant defaults: writes only tenant row, never pool", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-ent", { tier: "enterprise" });
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.7, "user", "t-ent");

      const rows = await db.select().from(modelScores).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe("t-ent");
    });

    it("opt-out after opt-in: future writes stop; past pool data remains", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { contributesPool: true }, "u-admin");
      const router = await createAdaptiveRouter(db);

      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user", "t-team");
      // Opt out
      await updateIsolationPreferences(db, "t-team", { contributesPool: false }, "u-admin");
      // Subsequent write should go only to tenant row
      await router.updateScore("coding", "medium", "openai", "gpt-4", 0.5, "user", "t-team");

      const pool = await db
        .select()
        .from(modelScores)
        .where(eq(modelScores.tenantId, POOL_KEY))
        .get();
      // Pool still holds the first contribution; opt-out does not rewind.
      expect(pool).toBeDefined();
      expect(pool!.sampleCount).toBe(1);
    });
  });

  describe("router.getBestModel — read fallback by tier", () => {
    const providers = new Set(["openai"]);
    const candidates = [{ provider: "openai", model: "gpt-4" }];

    it("Team tenant with empty matrix does NOT fall back to pool by default", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      const router = await createAdaptiveRouter(db);

      // Seed pool with strong scores, tenant matrix stays empty.
      for (let i = 0; i < 5; i++) {
        await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user");
      }

      const result = await router.getBestModel(
        "coding",
        "medium",
        "balanced" satisfies RoutingProfile,
        providers,
        candidates,
        undefined,
        "t-team",
      );
      // Isolated Team with no tenant row → returns null (caller falls back to cost-based).
      // Exploration MIGHT fire randomly — accept either null OR via=exploration; never adaptive.
      if (result) {
        expect(result.via).toBe("exploration");
      } else {
        expect(result).toBeNull();
      }
    });

    it("Team tenant opted in to pool reads does fall back to pool", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { consumesPool: true }, "u-admin");
      const router = await createAdaptiveRouter(db);

      for (let i = 0; i < 5; i++) {
        await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user");
      }

      // Disable exploration randomness by forcing many attempts; at least one
      // should come back adaptive (via pool fallback).
      let sawAdaptive = false;
      for (let i = 0; i < 50; i++) {
        const result = await router.getBestModel(
          "coding",
          "medium",
          "balanced" satisfies RoutingProfile,
          providers,
          candidates,
          undefined,
          "t-team",
        );
        if (result?.via === "adaptive") {
          sawAdaptive = true;
          expect(result.target.provider).toBe("openai");
          expect(result.target.model).toBe("gpt-4");
        }
      }
      expect(sawAdaptive).toBe(true);
    });

    it("read-through only: pool consumption never populates the tenant row", async () => {
      const db = await makeTestDb();
      await grantIntelligenceAccess(db, "t-team", { tier: "team" });
      await updateIsolationPreferences(db, "t-team", { consumesPool: true }, "u-admin");
      const router = await createAdaptiveRouter(db);

      // Pool has data, tenant matrix is empty.
      for (let i = 0; i < 5; i++) {
        await router.updateScore("coding", "medium", "openai", "gpt-4", 0.9, "user");
      }

      // Invoke the router repeatedly — no tenant row should appear.
      for (let i = 0; i < 20; i++) {
        await router.getBestModel(
          "coding",
          "medium",
          "balanced" satisfies RoutingProfile,
          providers,
          candidates,
          undefined,
          "t-team",
        );
      }

      expect(router.getCellScores("coding", "medium", "t-team")).toEqual([]);
    });
  });
});
