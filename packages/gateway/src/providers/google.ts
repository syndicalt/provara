import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Provider, CompletionRequest, CompletionResponse, StreamChunk, ChatMessage } from "./types.js";
import { messageText } from "./types.js";
import { nanoid } from "nanoid";

type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

function toGoogleParts(content: ChatMessage["content"]): GooglePart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map<GooglePart>((part) => {
    if (part.type === "text") return { text: part.text };
    const url = part.image_url.url;
    const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) {
      return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
    }
    // Gemini's fileData expects a URI it can fetch (typically a Files API
    // handle); pass through and let the upstream reject if unsupported.
    return { fileData: { mimeType: "image/*", fileUri: url } };
  });
}

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
        ...(systemMessage && { systemInstruction: messageText(systemMessage) }),
      });

      const contents = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: toGoogleParts(m.content),
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
        ...(systemMessage && { systemInstruction: messageText(systemMessage) }),
      });

      const contents = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: toGoogleParts(m.content),
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
