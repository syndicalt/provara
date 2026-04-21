import OpenAI from "openai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

type OpenAIMessages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];

export interface OpenAICompatibleConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const provider: Provider = {
    name: config.name,
    models: [...config.models],

    async listModels(): Promise<string[]> {
      try {
        const response = await client.models.list();
        const discovered: string[] = [];
        for await (const model of response) {
          discovered.push(model.id);
        }
        if (discovered.length > 0) {
          provider.models = discovered;
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
        provider: config.name,
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
      });

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta?.content || "";
        const done = choice.finish_reason === "stop";

        // Don't skip empty-content chunks. Thinking models (Ollama's Qwen3,
        // DeepSeek-R1 etc.) stream reasoning with content:"" for the whole
        // thinking pass — sometimes 30+ seconds — before any visible content.
        // Dropping those starves the router's first-chunk timeout and kills
        // the connection with a spurious "Connection error".
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

// Validate that a provider is OpenAI-compatible by testing the /models endpoint
// and optionally a lightweight chat completion
export async function validateCompatibility(
  baseURL: string,
  apiKey: string,
  testModel?: string
): Promise<{ compatible: boolean; error?: string; models?: string[] }> {
  const client = new OpenAI({ apiKey, baseURL, timeout: 10_000 });

  // Step 1: Try /models endpoint
  let models: string[] = [];
  try {
    const response = await client.models.list();
    for await (const model of response) {
      models.push(model.id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      compatible: false,
      error: `Failed to list models at ${baseURL}/models: ${msg}`,
    };
  }

  if (models.length === 0) {
    return {
      compatible: false,
      error: `No models found at ${baseURL}/models. The provider may not be OpenAI-compatible.`,
    };
  }

  // Step 2: Try a minimal chat completion
  const model = testModel || models[0];
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
    });

    // Validate response shape
    if (!response.choices || !Array.isArray(response.choices) || response.choices.length === 0) {
      return {
        compatible: false,
        error: `Provider responded but returned unexpected format (missing choices array).`,
        models,
      };
    }

    const choice = response.choices[0];
    if (!choice.message || typeof choice.message.content !== "string") {
      return {
        compatible: false,
        error: `Provider responded but message format is not OpenAI-compatible (missing message.content).`,
        models,
      };
    }

    return { compatible: true, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      compatible: false,
      error: `Models listed successfully but chat completion failed on ${model}: ${msg}`,
      models,
    };
  }
}

// Discover models from an OpenAI-compatible /models endpoint
export async function discoverModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const client = new OpenAI({ apiKey, baseURL });
    const response = await client.models.list();
    const models: string[] = [];
    for await (const model of response) {
      models.push(model.id);
    }
    return models;
  } catch {
    return [];
  }
}
