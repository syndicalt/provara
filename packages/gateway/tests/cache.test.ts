import { describe, it, expect } from "vitest";
import { getCached, putCache, cacheStats } from "../src/cache/index.js";
import type { CompletionResponse, ToolDefinition } from "../src/providers/types.js";

function makeResponse(provider: string, model: string, content: string): CompletionResponse {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    provider,
    model,
    content,
    usage: { inputTokens: 10, outputTokens: 20 },
    latencyMs: 123,
  };
}

describe("cache", () => {
  it("round-trips a response for the same (messages, provider, model)", () => {
    const messages = [{ role: "user" as const, content: "unique-1" }];
    const resp = makeResponse("openai", "gpt-4.1-nano", "hello");

    putCache(messages, "openai", "gpt-4.1-nano", resp);
    const hit = getCached(messages, "openai", "gpt-4.1-nano");

    expect(hit).not.toBeNull();
    expect(hit?.content).toBe("hello");
    expect(hit?.provider).toBe("openai");
  });

  it("does NOT return a cross-model cache hit (the bug #75 fixed)", () => {
    const messages = [{ role: "user" as const, content: "unique-2" }];
    const nanoResp = makeResponse("openai", "gpt-4.1-nano", "nano answer");

    putCache(messages, "openai", "gpt-4.1-nano", nanoResp);

    // Same prompt, different model → must miss
    expect(getCached(messages, "anthropic", "claude-sonnet-4-6")).toBeNull();
    // Same prompt, different provider, same model name → must miss
    expect(getCached(messages, "openai", "gpt-4o")).toBeNull();
  });

  it("does NOT return a cross-prompt hit (different messages)", () => {
    const prompt1 = [{ role: "user" as const, content: "question-a" }];
    const prompt2 = [{ role: "user" as const, content: "question-b" }];
    const resp = makeResponse("openai", "gpt-4.1-nano", "answer-a");

    putCache(prompt1, "openai", "gpt-4.1-nano", resp);

    expect(getCached(prompt1, "openai", "gpt-4.1-nano")).not.toBeNull();
    expect(getCached(prompt2, "openai", "gpt-4.1-nano")).toBeNull();
  });

  it("expires entries after the TTL elapses", () => {
    const messages = [{ role: "user" as const, content: "unique-3" }];
    const resp = makeResponse("openai", "gpt-4.1-nano", "expiring");

    // 10ms TTL for this test
    putCache(messages, "openai", "gpt-4.1-nano", resp, 10);

    expect(getCached(messages, "openai", "gpt-4.1-nano")).not.toBeNull();

    // Jump past the TTL
    const initialNow = Date.now();
    const stub = () => initialNow + 50;
    const originalNow = Date.now;
    Date.now = stub;
    try {
      expect(getCached(messages, "openai", "gpt-4.1-nano")).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  it("does NOT return a cross-tools hit — identical messages, different tools miss", () => {
    const messages = [{ role: "user" as const, content: "what is the weather" }];
    const weatherTool: ToolDefinition = {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    };
    const stockTool: ToolDefinition = {
      type: "function",
      function: {
        name: "get_stock_price",
        description: "Get current stock price",
        parameters: { type: "object", properties: { ticker: { type: "string" } } },
      },
    };
    const resp = makeResponse("openai", "gpt-4.1-nano", "tool answer");

    putCache(messages, "openai", "gpt-4.1-nano", resp, undefined, [weatherTool]);

    // Same (messages, provider, model) but different tools → must miss.
    expect(getCached(messages, "openai", "gpt-4.1-nano", [stockTool])).toBeNull();
    // Same (messages, provider, model) but no tools → must also miss.
    expect(getCached(messages, "openai", "gpt-4.1-nano")).toBeNull();
    // Same tools → must hit.
    expect(getCached(messages, "openai", "gpt-4.1-nano", [weatherTool])).not.toBeNull();
  });

  it("uses stable key ordering — reordered tool JSON keys still hit the cache", () => {
    const messages = [{ role: "user" as const, content: "stable-key-test" }];
    const originalTool: ToolDefinition = {
      type: "function",
      function: {
        name: "lookup",
        description: "Look something up",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      },
    };
    // Same tool reconstructed with keys in a different insertion order.
    const reorderedTool: ToolDefinition = {
      function: {
        parameters: { properties: { id: { type: "string" } }, type: "object" },
        description: "Look something up",
        name: "lookup",
      },
      type: "function",
    };
    const resp = makeResponse("openai", "gpt-4.1-nano", "stable");

    putCache(messages, "openai", "gpt-4.1-nano", resp, undefined, [originalTool]);
    expect(getCached(messages, "openai", "gpt-4.1-nano", [reorderedTool])).not.toBeNull();
  });

  it("reports size via cacheStats", () => {
    const before = cacheStats().size;
    putCache(
      [{ role: "user" as const, content: `unique-stats-${Math.random()}` }],
      "openai",
      "gpt-4.1-nano",
      makeResponse("openai", "gpt-4.1-nano", "stats"),
    );
    expect(cacheStats().size).toBe(before + 1);
  });
});
