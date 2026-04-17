import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requests } from "@provara/db";
import { nanoid } from "nanoid";
import { createAnalyticsRoutes } from "../src/routes/analytics.js";
import { makeTestDb } from "./_setup/db.js";
import type { Provider, ProviderRegistry } from "../src/providers/index.js";

function mockRegistry(providers: Array<{ name: string; models: string[] }>): ProviderRegistry {
  const mapped: Provider[] = providers.map((p) => ({
    name: p.name,
    models: p.models,
    async complete() {
      throw new Error("mock");
    },
    async *stream() {},
  }));
  return {
    get: (name: string) => mapped.find((p) => p.name === name),
    list: () => mapped,
    refreshModels: async () => [],
  } as unknown as ProviderRegistry;
}

async function buildApp(registry?: ProviderRegistry) {
  const db = await makeTestDb();
  const app = new Hono();
  app.route("/v1/analytics", createAnalyticsRoutes(db, registry));
  return { db, app };
}

describe("overview providerCount uses the registry, not request history (#157)", () => {
  it("counts providers whose models list is non-empty", async () => {
    const registry = mockRegistry([
      { name: "openai", models: ["gpt-4o", "gpt-4o-mini"] },
      { name: "anthropic", models: ["claude-sonnet-4-6"] },
      { name: "google", models: ["gemini-2.5-pro"] },
      { name: "mistral", models: ["mistral-large-latest"] },
      { name: "xai", models: ["grok-2"] },
      { name: "zai", models: ["glm-4"] },
      { name: "openrouter", models: ["openrouter/mixture"] },
      { name: "together", models: ["llama-3"] },
    ]);
    const { app } = await buildApp(registry);
    const res = await app.request("/v1/analytics/overview");
    const body = await res.json();
    expect(body.providerCount).toBe(8);
  });

  it("excludes providers with no discovered models (unreachable Ollama case)", async () => {
    const registry = mockRegistry([
      { name: "openai", models: ["gpt-4o"] },
      { name: "anthropic", models: ["claude-sonnet-4-6"] },
      { name: "ollama", models: [] }, // registered but unreachable
    ]);
    const { app } = await buildApp(registry);
    const res = await app.request("/v1/analytics/overview");
    const body = await res.json();
    expect(body.providerCount).toBe(2);
  });

  it("ignores historical request rows — count comes from the live registry only", async () => {
    const registry = mockRegistry([
      { name: "openai", models: ["gpt-4o"] },
      { name: "anthropic", models: ["claude-sonnet-4-6"] },
    ]);
    const { db, app } = await buildApp(registry);

    // Seed requests for a provider that is no longer registered
    await db.insert(requests).values({
      id: nanoid(),
      provider: "legacy-provider",
      model: "retired-model",
      prompt: "x",
      response: "y",
    }).run();

    const res = await app.request("/v1/analytics/overview");
    const body = await res.json();
    // Old reporting would have said 1 (legacy-provider). Registry-backed is 2.
    expect(body.providerCount).toBe(2);
  });

  it("returns 0 when no registry is wired (backward-compat)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/v1/analytics/overview");
    const body = await res.json();
    expect(body.providerCount).toBe(0);
  });
});
