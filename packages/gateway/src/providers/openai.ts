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
        tools: request.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
        tool_choice: request.tool_choice as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined,
        parallel_tool_calls: request.parallel_tool_calls,
      });

      const latencyMs = Math.round(performance.now() - start);
      const choice = response.choices[0];
      const toolCalls = choice?.message?.tool_calls;

      return {
        id: nanoid(),
        provider: "openai",
        model: request.model,
        content: choice?.message?.content || "",
        tool_calls: toolCalls && toolCalls.length > 0
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }))
          : undefined,
        finish_reason: (choice?.finish_reason ?? undefined) as CompletionResponse["finish_reason"],
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
        tools: request.tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
        tool_choice: request.tool_choice as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined,
        parallel_tool_calls: request.parallel_tool_calls,
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content || "";
        // `done` fires on any terminal finish_reason — not just "stop" — so
        // streams that end on "tool_calls" or "length" still close cleanly.
        const finishReason = choice?.finish_reason;
        const done = finishReason != null;
        const toolCallDeltas = choice?.delta?.tool_calls;

        yield {
          content: delta,
          done,
          tool_calls: toolCallDeltas && toolCallDeltas.length > 0
            ? toolCallDeltas.map((d) => ({
                index: d.index,
                id: d.id,
                type: d.type,
                function: d.function
                  ? {
                      name: d.function.name,
                      arguments: d.function.arguments,
                    }
                  : undefined,
              }))
            : undefined,
          finish_reason: (finishReason ?? undefined) as StreamChunk["finish_reason"],
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
