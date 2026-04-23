/**
 * Per-model capability lookup. Currently tracks one capability —
 * `supportsTools` — for the `/v1/chat/completions` tool-calling surface
 * shipped across #298–#300. Additional capability flags can live here as
 * they're added (e.g., vision, structured-outputs, response_format json_schema).
 *
 * Defaults by provider, per #301 design:
 *
 *   OpenAI, Anthropic, Google, Mistral, xAI, Z.ai  →  tools supported
 *   Ollama                                          →  gated by model base
 *   Unknown custom provider                         →  tools supported (do
 *                                                       not block on unknowns;
 *                                                       the adapter itself
 *                                                       will surface a clean
 *                                                       400 if it isn't)
 */

/** Ollama base-model prefixes known to support OpenAI-compatible tool calling.
 *  Check against `model.toLowerCase().startsWith(prefix)`. Keep this list small —
 *  it's easier to add a prefix than to debug why a new Ollama model is silently
 *  gated off. */
const OLLAMA_TOOL_CAPABLE_PREFIXES = [
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "llama4",
  "qwen2.5",
  "qwen3",
  "mistral",
  "mistral-nemo",
  "mixtral",
  "firefunction",
  "command-r",
  "hermes3",
  "granite3",
];

export function modelSupportsTools(provider: string, model: string): boolean {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  switch (p) {
    case "openai":
    case "anthropic":
    case "google":
    case "mistral":
    case "xai":
    case "zai":
      return true;
    case "ollama":
      return OLLAMA_TOOL_CAPABLE_PREFIXES.some((prefix) => m.startsWith(prefix));
    default:
      // Custom OpenAI-compatible providers registered via addCustom: default
      // to `true` because they almost universally follow the OpenAI wire shape.
      // If a specific one doesn't, the adapter will surface the upstream 400
      // which is a cleaner failure mode than false-negative gating here.
      return true;
  }
}

export interface ModelCapability {
  supportsTools: boolean;
}

export function getModelCapability(provider: string, model: string): ModelCapability {
  return { supportsTools: modelSupportsTools(provider, model) };
}
