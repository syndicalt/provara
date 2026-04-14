import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

export function createOllamaProvider(baseURL?: string): Provider {
  return createOpenAICompatibleProvider({
    name: "ollama",
    baseURL: baseURL || process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    apiKey: "ollama",
    models: [], // Ollama accepts any model
  });
}
