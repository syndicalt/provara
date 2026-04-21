import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

export function createOllamaProvider(baseURL?: string, apiKey?: string): Provider {
  const url = baseURL || process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const key = apiKey || process.env.OLLAMA_API_KEY || "ollama";

  const provider = createOpenAICompatibleProvider({
    name: "ollama",
    baseURL: url,
    apiKey: key,
    models: [],
  });

  // Prefer Ollama's native /api/tags over /v1/models — it's the canonical
  // endpoint for listing pulled models and surfaces auth failures cleanly.
  provider.listModels = async () => {
    try {
      const tagsURL = url.replace(/\/v1\/?$/, "") + "/api/tags";
      const res = await fetch(tagsURL, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return provider.models;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const discovered = data.models?.map((m) => m.name) ?? [];
      if (discovered.length > 0) provider.models = discovered;
      return provider.models;
    } catch {
      return provider.models;
    }
  };

  return provider;
}
