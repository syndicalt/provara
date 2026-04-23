import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
  ToolCall,
  ToolCallDelta,
  FinishReason,
} from "./types.js";
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

/** OpenAI tools → Anthropic Tool[]. The parameters JSON schema is passed
 *  through; Anthropic requires `type: "object"` at the top level. */
export function toAnthropicTools(
  tools: ToolDefinition[] | undefined,
): Anthropic.Messages.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters ?? {
      type: "object",
      properties: {},
    }) as Anthropic.Messages.Tool.InputSchema,
  }));
}

/** OpenAI tool_choice → Anthropic ToolChoice. Mapping:
 *   "none"     → {type: "none"}
 *   "auto"     → {type: "auto"}
 *   "required" → {type: "any"}          (Anthropic's "use some tool")
 *   {function} → {type: "tool", name}   (Anthropic's "use this specific tool")
 */
export function toAnthropicToolChoice(
  choice: ToolChoice | undefined,
): Anthropic.Messages.ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

/** Build Anthropic message sequence from an OpenAI ChatMessage sequence.
 *
 *  Rules:
 *  - System messages are filtered out (carried on the `system` param).
 *  - `role: "tool"` messages become user messages carrying `tool_result` blocks.
 *    Consecutive tool messages merge into a single user message with multiple
 *    tool_result blocks (parallel tool-call results in one turn).
 *  - `role: "assistant"` with non-empty `tool_calls` becomes an assistant
 *    message whose content is a block array: any text first, then each
 *    tool_call rendered as a `tool_use` block with parsed input.
 *  - Other messages translate via `toAnthropicContent` unchanged.
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : "",
      };
      const prev = out[out.length - 1];
      // Merge consecutive tool results into a single user message so Anthropic
      // sees one turn per round of parallel tool calls, matching the OpenAI
      // conversation shape where the client sends multiple role:"tool" messages.
      if (
        prev &&
        prev.role === "user" &&
        Array.isArray(prev.content) &&
        prev.content.every((b) => (b as { type?: string }).type === "tool_result")
      ) {
        (prev.content as Array<typeof toolResult>).push(toolResult);
      } else {
        out.push({ role: "user", content: [toolResult] } as Anthropic.Messages.MessageParam);
      }
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("")
            : "";
      if (text) blocks.push({ type: "text", text });
      for (const tc of msg.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // Malformed args from upstream — pass through as empty object; the
          // model can always emit a corrective tool call in the next turn.
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks } as unknown as Anthropic.Messages.MessageParam);
      continue;
    }

    out.push({
      role: msg.role as "user" | "assistant",
      content: toAnthropicContent(msg.content),
    } as Anthropic.Messages.MessageParam);
  }
  return out;
}

export function mapStopReason(
  sr: string | null | undefined,
): FinishReason | undefined {
  if (!sr) return undefined;
  switch (sr) {
    case "end_turn":
      return "stop";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return undefined;
  }
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

      const messages = toAnthropicMessages(request.messages);
      const tools = toAnthropicTools(request.tools);
      const toolChoice = toAnthropicToolChoice(request.tool_choice);

      const response = await client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens || 4096,
        system: systemText,
        messages,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(tools && { tools }),
        ...(toolChoice && { tool_choice: toolChoice }),
      });

      const latencyMs = Math.round(performance.now() - start);

      // Walk content blocks: concat text, collect tool_use → OpenAI tool_calls.
      let content = "";
      const toolCalls: ToolCall[] = [];
      for (const block of response.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      return {
        id: nanoid(),
        provider: "anthropic",
        model: request.model,
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: mapStopReason(response.stop_reason),
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

      const messages = toAnthropicMessages(request.messages);
      const tools = toAnthropicTools(request.tools);
      const toolChoice = toAnthropicToolChoice(request.tool_choice);

      const stream = client.messages.stream({
        model: request.model,
        max_tokens: request.max_tokens || 4096,
        system: systemText,
        messages,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(tools && { tools }),
        ...(toolChoice && { tool_choice: toolChoice }),
      });

      // State machine for tool-use streaming. Anthropic emits one content_block_start
      // per tool_use block carrying id + name (args arrive later as input_json_delta
      // events, one partial_json fragment at a time). We map each Anthropic block
      // index to an OpenAI-style delta index so the client sees coherent `tool_calls`
      // deltas with stable `id` and incrementally-built `function.arguments`.
      const blockIndexToToolCallIndex = new Map<number, number>();
      let nextToolCallIndex = 0;
      let pendingStopReason: FinishReason | undefined;

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            const toolCallIndex = nextToolCallIndex++;
            blockIndexToToolCallIndex.set(event.index, toolCallIndex);
            const delta: ToolCallDelta = {
              index: toolCallIndex,
              id: event.content_block.id,
              type: "function",
              function: {
                name: event.content_block.name,
                arguments: "",
              },
            };
            yield { content: "", done: false, tool_calls: [delta] };
          }
          // text / thinking blocks: nothing to emit on start
          continue;
        }

        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { content: event.delta.text, done: false };
          } else if (event.delta.type === "input_json_delta") {
            const toolCallIndex = blockIndexToToolCallIndex.get(event.index);
            if (toolCallIndex === undefined) continue;
            yield {
              content: "",
              done: false,
              tool_calls: [
                {
                  index: toolCallIndex,
                  function: { arguments: event.delta.partial_json },
                },
              ],
            };
          }
          continue;
        }

        if (event.type === "message_delta") {
          pendingStopReason = mapStopReason(event.delta.stop_reason);
          continue;
        }
        // content_block_stop, message_start, message_stop: no-op here
      }

      const finalMessage = await stream.finalMessage();
      yield {
        content: "",
        done: true,
        finish_reason: pendingStopReason ?? mapStopReason(finalMessage.stop_reason),
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    },
  };

  return provider;
}
