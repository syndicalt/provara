import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "@provara/db";
import { modelScores } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import { createAdaptiveRouter } from "../src/routing/adaptive/router.js";
import { POOL_KEY } from "../src/routing/adaptive/score-store.js";
import {
  EXPLORATION_RATE,
  LOW_SCORE_EXPLORATION_RATE,
} from "../src/routing/adaptive/exploration.js";
import { LOW_SCORE_THRESHOLD } from "../src/routing/adaptive/challenger.js";

const MIN_SAMPLES = parseInt(process.env.PROVARA_MIN_SAMPLES || "5", 10);

const candidates = [
  { provider: "openai", model: "gpt-4o" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  { provider: "google", model: "gemini-2.0-flash" },
];
const allProviders = new Set(candidates.map((c) => c.provider));

async function seedPool(
  db: Db,
  taskType: string,
  complexity: string,
  provider: string,
  model: string,
  qualityScore: number,
  sampleCount = MIN_SAMPLES,
) {
  await db
    .insert(modelScores)
    .values({
      tenantId: POOL_KEY,
      taskType,
      complexity,
      provider,
      model,
      qualityScore,
      sampleCount,
      updatedAt: new Date(),
    })
    .run();
}

describe("adaptive router low-score exploration boost (Track 2)", () => {
  beforeEach(() => {
    resetTierEnv();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTierEnv();
  });

  it("free-tier tenants do NOT get the boosted rate on a low-scoring cell", async () => {
    const db = await makeTestDb();
    // Low-scoring incumbent on the pool — well below LOW_SCORE_THRESHOLD.
    await seedPool(db, "summarization", "simple", "openai", "gpt-4o", 1.5);
    const router = await createAdaptiveRouter(db);

    // Stub random to a value strictly between the base and boosted
    // rates: 0.10 < r < 0.50. The base rate path returns null (no
    // exploration), the boosted path returns a candidate. Free tier
    // must take the base path.
    vi.spyOn(Math, "random").mockReturnValue(0.25);

    const result = await router.getBestModel(
      "summarization",
      "simple",
      "balanced",
      allProviders,
      candidates,
      undefined,
      null, // anonymous → FREE_POLICY
    );
    // No exploration → adaptive picks the lone scored model.
    expect(result?.via).toBe("adaptive");
    expect(result?.target.model).toBe("gpt-4o");
  });

  it("Pro tenants DO get the boosted rate on a low-scoring cell", async () => {
    const db = await makeTestDb();
    await seedPool(db, "summarization", "simple", "openai", "gpt-4o", 1.5);
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro" });
    const router = await createAdaptiveRouter(db);

    // Same r=0.25 between base and boosted → only Pro should explore.
    vi.spyOn(Math, "random").mockReturnValue(0.25);

    const result = await router.getBestModel(
      "summarization",
      "simple",
      "balanced",
      allProviders,
      candidates,
      undefined,
      "tenant-pro",
    );
    expect(result?.via).toBe("exploration");
  });

  it("healthy cells stay on the base rate even for Pro tenants", async () => {
    const db = await makeTestDb();
    // Top score above the threshold → not "low-scoring."
    await seedPool(db, "qa", "simple", "openai", "gpt-4o", 4.5);
    await grantIntelligenceAccess(db, "tenant-pro2", { tier: "pro" });
    const router = await createAdaptiveRouter(db);

    vi.spyOn(Math, "random").mockReturnValue(0.25);

    const result = await router.getBestModel(
      "qa",
      "simple",
      "balanced",
      allProviders,
      candidates,
      undefined,
      "tenant-pro2",
    );
    // r=0.25 > base 0.10 → no exploration; adaptive picks the incumbent.
    expect(result?.via).toBe("adaptive");
    expect(result?.target.model).toBe("gpt-4o");
  });

  it("invariant: rate ordering is the precondition this whole feature relies on", () => {
    expect(LOW_SCORE_EXPLORATION_RATE).toBeGreaterThan(EXPLORATION_RATE);
    expect(LOW_SCORE_THRESHOLD).toBeGreaterThan(1);
    expect(LOW_SCORE_THRESHOLD).toBeLessThan(5);
  });

  it("cold cells (everyone below MIN_SAMPLES) are not flagged low-score", async () => {
    const db = await makeTestDb();
    // 1.0 score but only 1 sample → not eligible for low-score detection.
    await seedPool(db, "creative", "simple", "openai", "gpt-4o", 1.0, 1);
    await grantIntelligenceAccess(db, "tenant-cold", { tier: "pro" });
    const router = await createAdaptiveRouter(db);

    // Random in the boosted-only window — if we incorrectly flagged
    // this as low-score, exploration would fire.
    vi.spyOn(Math, "random").mockReturnValue(0.25);

    const result = await router.getBestModel(
      "creative",
      "simple",
      "balanced",
      allProviders,
      candidates,
      undefined,
      "tenant-cold",
    );
    // r=0.25 > base 0.10 → no exploration; cell has no eligible
    // candidate so adaptive returns null too. Caller falls through
    // to cheapest-first.
    expect(result).toBeNull();
  });
});
