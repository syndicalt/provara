import type { ChatMessage } from "../providers/types.js";
import { messageText } from "../providers/types.js";
import type { Complexity, ClassificationResult } from "./types.js";

const CONFIDENCE_THRESHOLD = 0.6;

// Content-based complexity signals
const MEDIUM_INDICATORS = [
  "compare", "contrast", "tradeoffs", "trade-offs", "tradeoff", "trade-off",
  "pros and cons", "advantages and disadvantages",
  "explain how", "explain why", "describe how",
  "step by step", "walkthrough", "tutorial",
  "best practices", "guidelines", "recommendations",
  "key points", "3-page", "multi-page", "document",
  "enterprise", "large-scale", "real-world",
  // Structural code changes (moderate scope, not trivial)
  "refactor", "refactoring", "port this", "migrate this",
  // Medium-depth summarization / research reading
  "research paper", "academic paper", "peer-reviewed", "abstract and conclusion",
  "main claims", "key findings", "critical analysis", "literature review",
  // Creative complexity — world-building, genre, setting
  "story", "narrative", "chapter",
  "set on", "set in", "takes place",
  "noir", "detective", "mystery", "thriller",
  "space station", "dystopian", "post-apocalyptic",
  "multiple characters", "plot twist",
];

const COMPLEX_INDICATORS = [
  // Multi-part tasks
  "with", "including", "as well as", "along with",
  // Deep technical concepts
  "optimize", "optimization", "architecture", "distributed",
  "concurrent", "parallel", "async", "synchronization",
  "b-tree", "b+ tree", "red-black tree", "graph", "dynamic programming",
  "machine learning", "neural network", "transformer",
  "cryptography", "encryption", "authentication",
  "microservice", "kubernetes", "scalability",
  "compiler", "parser", "interpreter", "garbage collector",
  "database design", "schema design", "normalization",
  "proof", "theorem", "mathematical", "derivation",
  // Distributed systems & messaging (#293 UAT miss: "sharded queue with
  // exactly once semantics and backpressure" landed as simple because none
  // of these domain terms were in the list).
  "sharded", "sharding", "partitioning", "replication",
  "exactly once", "exactly-once", "at-least-once", "at least once",
  "idempotent", "backpressure", "eventual consistency", "strong consistency",
  "consensus", "paxos", "quorum", "leader election",
  "two-phase commit", "saga pattern", "service mesh", "circuit breaker",
  // Databases (beyond the generic "database design")
  "mvcc", "isolation level", "serializable isolation", "read committed",
  "write-ahead log", "lsm tree", "query planner", "query optimizer",
  "columnar", "olap", "oltp", "schema migration",
  // Concurrency internals
  "race condition", "deadlock", "lock-free", "wait-free",
  "compare-and-swap", "actor model", "work stealing",
  // ML / vector search (#293 UAT miss: "HNSW over IVF" landed as simple)
  "hnsw", "ivf", "vector search", "vector database",
  "embeddings", "fine-tune", "fine-tuning", "quantization",
  "gradient descent", "backpropagation", "self-attention",
  "attention mechanism", "retrieval-augmented", "lora adapter",
  "approximate nearest neighbor",
  // Security / identity
  "mtls", "zero-knowledge proof", "hmac", "saml sso", "oidc",
  // Scope indicators
  "full", "complete", "comprehensive", "production",
  "end-to-end", "from scratch", "entire", "whole system",
  "design and implement", "build a", "create a complete",
];

const SIMPLE_INDICATORS = [
  "hello", "hi ", "hey ", "thanks", "thank you",
  "yes", "no", "ok", "sure",
  "one word", "one sentence", "briefly",
  "simple", "basic", "easy", "trivial",
  "just", "only", "single",
];

const MULTI_TASK_PATTERNS = [
  /\b(?:insertion|deletion|update|search|traversal)\b.*\b(?:insertion|deletion|update|search|traversal)\b/i,
  /\b(?:create|read|update|delete)\b.*\b(?:create|read|update|delete)\b/i,
  /\bwith\b.+\band\b.+\band\b/i,  // "with X and Y and Z"
];

interface ComplexitySignals {
  tokenEstimate: number;
  messageCount: number;
  userMessageCount: number;
  hasMultiTurn: boolean;
  hasStructuredData: boolean;
  hasMultipleInstructions: boolean;
  codeBlockCount: number;
  averageMessageLength: number;
  complexIndicatorCount: number;
  mediumIndicatorCount: number;
  simpleIndicatorCount: number;
  hasMultiTaskPattern: boolean;
  wordCount: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function gatherSignals(messages: ChatMessage[]): ComplexitySignals {
  const allText = messages.map(messageText).join("\n");
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMsg = userMessages[userMessages.length - 1];
  const lastUserMessage = lastUserMsg ? messageText(lastUserMsg) : "";
  const lastLower = lastUserMessage.toLowerCase();

  const codeBlocks = allText.match(/```[\s\S]*?```/g);

  // Check for structured data
  const hasStructuredData =
    /\{[\s\S]*"[\w]+"[\s\S]*:/.test(lastUserMessage) ||
    /<\w+>[\s\S]*<\/\w+>/.test(lastUserMessage) ||
    /\|.*\|.*\|/.test(lastUserMessage) ||
    (lastUserMessage.match(/^\s*[-*]\s/gm)?.length || 0) > 3;

  // Check for multiple distinct instructions
  const instructionPatterns = /(?:^|\n)\s*(?:\d+[\.\)]\s|step\s+\d|first[,:]|second[,:]|then[,:]|next[,:]|finally[,:]|also[,:]|additionally)/gim;
  const instructionCount = lastUserMessage.match(instructionPatterns)?.length || 0;

  // Count complexity indicators
  let complexCount = 0;
  for (const indicator of COMPLEX_INDICATORS) {
    if (lastLower.includes(indicator)) complexCount++;
  }

  let mediumCount = 0;
  for (const indicator of MEDIUM_INDICATORS) {
    if (lastLower.includes(indicator)) mediumCount++;
  }

  let simpleCount = 0;
  for (const indicator of SIMPLE_INDICATORS) {
    if (lastLower.includes(indicator)) simpleCount++;
  }

  // Check for multi-task patterns
  const hasMultiTaskPattern = MULTI_TASK_PATTERNS.some((p) => p.test(lastUserMessage));

  const wordCount = lastUserMessage.split(/\s+/).filter(Boolean).length;

  return {
    tokenEstimate: estimateTokens(allText),
    messageCount: messages.length,
    userMessageCount: userMessages.length,
    hasMultiTurn: userMessages.length > 2,
    hasStructuredData,
    hasMultipleInstructions: instructionCount >= 3,
    codeBlockCount: codeBlocks?.length || 0,
    averageMessageLength: allText.length / Math.max(messages.length, 1),
    complexIndicatorCount: complexCount,
    mediumIndicatorCount: mediumCount,
    simpleIndicatorCount: simpleCount,
    hasMultiTaskPattern,
    wordCount,
  };
}

function scoreComplexity(signals: ComplexitySignals): ClassificationResult<Complexity> {
  let score = 0; // 0-10 scale

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

  // Content-based complexity signals. Bumped from 3/2/1 to 4/3/1.5 so a
  // short-but-dense prompt ("how does HNSW work vs IVF") can actually reach
  // complex on jargon alone — previously capped at +3 which, combined with
  // the short-prompt token penalty, always landed such prompts in medium.
  if (signals.complexIndicatorCount >= 4) score += 4;
  else if (signals.complexIndicatorCount >= 2) score += 3;
  else if (signals.complexIndicatorCount >= 1) score += 1.5;

  // Domain-density boost: a short prompt with multiple jargon hits is a
  // domain-expert question that needs a capable model even though the
  // prose is brief. Prevents "HNSW vs IVF" (5 words, 2 jargon terms)
  // from being outvoted by the short-prompt word-count signal.
  if (signals.complexIndicatorCount >= 2 && signals.tokenEstimate < 50) {
    score += 1.5;
  }

  // Medium indicators
  if (signals.mediumIndicatorCount >= 3) score += 3;
  else if (signals.mediumIndicatorCount >= 2) score += 2.5;
  else if (signals.mediumIndicatorCount >= 1) score += 1.5;

  // Multi-task pattern (e.g. "insertion, deletion, and range queries")
  if (signals.hasMultiTaskPattern) score += 2;

  // Simple indicators push score down
  if (signals.simpleIndicatorCount >= 2) score -= 2;
  else if (signals.simpleIndicatorCount >= 1) score -= 1;

  // Word count signals. Short prompts get penalized to keep trivial "hi"
  // type questions out of medium — but only when they lack technical
  // jargon. "HNSW vs IVF" is 5 words and correctly deserves medium/complex
  // despite its length.
  if (signals.wordCount <= 5 && signals.complexIndicatorCount === 0) score -= 1;
  else if (signals.wordCount >= 15) score += 1;
  else if (signals.wordCount >= 10) score += 0.5;

  // Clamp
  score = Math.max(0, Math.min(10, score));

  // Map score to complexity
  let value: Complexity;
  let confidence: number;

  if (score <= 2) {
    value = "simple";
    confidence = Math.min(0.5 + (2 - score) * 0.15, 0.95);
  } else if (score <= 5) {
    value = "medium";
    const distFromCenter = Math.abs(score - 3.5);
    confidence = Math.max(0.5, 0.85 - distFromCenter * 0.15);
  } else {
    value = "complex";
    confidence = Math.min(0.5 + (score - 5) * 0.1, 0.95);
  }

  // Boundary ambiguity
  const nearBoundary = Math.abs(score - 2) < 0.8 || Math.abs(score - 5) < 0.8;
  const ambiguous = confidence < CONFIDENCE_THRESHOLD || nearBoundary;

  return { value, confidence, ambiguous };
}

export function classifyComplexity(messages: ChatMessage[]): ClassificationResult<Complexity> {
  return scoreComplexity(gatherSignals(messages));
}
