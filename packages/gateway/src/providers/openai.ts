import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

export function createOpenAIProvider(apiKey?: string): Provider {
  const client = new OpenAI({
    apiKey: apiKey || process.env.OPENAI_API_KEY,
  });

  const provider: Provider = {
    name: "openai",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o4-mini"],

    async listModels(): Promise<string[]> {
      try {
        const response = await client.models.list();
        const chatModels: string[] = [];
        for await (const model of response) {
          // Only include chat-capable models, skip embeddings/tts/whisper/dall-e
          if (model.id.startsWith("gpt-") || model.id.startsWith("o1") || model.id.startsWith("o3") || model.id.startsWith("o4")) {
            chatModels.push(model.id);
          }
        }
        if (chatModels.length > 0) {
          provider.models = chatModels;
        }
        return provider.models;
      } catch {
        return provider.models;
      }
    },

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
        provider: "openai",
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
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        const done = chunk.choices[0]?.finish_reason === "stop";

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

  return provider;
}
