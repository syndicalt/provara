import { describe, it, expect } from "vitest";
import { modelSupportsTools, getModelCapability } from "../src/providers/capabilities.js";

describe("#301 provider capabilities", () => {
  describe("modelSupportsTools (provider defaults)", () => {
    it("returns true for modern tool-capable providers regardless of model id", () => {
      for (const p of ["openai", "anthropic", "google", "mistral", "xai", "zai"]) {
        expect(modelSupportsTools(p, "any-model-name")).toBe(true);
      }
    });

    it("is case-insensitive on provider", () => {
      expect(modelSupportsTools("OpenAI", "gpt-4.1-nano")).toBe(true);
      expect(modelSupportsTools("ANTHROPIC", "claude-sonnet-4-6")).toBe(true);
    });

    it("defaults true for unknown providers (no blocking on guess)", () => {
      expect(modelSupportsTools("some-custom-provider", "some-model")).toBe(true);
    });
  });

  describe("modelSupportsTools (ollama gate)", () => {
    it("allows llama3.1, llama3.2, qwen2.5, qwen3, mistral, mixtral, command-r, hermes3, granite3", () => {
      const allowed = [
        "llama3.1:8b",
        "llama3.2-vision",
        "qwen2.5:72b",
        "qwen3.6:latest",
        "mistral:7b",
        "mixtral:8x22b",
        "command-r:35b",
        "hermes3:latest",
        "granite3:dense",
      ];
      for (const m of allowed) {
        expect(modelSupportsTools("ollama", m)).toBe(true);
      }
    });

    it("rejects ollama models without a recognized tool-capable base", () => {
      const rejected = [
        "gemma:7b",
        "phi3:latest",
        "codellama:13b",
        "tinyllama:1.1b",
        "orca-mini:7b",
      ];
      for (const m of rejected) {
        expect(modelSupportsTools("ollama", m)).toBe(false);
      }
    });

    it("is case-insensitive on model name", () => {
      expect(modelSupportsTools("ollama", "Qwen3.6:LATEST")).toBe(true);
      expect(modelSupportsTools("ollama", "GEMMA:7b")).toBe(false);
    });
  });

  describe("getModelCapability", () => {
    it("returns the shape expected by the /v1/models/stats route", () => {
      expect(getModelCapability("openai", "gpt-4.1-nano")).toEqual({
        supportsTools: true,
      });
      expect(getModelCapability("ollama", "gemma:7b")).toEqual({
        supportsTools: false,
      });
    });
  });
});
