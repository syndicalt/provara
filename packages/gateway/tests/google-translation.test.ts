import { describe, it, expect } from "vitest";
import {
  toGoogleTools,
  toGoogleToolConfig,
  toGoogleContents,
  mapGoogleFinishReason,
} from "../src/providers/google.js";
import type { ChatMessage, ToolDefinition } from "../src/providers/types.js";

const weatherTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

describe("#300 google tool translation", () => {
  describe("toGoogleTools", () => {
    it("maps OpenAI tool shape to Google functionDeclarations in a single tools entry", () => {
      const out = toGoogleTools([weatherTool]);
      expect(out).toHaveLength(1);
      expect(out?.[0].functionDeclarations).toHaveLength(1);
      expect(out?.[0].functionDeclarations[0].name).toBe("get_weather");
      expect(out?.[0].functionDeclarations[0].parameters).toEqual({
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      });
    });

    it("strips JSON Schema fields Google does not accept", () => {
      const tool: ToolDefinition = {
        type: "function",
        function: {
          name: "strip_test",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            $id: "https://example.com/foo.json",
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "string" },
              y: { oneOf: [{ type: "string" }, { type: "number" }] },
            },
          },
        },
      };
      const out = toGoogleTools([tool]);
      const params = out?.[0].functionDeclarations[0].parameters as Record<string, unknown>;
      expect(params.$schema).toBeUndefined();
      expect(params.$id).toBeUndefined();
      expect(params.additionalProperties).toBeUndefined();
      const yProp = (params.properties as Record<string, Record<string, unknown>>).y;
      expect(yProp.oneOf).toBeUndefined();
      // Other fields preserved
      expect(params.type).toBe("object");
      expect((params.properties as Record<string, Record<string, unknown>>).x).toEqual({ type: "string" });
    });

    it("returns undefined for empty or missing tool arrays", () => {
      expect(toGoogleTools(undefined)).toBeUndefined();
      expect(toGoogleTools([])).toBeUndefined();
    });
  });

  describe("toGoogleToolConfig", () => {
    it("maps the vocabulary words", () => {
      expect(toGoogleToolConfig("auto")).toEqual({ functionCallingConfig: { mode: "AUTO" } });
      expect(toGoogleToolConfig("none")).toEqual({ functionCallingConfig: { mode: "NONE" } });
      expect(toGoogleToolConfig("required")).toEqual({ functionCallingConfig: { mode: "ANY" } });
    });

    it("maps specific-tool to ANY + allowedFunctionNames", () => {
      expect(
        toGoogleToolConfig({ type: "function", function: { name: "get_weather" } }),
      ).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
      });
    });

    it("returns undefined for missing tool_choice", () => {
      expect(toGoogleToolConfig(undefined)).toBeUndefined();
    });
  });

  describe("toGoogleContents", () => {
    it("filters out system messages (handled separately via systemInstruction)", () => {
      const msgs: ChatMessage[] = [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
      ];
      const out = toGoogleContents(msgs);
      expect(out).toHaveLength(1);
      expect(out[0].role).toBe("user");
    });

    it("maps assistant role to model (Gemini's naming)", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hi there" },
      ];
      const out = toGoogleContents(msgs);
      expect(out[1].role).toBe("model");
    });

    it("converts assistant tool_calls into a model message with functionCall parts", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      ];
      const out = toGoogleContents(msgs);
      expect(out[1].role).toBe("model");
      expect(out[1].parts[0]).toEqual({ text: "let me check" });
      expect(out[1].parts[1]).toEqual({
        functionCall: { name: "get_weather", args: { city: "SF" } },
      });
    });

    it("converts role:tool messages into user messages with functionResponse parts (name recovered via lookup)", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "weather in SF?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_weather_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
        {
          role: "tool",
          content: '{"temperature":72}',
          tool_call_id: "call_weather_1",
        },
      ];
      const out = toGoogleContents(msgs);
      // user → model → user (function response)
      expect(out).toHaveLength(3);
      expect(out[2].role).toBe("user");
      expect(out[2].parts[0]).toEqual({
        functionResponse: {
          name: "get_weather",
          response: { temperature: 72 },
        },
      });
    });

    it("merges consecutive tool messages with different ids into one user message (parallel results)", () => {
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "a", type: "function", function: { name: "tool_a", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "tool_b", arguments: "{}" } },
          ],
        },
        { role: "tool", content: '{"x":1}', tool_call_id: "a" },
        { role: "tool", content: '{"y":2}', tool_call_id: "b" },
      ];
      const out = toGoogleContents(msgs);
      // model message + one user message carrying both function responses
      expect(out).toHaveLength(2);
      expect(out[1].parts).toHaveLength(2);
    });

    it("wraps non-object tool content as {result: ...} for the functionResponse", () => {
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c", type: "function", function: { name: "tool_c", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "just a plain string", tool_call_id: "c" },
      ];
      const out = toGoogleContents(msgs);
      expect(out[1].parts[0]).toEqual({
        functionResponse: {
          name: "tool_c",
          response: { result: "just a plain string" },
        },
      });
    });

    it("skips role:tool messages when no matching assistant tool_call can be found", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "tool", content: "orphan", tool_call_id: "never_issued" },
      ];
      const out = toGoogleContents(msgs);
      expect(out).toHaveLength(1);
      expect(out[0].role).toBe("user");
    });
  });

  describe("mapGoogleFinishReason", () => {
    it("maps core Gemini finishReasons to OpenAI finish_reason", () => {
      expect(mapGoogleFinishReason("STOP", false)).toBe("stop");
      expect(mapGoogleFinishReason("MAX_TOKENS", false)).toBe("length");
      expect(mapGoogleFinishReason("SAFETY", false)).toBe("content_filter");
      expect(mapGoogleFinishReason("PROHIBITED_CONTENT", false)).toBe("content_filter");
    });

    it("overrides to tool_calls whenever the response contained function calls", () => {
      expect(mapGoogleFinishReason("STOP", true)).toBe("tool_calls");
      expect(mapGoogleFinishReason("MAX_TOKENS", true)).toBe("tool_calls");
    });

    it("treats MALFORMED_FUNCTION_CALL as tool_calls (the attempt was made)", () => {
      expect(mapGoogleFinishReason("MALFORMED_FUNCTION_CALL", false)).toBe("tool_calls");
    });

    it("returns undefined for unknown / missing reasons without tool calls", () => {
      expect(mapGoogleFinishReason(undefined, false)).toBeUndefined();
      expect(mapGoogleFinishReason(null, false)).toBeUndefined();
      expect(mapGoogleFinishReason("FUTURE_REASON_WE_DO_NOT_KNOW", false)).toBeUndefined();
    });
  });
});
