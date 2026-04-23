/**
 * Multimodal content is modeled on OpenAI's chat-completion array shape:
 * the content of a user message can be a plain string or an array of parts,
 * each of which is either text or an image reference. Anthropic and Google
 * adapters translate these parts into their native formats.
 */
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

/** OpenAI-compatible tool-calling shape. Mirrors
 *  https://platform.openai.com/docs/api-reference/chat/create field-for-field
 *  so any SDK that targets OpenAI works against the gateway unchanged. */
export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunction;
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Streaming tool-call delta. `index` is required so clients can reassemble
 *  parallel tool calls; all other fields arrive incrementally. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** The OpenAI wire format allows `null` on assistant messages that carry only
   *  `tool_calls`. Internally we normalize that to `""` at the adapter/router
   *  boundary so downstream code (classifier, PII scan, cache key, DB logging)
   *  can treat content as a non-nullable text source. */
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Flatten a message's content to the text portion only. Image parts are replaced
 *  by a short placeholder so consumers that expect a string (classifier, PII
 *  scanner, cache-key hasher) don't crash on array content. */
export function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join(" ");
}

export function messageHasImage(msg: ChatMessage): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some((p) => p.type === "image_url");
}

export function messagesHaveImage(messages: ChatMessage[]): boolean {
  return messages.some(messageHasImage);
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  routing_hint?: "coding" | "creative" | "summarization" | "qa" | "general" | "vision";
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
}

export interface CompletionResponse {
  id: string;
  provider: string;
  model: string;
  content: string;
  tool_calls?: ToolCall[];
  finish_reason?: FinishReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  tool_calls?: ToolCallDelta[];
  finish_reason?: FinishReason;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface Provider {
  name: string;
  models: string[];
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  /** Query the provider API for available models. Updates `models` in-place and returns the list. */
  listModels?(): Promise<string[]>;
}
