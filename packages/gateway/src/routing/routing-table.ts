import type { RoutingTable } from "./types.js";

// Default routing table: task type × complexity → provider + model
// Optimizes for cost at simple tier, quality at complex tier
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  coding: {
    simple: {
      primary: { provider: "openai", model: "gpt-4.1-nano" },
      fallbacks: [
        { provider: "google", model: "gemini-2.5-flash" },
        { provider: "mistral", model: "mistral-small-latest" },
      ],
    },
    medium: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
    complex: {
      primary: { provider: "anthropic", model: "claude-opus-4-6" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
  },

  creative: {
    simple: {
      primary: { provider: "openai", model: "gpt-4.1-mini" },
      fallbacks: [
        { provider: "google", model: "gemini-2.5-flash" },
        { provider: "mistral", model: "mistral-small-latest" },
      ],
    },
    medium: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
      fallbacks: [
        { provider: "openai", model: "gpt-4o" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
    complex: {
      primary: { provider: "anthropic", model: "claude-opus-4-6" },
      fallbacks: [
        { provider: "openai", model: "gpt-4o" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
  },

  summarization: {
    simple: {
      primary: { provider: "google", model: "gemini-2.0-flash" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1-nano" },
        { provider: "mistral", model: "mistral-small-latest" },
      ],
    },
    medium: {
      primary: { provider: "google", model: "gemini-2.5-flash" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1-mini" },
        { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      ],
    },
    complex: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
  },

  qa: {
    simple: {
      primary: { provider: "google", model: "gemini-2.0-flash" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1-nano" },
        { provider: "mistral", model: "mistral-small-latest" },
      ],
    },
    medium: {
      primary: { provider: "openai", model: "gpt-4.1-mini" },
      fallbacks: [
        { provider: "google", model: "gemini-2.5-flash" },
        { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      ],
    },
    complex: {
      primary: { provider: "openai", model: "gpt-4.1" },
      fallbacks: [
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
  },

  general: {
    simple: {
      primary: { provider: "openai", model: "gpt-4.1-nano" },
      fallbacks: [
        { provider: "google", model: "gemini-2.0-flash" },
        { provider: "mistral", model: "mistral-small-latest" },
      ],
    },
    medium: {
      primary: { provider: "openai", model: "gpt-4.1-mini" },
      fallbacks: [
        { provider: "google", model: "gemini-2.5-flash" },
        { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      ],
    },
    complex: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
      fallbacks: [
        { provider: "openai", model: "gpt-4.1" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
    },
  },
};
