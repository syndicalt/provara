import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse } from "./types.js";
import { nanoid } from "nanoid";

export function createZAIProvider(apiKey?: string): Provider {
  const client = new OpenAI({
    apiKey: apiKey || process.env.ZAI_API_KEY,
    baseURL: "https://api.z.ai/api/paas/v4",
  });

  return {
    name: "zai",
    models: ["glm-5.1", "glm-5-turbo", "glm-5v-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx"],

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const start = performance.now();

      const response = await client.chat.completions.create({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
      });

      const latencyMs = Math.round(performance.now() - start);
      const choice = response.choices[0];

      return {
        id: nanoid(),
        provider: "zai",
        model: request.model,
        content: choice?.message?.content || "",
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        latencyMs,
      };
    },
  };
}
