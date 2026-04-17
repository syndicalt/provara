import type { Provider } from "../../src/providers/types.js";
import type { ProviderRegistry, OpenAICompatibleConfig } from "../../src/providers/index.js";

/**
 * Wrap a set of fake providers in the ProviderRegistry interface so tests
 * can feed them directly to createRouter / createRoutingEngine without
 * exercising real provider construction.
 */
export function makeFakeRegistry(providers: Provider[]): ProviderRegistry {
  let list = [...providers];
  return {
    get(name) {
      return list.find((p) => p.name === name);
    },
    getForModel(model) {
      return list.find((p) => p.models.includes(model));
    },
    list() {
      return list;
    },
    reload() {},
    async refreshModels() {
      return list.map((p) => ({ provider: p.name, models: p.models, discovered: false }));
    },
    addCustom(_config: OpenAICompatibleConfig) {
      // no-op in tests
    },
    removeCustom(name) {
      list = list.filter((p) => p.name !== name);
    },
  };
}
