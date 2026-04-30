import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ToolCall,
} from "../../src/providers/types.js";

export interface FakeProviderOptions {
  name: string;
  models: string[];
  /** If set, every complete() call rejects with this error. */
  failWith?: Error;
  /** Override the response content. Defaults to a canned reply. */
  responseContent?: string;
  /** Override the terminal finish reason for complete() and stream(). */
  finishReason?: CompletionResponse["finish_reason"];
  /** When set, the fake returns these tool_calls on complete() / streams
   *  an equivalent delta plus a `tool_calls` finish_reason on stream(). */
  responseToolCalls?: ToolCall[];
}

/**
 * A configurable in-memory Provider for tests.
 * Tracks every call through `.calls` so tests can assert on what was sent.
 */
export function makeFakeProvider(opts: FakeProviderOptions): Provider & {
  calls: CompletionRequest[];
  setFail(err: Error | null): void;
} {
  const calls: CompletionRequest[] = [];
  let currentFail: Error | null = opts.failWith || null;

  const provider: Provider & {
    calls: CompletionRequest[];
    setFail(err: Error | null): void;
  } = {
    name: opts.name,
    models: [...opts.models],
    calls,
    setFail(err) {
      currentFail = err;
    },
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      calls.push(request);
      if (currentFail) throw currentFail;
      const content = opts.responseContent ?? `fake reply from ${opts.name}/${request.model}`;
      return {
        id: `fake-${Math.random().toString(36).slice(2, 10)}`,
        provider: opts.name,
        model: request.model,
        content,
        tool_calls: opts.responseToolCalls,
        finish_reason: opts.responseToolCalls && opts.responseToolCalls.length > 0
          ? "tool_calls"
          : opts.finishReason ?? "stop",
        usage: { inputTokens: 10, outputTokens: 15 },
        latencyMs: 5,
      };
    },
    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      calls.push(request);
      if (currentFail) throw currentFail;
      if (opts.responseToolCalls && opts.responseToolCalls.length > 0) {
        yield {
          content: "",
          done: false,
          tool_calls: opts.responseToolCalls.map((tc, index) => ({
            index,
            id: tc.id,
            type: "function" as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
        yield {
          content: "",
          done: true,
          finish_reason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 15 },
        };
        return;
      }
      const content = opts.responseContent ?? `fake reply from ${opts.name}/${request.model}`;
      if (opts.finishReason === "content_filter") {
        yield { content, done: true, finish_reason: "content_filter", usage: { inputTokens: 10, outputTokens: 15 } };
        return;
      }
      yield { content, done: false };
      yield {
        content: "",
        done: true,
        finish_reason: opts.finishReason,
        usage: { inputTokens: 10, outputTokens: 15 },
      };
    },
  };

  return provider;
}
