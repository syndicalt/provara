import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse } from "./types.js";
import { nanoid } from "nanoid";

export function createOllamaProvider(baseURL?: string): Provider {
  const client = new OpenAI({
    apiKey: "ollama",
    baseURL: baseURL || process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  });

  return {
    name: "ollama",
    models: [],

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
        provider: "ollama",
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
