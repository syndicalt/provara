import type { ABVariant } from "./types.js";

export type { ABTest, ABVariant } from "./types.js";

export function selectVariant(variants: ABVariant[]): ABVariant {
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  let random = Math.random() * totalWeight;

  for (const variant of variants) {
    random -= variant.weight;
    if (random <= 0) return variant;
  }

  return variants[variants.length - 1];
}
