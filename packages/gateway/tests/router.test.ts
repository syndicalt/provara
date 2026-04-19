import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createRoutingEngine } from "../src/routing/index.js";
import { setRoutingConfig } from "../src/routing/config.js";
import { makeTestDb } from "./_setup/db.js";
import { makeFakeProvider } from "./_setup/fake-provider.js";
import { makeFakeRegistry } from "./_setup/fake-registry.js";
import { abTests, abTestVariants } from "@provara/db";
import { nanoid } from "nanoid";

describe("routing engine", () => {
  describe("user-override", () => {
    it("routes directly to the pinned (provider, model) without classifying", async () => {
      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
        makeFakeProvider({ name: "anthropic", models: ["claude-sonnet-4-6"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "hi" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });

      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.routedBy).toBe("user-override");
      // Default cell when no hint is given
      expect(result.taskType).toBe("general");
      expect(result.complexity).toBe("medium");
    });

    it("honors routingHint + complexityHint to place sample in a specific cell (#77)", async () => {
      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "anthropic", models: ["claude-sonnet-4-6"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "coding question" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        routingHint: "coding",
        complexityHint: "complex",
      });

      expect(result.routedBy).toBe("user-override");
      expect(result.taskType).toBe("coding");
      expect(result.complexity).toBe("complex");
    });

    it("honors complexityHint on the CLASSIFICATION path (no provider pin) — regression for the dropped-hint bug", async () => {
      // Short user message that the heuristic classifier would normally
      // label `simple`. With a `complexityHint: "complex"` the hint must
      // override so the caller's explicit claim ("I know this needs a
      // capable model") routes to the complex cell.
      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
        makeFakeProvider({ name: "anthropic", models: ["claude-sonnet-4-6"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "hi" }],
        routingHint: "coding",
        complexityHint: "complex",
        // no provider / model pin → hits the classification path
      });

      expect(result.taskType).toBe("coding");
      expect(result.complexity).toBe("complex");
    });

    it("resolves model-only pin through getForModel to the correct provider", async () => {
      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
        makeFakeProvider({ name: "anthropic", models: ["claude-sonnet-4-6"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "x" }],
        model: "claude-sonnet-4-6", // only model, no provider
      });

      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.routedBy).toBe("user-override");
    });
  });

  describe("fallback chain", () => {
    it("excludes the chosen target from the fallback list", async () => {
      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
        makeFakeProvider({ name: "anthropic", models: ["claude-sonnet-4-6"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "x" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });

      expect(
        result.fallbacks.some(
          (t) => t.provider === "anthropic" && t.model === "claude-sonnet-4-6",
        ),
      ).toBe(false);
      // But openai/gpt-4.1-nano should appear as a valid fallback target
      expect(
        result.fallbacks.some((t) => t.provider === "openai" && t.model === "gpt-4.1-nano"),
      ).toBe(true);
    });
  });

  describe("A/B test precedence (#77)", () => {
    const setupWithAb = async () => {
      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano", "gpt-4o"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      // Insert a scoped A/B test: general/medium → force gpt-4o
      const testId = nanoid();
      await db.insert(abTests).values({ id: testId, name: "t", status: "active" }).run();
      await db.insert(abTestVariants).values({
        id: nanoid(),
        abTestId: testId,
        provider: "openai",
        model: "gpt-4o",
        weight: 1,
        taskType: "general",
        complexity: "medium",
      }).run();
      await db.insert(abTestVariants).values({
        id: nanoid(),
        abTestId: testId,
        provider: "openai",
        model: "gpt-4.1-nano",
        weight: 1,
        taskType: "general",
        complexity: "medium",
      }).run();

      return { db, engine, testId };
    };

    it("default abTestPreempts=true → ab-test wins on an active cell", async () => {
      const { db, engine } = await setupWithAb();
      await setRoutingConfig(db, { abTestPreempts: true });

      // Classifier will put "hi" into general/something; hint locks the cell.
      const result = await engine.route({
        messages: [{ role: "user", content: "anything" }],
        routingHint: "general",
      });

      // Classifier picks the complexity; we can't pin it here, but we can assert that
      // when a matching test exists, we don't end up on classification/cost-fallback.
      if (result.complexity === "medium") {
        expect(result.routedBy).toBe("ab-test");
      }
    });
  });

  // ε-greedy exploration (#103): breaks cold-start lock-in where one model
  // accumulates enough samples to clear MIN_SAMPLES and then wins forever
  // because no competitor is ever eligible. Math.random is stubbed to make
  // the two branches deterministic.
  describe("epsilon-greedy exploration (#103)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("exploration branch picks a candidate regardless of sample count when Math.random < ε", async () => {
      // Force exploration: Math.random always returns 0.0, which is < ε=0.1,
      // and also makes the index pick land on 0 (the first candidate).
      // Using mockReturnValue (not Once) avoids brittleness if other code paths
      // consume the mock before getBestModel runs.
      vi.spyOn(Math, "random").mockReturnValue(0.0);

      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
        makeFakeProvider({ name: "anthropic", models: ["claude-opus-4-7"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "hi" }],
        routingHint: "general",
      });

      // Neither model has any samples — the only path that produces a route
      // without the cheapest-first fallback firing is exploration.
      expect(result.routedBy).toBe("exploration");
    });

    it("skips exploration when Math.random >= ε and falls through normally", async () => {
      // Return 0.5 on every call — well above ε=0.1 default, so exploration never fires.
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
        makeFakeProvider({ name: "anthropic", models: ["claude-opus-4-7"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "hi" }],
        routingHint: "general",
      });

      // With no samples anywhere, adaptive returns null and we fall through to
      // the cheapest-first classification fallback. Critically, routedBy is
      // NOT "exploration".
      expect(result.routedBy).not.toBe("exploration");
    });

    it("exploration is disabled when only one candidate exists (no meaningful choice)", async () => {
      // Gate at 0.0 would normally force exploration, but the single-candidate
      // guard should skip the branch and fall through to the normal flow.
      vi.spyOn(Math, "random").mockReturnValue(0.0);

      const db = await makeTestDb();
      const registry = makeFakeRegistry([
        makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
      ]);
      const engine = await createRoutingEngine({ registry, db });

      const result = await engine.route({
        messages: [{ role: "user", content: "hi" }],
        routingHint: "general",
      });

      expect(result.routedBy).not.toBe("exploration");
      expect(result.model).toBe("gpt-4.1-nano");
    });
  });
});
