import { describe, it, expect } from "vitest";
import {
  toAnthropicTools,
  toAnthropicToolChoice,
  toAnthropicMessages,
  mapStopReason,
} from "../src/providers/anthropic.js";
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

describe("#299 anthropic tool translation", () => {
  describe("toAnthropicTools", () => {
    it("maps OpenAI tool shape to Anthropic Tool[]", () => {
      const out = toAnthropicTools([weatherTool]);
      expect(out).toHaveLength(1);
      expect(out?.[0].name).toBe("get_weather");
      expect(out?.[0].description).toBe("Get current weather for a city");
      expect(out?.[0].input_schema).toEqual({
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      });
    });

    it("returns undefined for empty or missing tool arrays", () => {
      expect(toAnthropicTools(undefined)).toBeUndefined();
      expect(toAnthropicTools([])).toBeUndefined();
    });

    it("supplies a default input_schema when parameters are omitted", () => {
      const toolNoParams: ToolDefinition = {
        type: "function",
        function: { name: "ping" },
      };
      const out = toAnthropicTools([toolNoParams]);
      expect(out?.[0].input_schema).toEqual({ type: "object", properties: {} });
    });
  });

  describe("toAnthropicToolChoice", () => {
    it("maps the vocabulary words", () => {
      expect(toAnthropicToolChoice("auto")).toEqual({ type: "auto" });
      expect(toAnthropicToolChoice("none")).toEqual({ type: "none" });
      expect(toAnthropicToolChoice("required")).toEqual({ type: "any" });
    });

    it("maps the specific-tool shape", () => {
      expect(
        toAnthropicToolChoice({
          type: "function",
          function: { name: "get_weather" },
        }),
      ).toEqual({ type: "tool", name: "get_weather" });
    });

    it("returns undefined for missing tool_choice", () => {
      expect(toAnthropicToolChoice(undefined)).toBeUndefined();
    });
  });

  describe("toAnthropicMessages", () => {
    it("filters out system messages (handled via `system` param)", () => {
      const msgs: ChatMessage[] = [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ];
      const out = toAnthropicMessages(msgs);
      expect(out).toHaveLength(1);
      expect(out[0].role).toBe("user");
    });

    it("converts assistant tool_calls into an assistant message with tool_use blocks", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "what is the weather?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      ];
      const out = toAnthropicMessages(msgs);
      expect(out).toHaveLength(2);
      const assistantContent = out[1].content as Array<Record<string, unknown>>;
      expect(assistantContent[0]).toEqual({ type: "text", text: "Let me check." });
      expect(assistantContent[1]).toEqual({
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "SF" },
      });
    });

    it("converts role:tool messages into user messages with tool_result blocks", () => {
      const msgs: ChatMessage[] = [
        {
          role: "tool",
          content: '{"temperature":72}',
          tool_call_id: "call_1",
        },
      ];
      const out = toAnthropicMessages(msgs);
      expect(out).toHaveLength(1);
      expect(out[0].role).toBe("user");
      expect(out[0].content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: '{"temperature":72}',
        },
      ]);
    });

    it("merges consecutive role:tool messages into a single user message (parallel tool calls)", () => {
      const msgs: ChatMessage[] = [
        { role: "tool", content: '{"a":1}', tool_call_id: "call_a" },
        { role: "tool", content: '{"b":2}', tool_call_id: "call_b" },
      ];
      const out = toAnthropicMessages(msgs);
      expect(out).toHaveLength(1);
      expect((out[0].content as unknown[]).length).toBe(2);
    });

    it("survives malformed JSON in tool_calls arguments (passes empty object downstream)", () => {
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: null as unknown as string,
          tool_calls: [
            {
              id: "call_bad",
              type: "function",
              function: { name: "broken", arguments: "{not json" },
            },
          ],
        },
      ];
      const out = toAnthropicMessages(msgs);
      const blocks = out[0].content as Array<Record<string, unknown>>;
      const toolUse = blocks.find((b) => b.type === "tool_use") as {
        type: "tool_use";
        input: unknown;
      };
      expect(toolUse.input).toEqual({});
    });
  });

  describe("mapStopReason", () => {
    it("maps Anthropic stop_reason values to OpenAI finish_reason", () => {
      expect(mapStopReason("end_turn")).toBe("stop");
      expect(mapStopReason("stop_sequence")).toBe("stop");
      expect(mapStopReason("tool_use")).toBe("tool_calls");
      expect(mapStopReason("max_tokens")).toBe("length");
    });

    it("returns undefined for null / unknown", () => {
      expect(mapStopReason(null)).toBeUndefined();
      expect(mapStopReason(undefined)).toBeUndefined();
      expect(mapStopReason("unknown_reason")).toBeUndefined();
    });
  });
});
