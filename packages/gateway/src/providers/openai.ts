import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

// Our ChatMessage content is `string | ContentPart[]`, which is structurally
// compatible with OpenAI's ChatCompletionMessageParam for user messages. The
// SDK's per-role type discrimination is stricter than what we model, so we
// pass through with a narrow cast at the boundary.
type OpenAIMessages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];

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
          // Only include chat completion-capable models
          const id = model.id;
          const isChat = id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4");
          const isNonChat = /-(tts|realtime|audio|transcribe|diarize|image|search)/.test(id)
            || id.includes("instruct")
            || id.startsWith("gpt-image");
          if (isChat && !isNonChat) {
            chatModels.push(id);
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
        messages: request.messages as OpenAIMessages,
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
        messages: request.messages as OpenAIMessages,
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
