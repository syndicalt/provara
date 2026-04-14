import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

export function createMistralProvider(apiKey?: string): Provider {
  return createOpenAICompatibleProvider({
    name: "mistral",
    baseURL: "https://api.mistral.ai/v1",
    apiKey: apiKey || process.env.MISTRAL_API_KEY || "",
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  });
}
