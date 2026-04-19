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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
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
}

export interface CompletionResponse {
  id: string;
  provider: string;
  model: string;
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
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
