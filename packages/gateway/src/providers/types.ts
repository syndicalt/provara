export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  routing_hint?: "coding" | "creative" | "summarization" | "qa" | "general";
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
}
