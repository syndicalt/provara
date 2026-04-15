import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk } from "./types.js";
import { nanoid } from "nanoid";

export function createGoogleProvider(apiKey?: string): Provider {
  const genAI = new GoogleGenerativeAI(apiKey || process.env.GOOGLE_API_KEY || "");

  return {
    name: "google",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],

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
}
