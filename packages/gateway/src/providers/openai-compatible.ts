import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

export interface OpenAICompatibleConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return {
    name: config.name,
    models: [...config.models],

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
        provider: config.name,
        model: request.model,
        content: choice?.message?.content || "",
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        latencyMs,
      };
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const stream = await client.chat.completions.create({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        const done = chunk.choices[0]?.finish_reason === "stop";

        // Skip empty non-final chunks
        if (!delta && !done) continue;

        yield {
          content: delta,
          done,
          usage: chunk.usage
            ? {
                inputTokens: chunk.usage.prompt_tokens || 0,
                outputTokens: chunk.usage.completion_tokens || 0,
              }
            : undefined,
        };
      }
    },
  };
}

// Discover models from an OpenAI-compatible /models endpoint
export async function discoverModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const client = new OpenAI({ apiKey, baseURL });
    const response = await client.models.list();
    const models: string[] = [];
    for await (const model of response) {
      models.push(model.id);
    }
    return models;
  } catch {
    return [];
  }
}
