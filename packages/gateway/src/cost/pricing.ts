// Pricing per 1M tokens [input, output] in USD
const MODEL_PRICING: Record<string, [number, number]> = {
  // OpenAI
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "o3": [2, 8],
  "o4-mini": [1.1, 4.4],

  // Anthropic
  "claude-opus-4-6": [15, 75],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5-20251001": [0.8, 4],

  // Google
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash": [0.15, 0.6],
  "gemini-2.0-flash": [0.1, 0.4],

  // Mistral
  "mistral-large-latest": [2, 6],
  "mistral-medium-latest": [2.7, 8.1],
  "mistral-small-latest": [0.1, 0.3],

  // xAI
  "grok-3": [3, 15],
  "grok-3-mini": [0.3, 0.5],

  // Z.ai
  "glm-5.1": [1.4, 4.4],
  "glm-5": [1.0, 3.2],
  "glm-5-turbo": [1.2, 4.0],
  "glm-4.7": [0.6, 2.2],
  "glm-4.7-flashx": [0.07, 0.4],
  "glm-4.7-flash": [0, 0],
  "glm-5v-turbo": [1.2, 4.0],
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;

  const [inputPer1M, outputPer1M] = pricing;
  return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
}

export function getPricing(model: string): [number, number] | undefined {
  return MODEL_PRICING[model];
}
