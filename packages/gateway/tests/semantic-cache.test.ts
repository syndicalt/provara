import { describe, it, expect } from "vitest";
import { cosineSimilarity, encodeEmbedding, decodeEmbedding } from "../src/embeddings/index.js";
import {
  createSemanticCache,
  hashSystemPrompt,
  isCacheEligible,
  looksPersonalized,
} from "../src/cache/semantic.js";
import type { EmbeddingProvider } from "../src/embeddings/index.js";
import type { ChatMessage, CompletionResponse } from "../src/providers/types.js";
import { makeTestDb } from "./_setup/db.js";

describe("embeddings math", () => {
  it("cosineSimilarity: identical vectors = 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it("cosineSimilarity: orthogonal vectors = 0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it("cosineSimilarity: opposite vectors = -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("encode/decode round-trips a Float32 vector", () => {
    const v = [0.1, -0.2, 0.3, 0.4];
    const buf = encodeEmbedding(v);
    const decoded = decodeEmbedding(buf);
    expect(decoded.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) {
      expect(decoded[i]).toBeCloseTo(v[i], 5);
    }
  });
});

describe("cache eligibility + safety", () => {
  it("single-turn user message is eligible", () => {
    expect(isCacheEligible([{ role: "user", content: "hi" }])).toBe(true);
  });

  it("system + single user is eligible", () => {
    expect(
      isCacheEligible([
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ]),
    ).toBe(true);
  });

  it("multi-turn with prior assistant is not eligible", () => {
    expect(
      isCacheEligible([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and you?" },
      ]),
    ).toBe(false);
  });

  it("looksPersonalized catches first-person signals", () => {
    expect(looksPersonalized("my email is x@y.com")).toBe(true);
    expect(looksPersonalized("our quarterly results")).toBe(true);
    expect(looksPersonalized("call me at 555-123-4567")).toBe(true);
  });

  it("looksPersonalized leaves generic questions alone", () => {
    expect(looksPersonalized("what is the capital of France?")).toBe(false);
    expect(looksPersonalized("write a quicksort in Rust")).toBe(false);
  });

  it("hashSystemPrompt produces matching hashes for identical system prompts", () => {
    const a = hashSystemPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    const b = hashSystemPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: "different user msg" },
    ]);
    expect(a).toBe(b);
  });

  it("hashSystemPrompt differs when system prompts differ", () => {
    const a = hashSystemPrompt([{ role: "system", content: "be brief" }, { role: "user", content: "x" }]);
    const b = hashSystemPrompt([{ role: "system", content: "be verbose" }, { role: "user", content: "x" }]);
    expect(a).not.toBe(b);
  });
});

function makeStubEmbeddings(vectors: Record<string, number[]>, model = "text-embedding-3-small"): EmbeddingProvider {
  return {
    name: "stub",
    model,
    dim: 4,
    async embed(text: string) {
      const v = vectors[text];
      if (!v) throw new Error(`stub: no vector for "${text}"`);
      return v;
    },
  };
}

const dummyResponse = (content: string): CompletionResponse => ({
  id: "stub-id",
  provider: "openai",
  model: "gpt-4.1-nano",
  content,
  usage: { inputTokens: 10, outputTokens: 20 },
  latencyMs: 100,
});

describe("semantic cache integration", () => {
  it("returns cached response on a high-similarity match", async () => {
    const db = await makeTestDb();
    const vectors: Record<string, number[]> = {
      "what is the capital of France?": [1, 0, 0, 0],
      "capital city of France?": [0.98, 0.02, 0, 0], // cosine sim ~0.9998 with above
    };
    const embeddings = makeStubEmbeddings(vectors);
    const cache = await createSemanticCache(db, embeddings);

    const messages1: ChatMessage[] = [{ role: "user", content: "what is the capital of France?" }];
    await cache.put(messages1, null, "openai", "gpt-4.1-nano", dummyResponse("Paris"));

    const messages2: ChatMessage[] = [{ role: "user", content: "capital city of France?" }];
    const hit = await cache.get(messages2, null, "openai", "gpt-4.1-nano");

    expect(hit).not.toBeNull();
    expect(hit?.row.response).toBe("Paris");
    expect(hit!.similarity).toBeGreaterThan(0.97);
  });

  it("misses when similarity is below threshold", async () => {
    const db = await makeTestDb();
    const vectors: Record<string, number[]> = {
      "what is the capital of France?": [1, 0, 0, 0],
      "how do I bake bread?": [0, 1, 0, 0], // orthogonal → cosine 0
    };
    const embeddings = makeStubEmbeddings(vectors);
    const cache = await createSemanticCache(db, embeddings);

    await cache.put(
      [{ role: "user", content: "what is the capital of France?" }],
      null,
      "openai",
      "gpt-4.1-nano",
      dummyResponse("Paris"),
    );

    const miss = await cache.get(
      [{ role: "user", content: "how do I bake bread?" }],
      null,
      "openai",
      "gpt-4.1-nano",
    );
    expect(miss).toBeNull();
  });

  it("isolates cache entries by tenant", async () => {
    const db = await makeTestDb();
    const vectors: Record<string, number[]> = {
      "same question": [1, 0, 0, 0],
    };
    const embeddings = makeStubEmbeddings(vectors);
    const cache = await createSemanticCache(db, embeddings);

    await cache.put(
      [{ role: "user", content: "same question" }],
      "tenant-a",
      "openai",
      "gpt-4.1-nano",
      dummyResponse("answer for A"),
    );

    const missForB = await cache.get(
      [{ role: "user", content: "same question" }],
      "tenant-b",
      "openai",
      "gpt-4.1-nano",
    );
    expect(missForB).toBeNull();

    const hitForA = await cache.get(
      [{ role: "user", content: "same question" }],
      "tenant-a",
      "openai",
      "gpt-4.1-nano",
    );
    expect(hitForA?.row.response).toBe("answer for A");
  });

  it("skips semantic match for personalized prompts", async () => {
    const db = await makeTestDb();
    const vectors: Record<string, number[]> = {
      "my favorite color is blue": [1, 0, 0, 0],
    };
    const embeddings = makeStubEmbeddings(vectors);
    const cache = await createSemanticCache(db, embeddings);

    await cache.put(
      [{ role: "user", content: "my favorite color is blue" }],
      null,
      "openai",
      "gpt-4.1-nano",
      dummyResponse("Nice."),
    );

    const miss = await cache.get(
      [{ role: "user", content: "my favorite color is blue" }],
      null,
      "openai",
      "gpt-4.1-nano",
    );
    expect(miss).toBeNull();
  });

  it("rejects cross-model matches when embedding model changes", async () => {
    const db = await makeTestDb();
    const vectors: Record<string, number[]> = { "q": [1, 0, 0, 0] };

    const e1 = makeStubEmbeddings(vectors, "text-embedding-3-small");
    const cache1 = await createSemanticCache(db, e1);
    await cache1.put([{ role: "user", content: "q" }], null, "openai", "gpt-4.1-nano", dummyResponse("a"));

    const e2 = makeStubEmbeddings(vectors, "text-embedding-3-large");
    const cache2 = await createSemanticCache(db, e2);
    const hit = await cache2.get([{ role: "user", content: "q" }], null, "openai", "gpt-4.1-nano");
    expect(hit).toBeNull();
  });
});
