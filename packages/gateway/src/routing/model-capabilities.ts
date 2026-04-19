/**
 * Per-model capability flags that influence routing but aren't pricing
 * (#233). Kept as a separate registry from `MODEL_PRICING` so the
 * pricing data stays focused and so ops can update a model's
 * structured-output reliability without editing cost lookups.
 *
 * Sources for the starting list:
 *   - OpenAI: gpt-4o and gpt-4.1 families support structured outputs
 *     via the Responses/Chat Completions JSON-schema mode; nano is
 *     excluded because it frequently emits malformed shapes even when
 *     asked for a schema (UAT regression, April 2026).
 *   - Anthropic: sonnet and opus follow JSON-schema prompts reliably.
 *     Haiku is a coin flip — listed as unreliable.
 *   - Google: gemini-2.5-pro is reliable; flash variants are not.
 *   - Everything else (Mistral, xAI, Z.ai) is conservatively `false`
 *     until we have tenant signal that proves otherwise.
 *
 * Unknown models default to `false` — the safe choice. If a caller
 * needs structured output and the adaptive router's candidate pool
 * filters empty, the request returns a clear error rather than silently
 * routing to a probably-unreliable model.
 */

export const STRUCTURED_OUTPUT_RELIABLE = new Set<string>([
  // OpenAI
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3",
  "o4-mini",
  // Anthropic
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  // Google
  "gemini-2.5-pro",
]);

/**
 * Is this model known to reliably emit responses matching a
 * caller-supplied JSON schema? Unknown / unlisted models return false
 * — the adaptive router treats that as "don't pick for structured
 * requests," not "pick anyway and hope."
 */
export function isStructuredOutputReliable(model: string): boolean {
  return STRUCTURED_OUTPUT_RELIABLE.has(model);
}
