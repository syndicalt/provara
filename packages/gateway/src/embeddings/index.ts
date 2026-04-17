import OpenAI from "openai";

export interface EmbeddingProvider {
  /** Return a dense vector for `text`. Fixed-length per-provider. */
  embed(text: string): Promise<number[]>;
  readonly dim: number;
  readonly name: string;
  readonly model: string;
}

function createOpenAIEmbeddings(apiKey: string, model: string, dim: number): EmbeddingProvider {
  const client = new OpenAI({ apiKey });
  return {
    name: "openai",
    model,
    dim,
    async embed(text: string): Promise<number[]> {
      const res = await client.embeddings.create({ model, input: text });
      const v = res.data[0]?.embedding;
      if (!v || v.length !== dim) {
        throw new Error(`[embeddings] openai returned ${v?.length ?? 0} dims, expected ${dim}`);
      }
      return v;
    },
  };
}

export interface EmbeddingFactoryConfig {
  /** DB-stored keys. Precedence over env vars, mirroring the provider registry. */
  dbKeys?: Record<string, string>;
}

/**
 * Resolve an embedding provider from env + DB keys. Returns null when the
 * semantic cache is disabled or no API key is available — callers should
 * treat null as "semantic cache is off" rather than an error.
 */
export function createEmbeddingProvider(config: EmbeddingFactoryConfig = {}): EmbeddingProvider | null {
  if (process.env.PROVARA_SEMANTIC_CACHE_ENABLED === "false") return null;

  const providerName = (process.env.PROVARA_EMBEDDING_PROVIDER || "openai").toLowerCase();
  if (providerName !== "openai") {
    console.warn(`[embeddings] unknown provider "${providerName}", disabling semantic cache`);
    return null;
  }

  const apiKey = config.dbKeys?.["OPENAI_API_KEY"] || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.PROVARA_EMBEDDING_MODEL || "text-embedding-3-small";
  // text-embedding-3-small → 1536, text-embedding-3-large → 3072, ada-002 → 1536.
  // Keep a small allow-list; unknown models disable the cache rather than
  // guess a dim and silently corrupt stored vectors.
  const dims: Record<string, number> = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
  };
  const dim = dims[model];
  if (!dim) {
    console.warn(`[embeddings] unknown model "${model}", disabling semantic cache`);
    return null;
  }

  return createOpenAIEmbeddings(apiKey, model, dim);
}

/** Cosine similarity for two same-length numeric vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`[embeddings] cosine: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Encode Float32 vector as a compact Buffer for DB storage. */
export function encodeEmbedding(v: number[]): Buffer {
  const f = new Float32Array(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** Decode the Buffer back to a number[] of the same length. */
export function decodeEmbedding(buf: Buffer): number[] {
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f);
}
