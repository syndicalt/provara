import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

export function createZAIProvider(apiKey?: string): Provider {
  return createOpenAICompatibleProvider({
    name: "zai",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiKey: apiKey || process.env.ZAI_API_KEY || "",
    models: ["glm-5.1", "glm-5-turbo", "glm-5v-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],
  });
}
