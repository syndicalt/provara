import type { ChatMessage, ToolCall, ToolDefinition } from "../providers/types.js";
import { messageText } from "../providers/types.js";

export type ToolCallAlignmentDecision = "allow" | "flag" | "block";

export interface ToolCallAlignmentViolation {
  code:
    | "unknown_tool"
    | "invalid_arguments"
    | "suspicious_arguments"
    | "intent_mismatch";
  toolName: string;
  action: Exclude<ToolCallAlignmentDecision, "allow">;
  reason: string;
  matchedSnippet: string;
}

export interface ToolCallAlignmentResult {
  passed: boolean;
  decision: ToolCallAlignmentDecision;
  violations: ToolCallAlignmentViolation[];
}

const SUSPICIOUS_ARGUMENT_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "instruction_override", pattern: /\b(ignore|bypass|override|forget|disregard)\b.{0,80}\b(instructions?|system|developer|policy|guardrails?)\b/i },
  { code: "prompt_exfiltration", pattern: /\b(system prompt|developer message|hidden instructions?|internal instructions?|policy)\b/i },
  { code: "secret_exfiltration", pattern: /\b(api[_ -]?key|secret|token|password|credential|private[_ -]?key|env(?:ironment)? variable)\b/i },
  { code: "data_exfiltration", pattern: /\b(exfiltrate|leak|send|post|upload|forward)\b.{0,80}\b(webhook|url|http|https|external|attacker)\b/i },
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "get",
  "give",
  "in",
  "is",
  "me",
  "of",
  "on",
  "or",
  "please",
  "the",
  "to",
  "use",
  "what",
  "with",
]);

function textTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function flattenJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenJson).join(" ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key} ${flattenJson(nested)}`)
      .join(" ");
  }
  return "";
}

function lastUserIntent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messageText(messages[i]);
  }
  return "";
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count++;
  }
  return count;
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function checkToolCallAlignment(input: {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolCalls?: ToolCall[];
}): ToolCallAlignmentResult {
  const toolCalls = input.toolCalls ?? [];
  if (toolCalls.length === 0) return { passed: true, decision: "allow", violations: [] };

  const toolDefinitions = new Map(
    (input.tools ?? []).map((tool) => [tool.function.name, tool]),
  );
  const userIntent = lastUserIntent(input.messages);
  const userTokens = textTokens(userIntent);
  const violations: ToolCallAlignmentViolation[] = [];

  for (const call of toolCalls) {
    const toolName = call.function.name;
    const tool = toolDefinitions.get(toolName);
    if (!tool) {
      violations.push({
        code: "unknown_tool",
        toolName,
        action: "block",
        reason: `Model requested undeclared tool "${toolName}".`,
        matchedSnippet: toolName,
      });
      continue;
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = call.function.arguments.trim().length > 0
        ? JSON.parse(call.function.arguments)
        : {};
    } catch {
      violations.push({
        code: "invalid_arguments",
        toolName,
        action: "block",
        reason: `Model requested tool "${toolName}" with invalid JSON arguments.`,
        matchedSnippet: snippet(call.function.arguments),
      });
      continue;
    }

    const argumentText = flattenJson(parsedArguments);
    for (const suspicious of SUSPICIOUS_ARGUMENT_PATTERNS) {
      const match = argumentText.match(suspicious.pattern);
      if (match) {
        violations.push({
          code: "suspicious_arguments",
          toolName,
          action: "block",
          reason: `Tool arguments match prompt-injection risk: ${suspicious.code}.`,
          matchedSnippet: snippet(match[0]),
        });
      }
    }

    const toolText = [
      tool.function.name,
      tool.function.description ?? "",
      argumentText,
    ].join(" ");
    const toolTokens = textTokens(toolText);
    const toolNameTokens = textTokens(tool.function.name.replace(/_/g, " "));
    const hasIntentOverlap =
      overlapCount(userTokens, toolTokens) > 0 ||
      overlapCount(userTokens, toolNameTokens) > 0;

    if (userTokens.size > 0 && toolTokens.size > 0 && !hasIntentOverlap) {
      violations.push({
        code: "intent_mismatch",
        toolName,
        action: "flag",
        reason: `Tool "${toolName}" has no obvious lexical overlap with the latest user request.`,
        matchedSnippet: snippet(`${userIntent} -> ${toolName} ${argumentText}`),
      });
    }
  }

  const decision = violations.some((v) => v.action === "block")
    ? "block"
    : violations.length > 0
      ? "flag"
      : "allow";

  return {
    passed: decision !== "block",
    decision,
    violations,
  };
}
