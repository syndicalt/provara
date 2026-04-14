import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse } from "./types.js";
import { nanoid } from "nanoid";

export function createMistralProvider(apiKey?: string): Provider {
  const client = new OpenAI({
    apiKey: apiKey || process.env.MISTRAL_API_KEY,
    baseURL: "https://api.mistral.ai/v1",
  });

  return {
    name: "mistral",
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],

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
        provider: "mistral",
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
