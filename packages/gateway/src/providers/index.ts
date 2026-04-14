import type { Provider } from "./types.js";
import { createOpenAIProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createMistralProvider } from "./mistral.js";
import { createXAIProvider } from "./xai.js";
import { createOllamaProvider } from "./ollama.js";

export type { Provider, CompletionRequest, CompletionResponse, ChatMessage } from "./types.js";

export interface ProviderRegistry {
  get(name: string): Provider | undefined;
  getForModel(model: string): Provider | undefined;
  list(): Provider[];
}

export function createProviderRegistry(): ProviderRegistry {
  const providers: Provider[] = [];

  if (process.env.OPENAI_API_KEY) {
    providers.push(createOpenAIProvider());
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(createAnthropicProvider());
  }
  if (process.env.GOOGLE_API_KEY) {
    providers.push(createGoogleProvider());
  }
  if (process.env.MISTRAL_API_KEY) {
    providers.push(createMistralProvider());
  }
  if (process.env.XAI_API_KEY) {
    providers.push(createXAIProvider());
  }

  // Ollama is always available (local)
  providers.push(createOllamaProvider());

  return {
    get(name: string) {
      return providers.find((p) => p.name === name);
    },

    getForModel(model: string) {
      return providers.find((p) => p.models.includes(model));
    },

    list() {
      return providers;
    },
  };
}
