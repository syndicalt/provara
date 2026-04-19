import Anthropic from "@anthropic-ai/sdk";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk, ChatMessage } from "./types.js";
import { nanoid } from "nanoid";

// Mirrors the Anthropic SDK's content-block shape loosely — `media_type` in
// the SDK is a literal union ("image/jpeg" | "image/png" | ...), but we accept
// any string from user input. The SDK's per-field validation rejects
// unsupported media types with a clear 400, which is the right failure mode.
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

/** Translate our OpenAI-shaped content parts into Anthropic content blocks.
 *  Supports both `data:image/...;base64,...` URIs and plain http(s) URLs. */
function toAnthropicContent(
  content: ChatMessage["content"],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map<AnthropicContentBlock>((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const url = part.image_url.url;
    const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) {
      return {
        type: "image",
        source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] },
      };
    }
    return { type: "image", source: { type: "url", url } };
  });
}

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
      const systemText =
        systemMessage && typeof systemMessage.content === "string"
          ? systemMessage.content
          : undefined;
      // Cast at the SDK boundary — our content type's `media_type: string`
      // is structurally incompatible with the SDK's literal-union type, but
      // the SDK validates at runtime.
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: toAnthropicContent(m.content),
        })) as Anthropic.Messages.MessageParam[];

      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens || 4096,
        system: systemText,
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
      const systemText =
        systemMessage && typeof systemMessage.content === "string"
          ? systemMessage.content
          : undefined;
      // Cast at the SDK boundary — our content type's `media_type: string`
      // is structurally incompatible with the SDK's literal-union type, but
      // the SDK validates at runtime.
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: toAnthropicContent(m.content),
        })) as Anthropic.Messages.MessageParam[];

      const stream = client.messages.stream({
        model: request.model,
        max_tokens: request.max_tokens || 4096,
        system: systemText,
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
