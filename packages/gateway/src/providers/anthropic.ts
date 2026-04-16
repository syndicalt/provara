import Anthropic from "@anthropic-ai/sdk";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

export function createAnthropicProvider(apiKey?: string): Provider {
  const client = new Anthropic({
    apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
  });

  const provider: Provider = {
    name: "anthropic",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],

    async listModels(): Promise<string[]> {
      try {
        const response = await client.models.list({ limit: 100 });
        const chatModels: string[] = [];
        for (const model of response.data) {
          chatModels.push(model.id);
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

      const systemMessage = request.messages.find((m) => m.role === "system");
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens || 4096,
        system: systemMessage?.content,
        messages,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      });

      const latencyMs = Math.round(performance.now() - start);
      const textBlock = response.content.find((b) => b.type === "text");

      return {
        id: nanoid(),
        provider: "anthropic",
        model: request.model,
        content: textBlock?.text || "",
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        latencyMs,
      };
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const systemMessage = request.messages.find((m) => m.role === "system");
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const stream = client.messages.stream({
        model: request.model,
        max_tokens: request.max_tokens || 4096,
        system: systemMessage?.content,
        messages,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { content: event.delta.text, done: false };
        }
      }

      const finalMessage = await stream.finalMessage();
      yield {
        content: "",
        done: true,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    },
  };

  return provider;
}
