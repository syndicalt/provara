import { describe, it, expect } from "vitest";
import { createRoutingEngine, NoCapableProviderError } from "../src/routing/index.js";
import { isStructuredOutputReliable } from "../src/routing/model-capabilities.js";
import { makeTestDb } from "./_setup/db.js";
import { makeFakeProvider } from "./_setup/fake-provider.js";
import { makeFakeRegistry } from "./_setup/fake-registry.js";

describe("#233 — structured-output-aware routing", () => {
  it("known-capable models return true; unlisted models default to false", () => {
    expect(isStructuredOutputReliable("gpt-4.1")).toBe(true);
    expect(isStructuredOutputReliable("claude-sonnet-4-6")).toBe(true);
    expect(isStructuredOutputReliable("gemini-2.5-pro")).toBe(true);
    // Unlisted — the model that motivated #233
    expect(isStructuredOutputReliable("gpt-4.1-nano")).toBe(false);
    // Haiku — listed as unreliable
    expect(isStructuredOutputReliable("claude-haiku-4-5-20251001")).toBe(false);
    // Model we've never heard of
    expect(isStructuredOutputReliable("some-future-model-v1")).toBe(false);
  });

  it("user-pinned provider+model bypasses the structured-output filter", async () => {
    // Caller explicitly pinning a non-capable model is an explicit
    // decision — the filter should not override it.
    const db = await makeTestDb();
    const registry = makeFakeRegistry([
      makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
    ]);
    const engine = await createRoutingEngine({ registry, db });

    const result = await engine.route({
      messages: [{ role: "user", content: "return JSON" }],
      provider: "openai",
      model: "gpt-4.1-nano",
      requiresStructuredOutput: true,
    });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-nano");
    expect(result.routedBy).toBe("user-override");
  });

  it("throws NoCapableProviderError when no capable model is registered", async () => {
    const db = await makeTestDb();
    // Only unreliable models available.
    const registry = makeFakeRegistry([
      makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
      makeFakeProvider({ name: "anthropic", models: ["claude-haiku-4-5-20251001"] }),
    ]);
    const engine = await createRoutingEngine({ registry, db });

    await expect(
      engine.route({
        messages: [{ role: "user", content: "return JSON" }],
        requiresStructuredOutput: true,
      }),
    ).rejects.toThrow(NoCapableProviderError);
  });

  it("narrows the fallback chain to capable models when the flag is set", async () => {
    const db = await makeTestDb();
    const registry = makeFakeRegistry([
      makeFakeProvider({ name: "openai", models: ["gpt-4.1", "gpt-4.1-nano"] }),
      makeFakeProvider({ name: "anthropic", models: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"] }),
    ]);
    const engine = await createRoutingEngine({ registry, db });

    const result = await engine.route({
      messages: [{ role: "user", content: "return JSON" }],
      requiresStructuredOutput: true,
    });

    // Every fallback (plus the winner) must be in the capable set.
    for (const fallback of result.fallbacks) {
      expect(isStructuredOutputReliable(fallback.model)).toBe(true);
    }
    expect(isStructuredOutputReliable(result.model)).toBe(true);
  });

  it("passes unreliable models through when the flag is NOT set", async () => {
    // Regression guard: the filter only activates on opt-in. Default
    // behavior preserves cheapest-first fallback including nano/haiku.
    const db = await makeTestDb();
    const registry = makeFakeRegistry([
      makeFakeProvider({ name: "openai", models: ["gpt-4.1-nano"] }),
    ]);
    const engine = await createRoutingEngine({ registry, db });

    const result = await engine.route({
      messages: [{ role: "user", content: "hi" }],
      // requiresStructuredOutput omitted
    });

    expect(result.model).toBe("gpt-4.1-nano");
  });
});
