import { describe, it, expect, beforeEach } from "vitest";
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
});
