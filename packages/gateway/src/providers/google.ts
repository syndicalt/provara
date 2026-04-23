import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
  ToolCall,
  FinishReason,
} from "./types.js";
import { messageText } from "./types.js";
import { nanoid } from "nanoid";

type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

function toGoogleParts(content: ChatMessage["content"]): GooglePart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map<GooglePart>((part) => {
    if (part.type === "text") return { text: part.text };
    const url = part.image_url.url;
    const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) {
      return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
    }
    return { fileData: { mimeType: "image/*", fileUri: url } };
  });
}

/** JSON Schema fields Google's generative API rejects. The upstream Schema
 *  type is an OpenAPI 3.0 subset — keeping the accept list small here avoids
 *  opaque 400s at the SDK boundary. */
const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "additionalProperties",
  "patternProperties",
  "if",
  "then",
  "else",
]);

function stripSchemaForGoogle(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripSchemaForGoogle);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (STRIPPED_SCHEMA_KEYS.has(k)) continue;
    out[k] = stripSchemaForGoogle(v);
  }
  return out;
}

/** OpenAI tools → Google `tools: [{functionDeclarations: [...]}]`. One tool
 *  entry per call — the Google SDK lets a tools entry group multiple function
 *  declarations, and we pack them all into a single entry for simplicity. */
export function toGoogleTools(
  tools: ToolDefinition[] | undefined,
): Array<{ functionDeclarations: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const declarations = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
      ? (stripSchemaForGoogle(t.function.parameters) as Record<string, unknown>)
      : undefined,
  }));
  return [{ functionDeclarations: declarations }];
}

/** OpenAI tool_choice → Google toolConfig. Mapping:
 *   "none"     → mode: NONE
 *   "auto"     → mode: AUTO
 *   "required" → mode: ANY
 *   {function} → mode: ANY + allowedFunctionNames: [name]
 */
export function toGoogleToolConfig(
  choice: ToolChoice | undefined,
): { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } } | undefined {
  if (choice === undefined) return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof choice === "object" && choice.type === "function") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [choice.function.name],
      },
    };
  }
  return undefined;
}

/** Walk prior messages to find the function name associated with a tool_call_id.
 *  Google's functionResponse is keyed by name, not id, so we recover the name
 *  from the assistant message that produced the matching tool_call. */
function findToolCallName(
  messages: ChatMessage[],
  upToIndex: number,
  toolCallId: string | undefined,
): string | undefined {
  if (!toolCallId) return undefined;
  for (let i = upToIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      const match = msg.tool_calls.find((tc) => tc.id === toolCallId);
      if (match) return match.function.name;
    }
  }
  return undefined;
}

/** Build the Google `contents` array from an OpenAI ChatMessage sequence.
 *  - System messages handled separately via `systemInstruction`.
 *  - `role: "tool"` becomes a user message with a `functionResponse` part.
 *    Consecutive tool results merge into a single user message.
 *  - Assistant with `tool_calls` becomes a `model` message with one
 *    `functionCall` part per tool call (plus a text part if content is
 *    non-empty).
 */
export function toGoogleContents(
  messages: ChatMessage[],
): Array<{ role: "user" | "model"; parts: GooglePart[] }> {
  const out: Array<{ role: "user" | "model"; parts: GooglePart[] }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      const name = findToolCallName(messages, i, msg.tool_call_id);
      if (!name) continue; // cannot translate without a name; skip silently
      const content = typeof msg.content === "string" ? msg.content : "";
      let responseObj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(content);
        responseObj =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { result: parsed };
      } catch {
        responseObj = { result: content };
      }
      const part: GooglePart = {
        functionResponse: { name, response: responseObj },
      };
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.role === "user" &&
        prev.parts.every((p) => "functionResponse" in p)
      ) {
        prev.parts.push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const parts: GooglePart[] = [];
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("")
            : "";
      if (text) parts.push({ text });
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      out.push({ role: "model", parts });
      continue;
    }

    out.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: toGoogleParts(msg.content),
    });
  }
  return out;
}

export function mapGoogleFinishReason(
  reason: string | undefined | null,
  hasToolCalls: boolean,
): FinishReason | undefined {
  if (hasToolCalls) return "tool_calls";
  if (!reason) return undefined;
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
      // Treat as tool_calls so the client knows tools were attempted; a
      // malformed call upstream is still closer to "tool_calls" than "stop".
      return "tool_calls";
    default:
      return undefined;
  }
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
        const res = await fetch(`${GOOGLE_API_BASE}/models?key=${key}&pageSize=100`);
        if (!res.ok) return provider.models;
        const data = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
        const chatModels: string[] = [];
        for (const m of data.models || []) {
          if (m.supportedGenerationMethods?.includes("generateContent")) {
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
      const tools = toGoogleTools(request.tools);
      const toolConfig = toGoogleToolConfig(request.tool_choice);

      // Our ad-hoc tools / toolConfig shape is structurally compatible with
      // the SDK's ModelParams but doesn't satisfy its nominal types. Cast at
      // the SDK boundary (same pattern as anthropic.ts).
      const model = genAI.getGenerativeModel({
        model: request.model,
        ...(systemMessage && { systemInstruction: messageText(systemMessage) }),
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const contents = toGoogleContents(request.messages);

      // The SDK's type for getGenerativeModel is stricter than our ad-hoc
      // tools / toolConfig shape; cast at the SDK boundary for the same
      // reason as anthropic.ts — the underlying runtime validates.
      const result = await model.generateContent({ contents });
      const response = result.response;
      const latencyMs = Math.round(performance.now() - start);

      // Walk parts: collect text, collect functionCalls separately. Google
      // doesn't emit tool-call ids, so we synthesize a stable one per call.
      const toolCalls: ToolCall[] = [];
      let content = "";
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if ("text" in part && typeof part.text === "string") {
          content += part.text;
        } else if ("functionCall" in part && part.functionCall) {
          toolCalls.push({
            id: `call_${nanoid(10)}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
        }
      }

      const rawFinishReason = response.candidates?.[0]?.finishReason as string | undefined;

      return {
        id: nanoid(),
        provider: "google",
        model: request.model,
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: mapGoogleFinishReason(rawFinishReason, toolCalls.length > 0),
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
        latencyMs,
      };
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const systemMessage = request.messages.find((m) => m.role === "system");
      const tools = toGoogleTools(request.tools);
      const toolConfig = toGoogleToolConfig(request.tool_choice);

      // Our ad-hoc tools / toolConfig shape is structurally compatible with
      // the SDK's ModelParams but doesn't satisfy its nominal types. Cast at
      // the SDK boundary (same pattern as anthropic.ts).
      const model = genAI.getGenerativeModel({
        model: request.model,
        ...(systemMessage && { systemInstruction: messageText(systemMessage) }),
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const contents = toGoogleContents(request.messages);
      const result = await model.generateContentStream({ contents });

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastFinishReason: string | undefined;
      // Google emits each functionCall whole per chunk rather than delta-by-
      // delta. Track emitted (name, args) pairs to avoid duplicates if the
      // same call appears in the final aggregated response + a stream chunk.
      const emittedCallKeys = new Set<string>();
      let nextToolCallIndex = 0;
      let sawToolCall = false;

      for await (const chunk of result.stream) {
        if (chunk.usageMetadata) {
          totalInputTokens = chunk.usageMetadata.promptTokenCount || 0;
          totalOutputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
        lastFinishReason = chunk.candidates?.[0]?.finishReason ?? lastFinishReason;

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        let textThisChunk = "";
        const toolCallDeltas: Array<{
          index: number;
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }> = [];
        for (const part of parts) {
          if ("text" in part && typeof part.text === "string") {
            textThisChunk += part.text;
          } else if ("functionCall" in part && part.functionCall) {
            const args = JSON.stringify(part.functionCall.args ?? {});
            const key = `${part.functionCall.name}::${args}`;
            if (emittedCallKeys.has(key)) continue;
            emittedCallKeys.add(key);
            sawToolCall = true;
            toolCallDeltas.push({
              index: nextToolCallIndex++,
              id: `call_${nanoid(10)}`,
              type: "function",
              function: { name: part.functionCall.name, arguments: args },
            });
          }
        }

        if (textThisChunk || toolCallDeltas.length > 0) {
          yield {
            content: textThisChunk,
            done: false,
            tool_calls: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
          };
        }
      }

      yield {
        content: "",
        done: true,
        finish_reason: mapGoogleFinishReason(lastFinishReason, sawToolCall),
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    },
  };

  return provider;
}
