import type { ChatMessage } from "../providers/types.js";
import type { Complexity, ClassificationResult } from "./types.js";

const CONFIDENCE_THRESHOLD = 0.6;

interface ComplexitySignals {
  tokenEstimate: number;
  messageCount: number;
  userMessageCount: number;
  hasMultiTurn: boolean;
  hasStructuredData: boolean;
  hasMultipleInstructions: boolean;
  codeBlockCount: number;
  averageMessageLength: number;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

function gatherSignals(messages: ChatMessage[]): ComplexitySignals {
  const allText = messages.map((m) => m.content).join("\n");
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

  const codeBlocks = allText.match(/```[\s\S]*?```/g);

  // Check for structured data (JSON, XML, tables, lists)
  const hasStructuredData =
    /\{[\s\S]*"[\w]+"[\s\S]*:/.test(lastUserMessage) || // JSON-like
    /<\w+>[\s\S]*<\/\w+>/.test(lastUserMessage) || // XML-like
    /\|.*\|.*\|/.test(lastUserMessage) || // Markdown tables
    (lastUserMessage.match(/^\s*[-*]\s/gm)?.length || 0) > 3; // Long bullet lists

  // Check for multiple distinct instructions
  const instructionPatterns = /(?:^|\n)\s*(?:\d+[\.\)]\s|step\s+\d|first[,:]|second[,:]|then[,:]|next[,:]|finally[,:]|also[,:]|additionally)/gim;
  const instructionCount = lastUserMessage.match(instructionPatterns)?.length || 0;

  return {
    tokenEstimate: estimateTokens(allText),
    messageCount: messages.length,
    userMessageCount: userMessages.length,
    hasMultiTurn: userMessages.length > 2,
    hasStructuredData,
    hasMultipleInstructions: instructionCount >= 3,
    codeBlockCount: codeBlocks?.length || 0,
    averageMessageLength: allText.length / Math.max(messages.length, 1),
  };
}

function scoreComplexity(signals: ComplexitySignals): ClassificationResult<Complexity> {
  let score = 0; // 0-10 scale, then mapped to simple/medium/complex

  // Token count scoring
  if (signals.tokenEstimate < 50) score += 0;
  else if (signals.tokenEstimate < 200) score += 1;
  else if (signals.tokenEstimate < 500) score += 2;
  else if (signals.tokenEstimate < 1500) score += 3;
  else score += 5;

  // Conversation depth
  if (signals.hasMultiTurn) score += 2;
  else if (signals.messageCount > 2) score += 1;

  // Structured data
  if (signals.hasStructuredData) score += 1.5;

  // Multiple instructions
  if (signals.hasMultipleInstructions) score += 2;

  // Code blocks
  if (signals.codeBlockCount > 2) score += 2;
  else if (signals.codeBlockCount > 0) score += 1;

  // Map score to complexity
  let value: Complexity;
  let confidence: number;

  if (score <= 2) {
    value = "simple";
    confidence = Math.min(0.5 + (2 - score) * 0.15, 0.95);
  } else if (score <= 5) {
    value = "medium";
    // Confidence is highest in the middle of the range, lower at boundaries
    const distFromCenter = Math.abs(score - 3.5);
    confidence = Math.max(0.5, 0.85 - distFromCenter * 0.15);
  } else {
    value = "complex";
    confidence = Math.min(0.5 + (score - 5) * 0.1, 0.95);
  }

  // Boundary ambiguity — scores near the thresholds are less certain
  const nearBoundary = Math.abs(score - 2) < 0.8 || Math.abs(score - 5) < 0.8;
  const ambiguous = confidence < CONFIDENCE_THRESHOLD || nearBoundary;

  return { value, confidence, ambiguous };
}

export function classifyComplexity(messages: ChatMessage[]): ClassificationResult<Complexity> {
  return scoreComplexity(gatherSignals(messages));
}
