import { describe, it, expect, vi, afterEach } from "vitest";
import { ema, getQualityAlpha } from "../src/routing/adaptive/ema.js";
import {
  PROFILE_WEIGHTS,
  computeRouteScore,
  resolveWeights,
} from "../src/routing/adaptive/scoring.js";
import { pickExploration } from "../src/routing/adaptive/exploration.js";
import type { RouteTarget } from "../src/routing/types.js";

describe("ema math", () => {
  it("ema(old, new, 1.0) = new (full weight on new value)", () => {
    expect(ema(2, 5, 1.0)).toBe(5);
  });

  it("ema(old, new, 0.0) = old (full weight on old value)", () => {
    expect(ema(2, 5, 0.0)).toBe(2);
  });

  it("ema(3, 5, 0.5) = 4 (midpoint)", () => {
    expect(ema(3, 5, 0.5)).toBe(4);
  });

  it("repeated ema steps converge toward the new value", () => {
    let v = 1;
    for (let i = 0; i < 50; i++) v = ema(v, 5, 0.1);
    expect(v).toBeGreaterThan(4.9);
    expect(v).toBeLessThan(5);
  });
});

describe("getQualityAlpha", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("user defaults to 0.4, judge to 0.2", () => {
    delete process.env.PROVARA_EMA_ALPHA;
    delete process.env.PROVARA_EMA_ALPHA_USER;
    delete process.env.PROVARA_EMA_ALPHA_JUDGE;
    expect(getQualityAlpha("user")).toBe(0.4);
    expect(getQualityAlpha("judge")).toBe(0.2);
  });

  it("source-specific env var beats global", () => {
    process.env.PROVARA_EMA_ALPHA = "0.5";
    process.env.PROVARA_EMA_ALPHA_USER = "0.8";
    expect(getQualityAlpha("user")).toBe(0.8);
    expect(getQualityAlpha("judge")).toBe(0.5);
  });

  it("empty-string env var falls back to default (regression — parseFloat('') = NaN)", () => {
    process.env.PROVARA_EMA_ALPHA_USER = "";
    process.env.PROVARA_EMA_ALPHA_JUDGE = "";
    process.env.PROVARA_EMA_ALPHA = "";
    expect(getQualityAlpha("user")).toBe(0.4);
    expect(getQualityAlpha("judge")).toBe(0.2);
  });

  it("non-numeric env var falls back to default", () => {
    process.env.PROVARA_EMA_ALPHA_USER = "not-a-number";
    expect(getQualityAlpha("user")).toBe(0.4);
  });

  it("falls through empty source-specific to global when global is valid", () => {
    process.env.PROVARA_EMA_ALPHA = "0.5";
    process.env.PROVARA_EMA_ALPHA_USER = "";
    expect(getQualityAlpha("user")).toBe(0.5);
  });
});

describe("resolveWeights", () => {
  it("returns the preset for named profiles", () => {
    expect(resolveWeights("balanced")).toEqual(PROFILE_WEIGHTS.balanced);
    expect(resolveWeights("cost")).toEqual(PROFILE_WEIGHTS.cost);
    expect(resolveWeights("quality")).toEqual(PROFILE_WEIGHTS.quality);
  });

  it("returns custom weights when profile=custom", () => {
    const custom = { quality: 0.9, cost: 0.05, latency: 0.05 };
    expect(resolveWeights("custom", custom)).toEqual(custom);
  });

  it("falls back to balanced when custom is requested without weights", () => {
    expect(resolveWeights("custom")).toEqual(PROFILE_WEIGHTS.balanced);
  });
});

describe("computeRouteScore", () => {
  const w = { quality: 1, cost: 0, latency: 0 };

  it("pure-quality weights scale linearly with normalized quality", () => {
    const low = computeRouteScore(1, 0, 0, w);
    const mid = computeRouteScore(3, 0, 0, w);
    const high = computeRouteScore(5, 0, 0, w);
    expect(low).toBeCloseTo(0, 5);
    expect(mid).toBeCloseTo(0.5, 5);
    expect(high).toBeCloseTo(1, 5);
  });

  it("pure-cost weights prefer cheaper models", () => {
    const costOnly = { quality: 0, cost: 1, latency: 0 };
    const cheap = computeRouteScore(3, 1, 0, costOnly);
    const pricey = computeRouteScore(3, 100, 0, costOnly);
    expect(cheap).toBeGreaterThan(pricey);
  });

  it("pure-latency weights prefer faster responses", () => {
    const latOnly = { quality: 0, cost: 0, latency: 1 };
    const fast = computeRouteScore(3, 10, 100, latOnly);
    const slow = computeRouteScore(3, 10, 5000, latOnly);
    expect(fast).toBeGreaterThan(slow);
  });
});

describe("pickExploration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const candidates: RouteTarget[] = [
    { provider: "openai", model: "gpt-4o" },
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "google", model: "gemini-2.5-pro" },
  ];
  const available = new Set(["openai", "anthropic", "google"]);

  it("returns null when random draw >= exploration rate", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(pickExploration(candidates, available)).toBeNull();
  });

  it("returns a random candidate when draw < exploration rate", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.0).mockReturnValueOnce(0.0);
    const pick = pickExploration(candidates, available);
    expect(pick).toEqual(candidates[0]);
  });

  it("returns null when only one candidate is eligible (no choice to make)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const only = [candidates[0]];
    expect(pickExploration(only, available)).toBeNull();
  });

  it("filters out candidates whose provider isn't available", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.0).mockReturnValueOnce(0.99);
    const onlyOpenAI = new Set(["openai"]);
    // 3 candidates but only 1 available → not eligible for exploration
    expect(pickExploration(candidates, onlyOpenAI)).toBeNull();
  });
});
