import type { Provider } from "./types.js";
import { createOpenAIProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createMistralProvider } from "./mistral.js";
import { createXAIProvider } from "./xai.js";
import { createZAIProvider } from "./zai.js";
import { createOllamaProvider } from "./ollama.js";

export type { Provider, CompletionRequest, CompletionResponse, ChatMessage } from "./types.js";

export interface ProviderRegistry {
  get(name: string): Provider | undefined;
  getForModel(model: string): Provider | undefined;
  list(): Provider[];
  reload(): void;
}

interface RegistryConfig {
  getKeys?: () => Record<string, string>;
}

export function createProviderRegistry(config?: RegistryConfig): ProviderRegistry {
  let providers: Provider[] = [];

  function load() {
    providers = [];
    const dbKeys = config?.getKeys?.() || {};

    // DB keys take precedence, fall back to env vars
    const openaiKey = dbKeys["OPENAI_API_KEY"] || process.env.OPENAI_API_KEY;
    const anthropicKey = dbKeys["ANTHROPIC_API_KEY"] || process.env.ANTHROPIC_API_KEY;
    const googleKey = dbKeys["GOOGLE_API_KEY"] || process.env.GOOGLE_API_KEY;
    const mistralKey = dbKeys["MISTRAL_API_KEY"] || process.env.MISTRAL_API_KEY;
    const xaiKey = dbKeys["XAI_API_KEY"] || process.env.XAI_API_KEY;

    if (openaiKey) providers.push(createOpenAIProvider(openaiKey));
    if (anthropicKey) providers.push(createAnthropicProvider(anthropicKey));
    if (googleKey) providers.push(createGoogleProvider(googleKey));
    if (mistralKey) providers.push(createMistralProvider(mistralKey));
    if (xaiKey) providers.push(createXAIProvider(xaiKey));

    const zaiKey = dbKeys["ZAI_API_KEY"] || process.env.ZAI_API_KEY;
    if (zaiKey) providers.push(createZAIProvider(zaiKey));

    // Ollama is always available (local)
    providers.push(createOllamaProvider());
  }

  load();

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

    reload() {
      load();
    },
  };
}
