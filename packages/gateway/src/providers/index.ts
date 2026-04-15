import type { Provider } from "./types.js";
import { createOpenAIProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createMistralProvider } from "./mistral.js";
import { createXAIProvider } from "./xai.js";
import { createZAIProvider } from "./zai.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from "./openai-compatible.js";

export type { Provider, CompletionRequest, CompletionResponse, ChatMessage, StreamChunk } from "./types.js";
export { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from "./openai-compatible.js";

export interface ProviderRegistry {
  get(name: string): Provider | undefined;
  getForModel(model: string): Provider | undefined;
  list(): Provider[];
  reload(): void | Promise<void>;
  addCustom(config: OpenAICompatibleConfig): void;
  removeCustom(name: string): void;
}

interface RegistryConfig {
  getKeys?: () => Promise<Record<string, string>> | Record<string, string>;
  getCustomProviders?: () => Promise<OpenAICompatibleConfig[]> | OpenAICompatibleConfig[];
}

export async function createProviderRegistry(config?: RegistryConfig): Promise<ProviderRegistry> {
  let providers: Provider[] = [];

  async function load() {
    providers = [];
    const dbKeys = (await config?.getKeys?.()) || {};

    // Built-in providers: DB keys take precedence, fall back to env vars
    const openaiKey = dbKeys["OPENAI_API_KEY"] || process.env.OPENAI_API_KEY;
    const anthropicKey = dbKeys["ANTHROPIC_API_KEY"] || process.env.ANTHROPIC_API_KEY;
    const googleKey = dbKeys["GOOGLE_API_KEY"] || process.env.GOOGLE_API_KEY;
    const mistralKey = dbKeys["MISTRAL_API_KEY"] || process.env.MISTRAL_API_KEY;
    const xaiKey = dbKeys["XAI_API_KEY"] || process.env.XAI_API_KEY;
    const zaiKey = dbKeys["ZAI_API_KEY"] || process.env.ZAI_API_KEY;

    if (openaiKey) providers.push(createOpenAIProvider(openaiKey));
    if (anthropicKey) providers.push(createAnthropicProvider(anthropicKey));
    if (googleKey) providers.push(createGoogleProvider(googleKey));
    if (mistralKey) providers.push(createMistralProvider(mistralKey));
    if (xaiKey) providers.push(createXAIProvider(xaiKey));
    if (zaiKey) providers.push(createZAIProvider(zaiKey));

    // Ollama is always available (local)
    providers.push(createOllamaProvider());

    // Load custom providers from DB
    const customProviders = (await config?.getCustomProviders?.()) || [];
    for (const cp of customProviders) {
      // Skip if a built-in provider already exists with this name
      if (!providers.some((p) => p.name === cp.name)) {
        providers.push(createOpenAICompatibleProvider(cp));
      }
    }
  }

  await load();

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

    addCustom(customConfig: OpenAICompatibleConfig) {
      // Remove existing provider with same name if present
      providers = providers.filter((p) => p.name !== customConfig.name);
      providers.push(createOpenAICompatibleProvider(customConfig));
    },

    removeCustom(name: string) {
      providers = providers.filter((p) => p.name !== name);
    },
  };
}
