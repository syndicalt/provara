import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
} from "../../src/providers/types.js";

export interface FakeProviderOptions {
  name: string;
  models: string[];
  /** If set, every complete() call rejects with this error. */
  failWith?: Error;
  /** Override the response content. Defaults to a canned reply. */
  responseContent?: string;
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
        usage: { inputTokens: 10, outputTokens: 15 },
        latencyMs: 5,
      };
    },
    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      calls.push(request);
      if (currentFail) throw currentFail;
      const content = opts.responseContent ?? `fake reply from ${opts.name}/${request.model}`;
      yield { content, done: false };
      yield { content: "", done: true, usage: { inputTokens: 10, outputTokens: 15 } };
    },
  };

  return provider;
}
