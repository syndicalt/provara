import { describe, expect, it } from "vitest";
import { requests } from "@provara/db";
import { createRouter } from "../src/router.js";
import { makeTestDb } from "./_setup/db.js";
import { makeFakeProvider } from "./_setup/fake-provider.js";
import { makeFakeRegistry } from "./_setup/fake-registry.js";

async function buildRefusalFallbackApp() {
  const db = await makeTestDb();
  const primary = makeFakeProvider({
    name: "openai",
    models: ["gpt-4.1-nano"],
    responseContent: "",
    finishReason: "content_filter",
  });
  const fallback = makeFakeProvider({
    name: "anthropic",
    models: ["claude-haiku-4-5-20251001"],
    responseContent: "fallback answer",
  });
  const registry = makeFakeRegistry([primary, fallback]);
  const app = await createRouter({ registry, db });
  return { app, db, primary, fallback };
}

describe("model refusal fallback", () => {
  it("retries the fallback chain when a non-streaming model returns content_filter", async () => {
    const { app, db, primary, fallback } = await buildRefusalFallbackApp();

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "",
        messages: [{ role: "user", content: "answer this" }],
        routing_hint: "general",
        temperature: 0.7,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      _provara: {
        provider: string;
        routing: { usedFallback: boolean };
        errors?: Array<{ provider: string; model: string; error: string }>;
      };
    };

    expect(body.choices[0].message.content).toBe("fallback answer");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body._provara.provider).toBe("anthropic");
    expect(body._provara.routing.usedFallback).toBe(true);
    expect(body._provara.errors?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-nano",
      error: "Model refused with finish_reason=content_filter",
    });
    expect(primary.calls.length).toBeGreaterThanOrEqual(1);
    expect(fallback.calls.length).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(requests).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("anthropic");
    expect(rows[0].usedFallback).toBe(true);
    expect(rows[0].fallbackErrors).toContain("content_filter");
  });

  it("falls back before committing a stream when the first provider returns content_filter", async () => {
    const { app, primary, fallback } = await buildRefusalFallbackApp();

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "",
        messages: [{ role: "user", content: "stream this" }],
        routing_hint: "general",
        stream: true,
        temperature: 0.7,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Provara-Provider")).toBe("anthropic");
    expect(res.headers.get("X-Provara-Errors")).toContain("content_filter");

    const text = await res.text();
    expect(text).toContain("fallback answer");
    expect(text).toContain("data: [DONE]");
    expect(primary.calls.length).toBeGreaterThanOrEqual(1);
    expect(fallback.calls.length).toBeGreaterThanOrEqual(1);
  });
});
