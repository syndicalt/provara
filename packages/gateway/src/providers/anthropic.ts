import Anthropic from "@anthropic-ai/sdk";
import type { Provider, CompletionRequest, CompletionResponse } from "./types.js";
import { nanoid } from "nanoid";

export function createAnthropicProvider(apiKey?: string): Provider {
  const client = new Anthropic({
    apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
  });

  return {
    name: "anthropic",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],

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
  };
}
