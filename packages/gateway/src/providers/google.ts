import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function createGoogleProvider(apiKey?: string): Provider {
  const key = apiKey || process.env.GOOGLE_API_KEY || "";
  const genAI = new GoogleGenerativeAI(key);

  const provider: Provider = {
    name: "google",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],

    async listModels(): Promise<string[]> {
      try {
        // Google's JS SDK doesn't expose listModels, so use the REST API directly
        const res = await fetch(`${GOOGLE_API_BASE}/models?key=${key}&pageSize=100`);
        if (!res.ok) return provider.models;
        const data = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
        const chatModels: string[] = [];
        for (const m of data.models || []) {
          // Only include models that support generateContent (chat)
          if (m.supportedGenerationMethods?.includes("generateContent")) {
            // Model name is "models/gemini-2.5-pro" — strip the prefix
            chatModels.push(m.name.replace("models/", ""));
          }
        }
        if (chatModels.length > 0) {
          provider.models = chatModels;
        }
        return provider.models;
      } catch {
        return provider.models;
      }
    },

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const start = performance.now();

      const systemMessage = request.messages.find((m) => m.role === "system");
      const model = genAI.getGenerativeModel({
        model: request.model,
        ...(systemMessage && { systemInstruction: systemMessage.content }),
      });

      const contents = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const result = await model.generateContent({ contents });
      const response = result.response;
      const latencyMs = Math.round(performance.now() - start);

      return {
        id: nanoid(),
        provider: "google",
        model: request.model,
        content: response.text() || "",
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
        latencyMs,
      };
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const systemMessage = request.messages.find((m) => m.role === "system");
      const model = genAI.getGenerativeModel({
        model: request.model,
        ...(systemMessage && { systemInstruction: systemMessage.content }),
      });

      const contents = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const result = await model.generateContentStream({ contents });

      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for await (const chunk of result.stream) {
        const text = chunk.text() || "";
        if (chunk.usageMetadata) {
          totalInputTokens = chunk.usageMetadata.promptTokenCount || 0;
          totalOutputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
        yield { content: text, done: false };
      }

      yield {
        content: "",
        done: true,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    },
  };

  return provider;
}
