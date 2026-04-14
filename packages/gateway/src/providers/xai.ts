import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

export function createXAIProvider(apiKey?: string): Provider {
  return createOpenAICompatibleProvider({
    name: "xai",
    baseURL: "https://api.x.ai/v1",
    apiKey: apiKey || process.env.XAI_API_KEY || "",
    models: ["grok-3", "grok-3-mini"],
  });
}
