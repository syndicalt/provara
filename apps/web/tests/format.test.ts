import { describe, it, expect } from "vitest";
import { formatCost, formatLatency, formatNumber, formatTokens } from "../src/lib/format";

describe("formatCost", () => {
  it("6-decimal for micro amounts", () => {
    expect(formatCost(0.000123)).toBe("$0.000123");
  });
  it("4-decimal under a dollar", () => {
    expect(formatCost(0.5)).toBe("$0.5000");
  });
  it("2-decimal for dollars and up", () => {
    expect(formatCost(12.34567)).toBe("$12.35");
  });
});

describe("formatLatency", () => {
  it("milliseconds under 1000", () => {
    expect(formatLatency(250)).toBe("250ms");
  });
  it("rounds ms", () => {
    expect(formatLatency(999.7)).toBe("1000ms");
  });
  it("seconds at 1s+", () => {
    expect(formatLatency(1500)).toBe("1.5s");
  });
});

describe("formatTokens", () => {
  it("raw under 1000", () => {
    expect(formatTokens(42)).toBe("42");
  });
  it("K for thousands", () => {
    expect(formatTokens(2500)).toBe("2.5K");
  });
  it("M for millions", () => {
    expect(formatTokens(3_400_000)).toBe("3.4M");
  });
});

describe("formatNumber", () => {
  it("adds thousand separators", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});
