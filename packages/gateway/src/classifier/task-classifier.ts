import type { ChatMessage } from "../providers/types.js";
import type { TaskType, ClassificationResult } from "./types.js";

const CONFIDENCE_THRESHOLD = 0.6;

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;

const CODING_KEYWORDS = [
  "function", "class", "variable", "import", "export", "async", "await",
  "const", "let", "var", "return", "interface", "type", "enum",
  "debug", "error", "bug", "fix", "refactor", "implement", "api",
  "endpoint", "database", "query", "sql", "regex", "algorithm",
  "compile", "runtime", "typescript", "javascript", "python", "rust",
  "react", "node", "npm", "git", "docker", "deploy", "ci/cd",
  "test", "unit test", "integration test", "lint", "build",
  "stack trace", "exception", "null", "undefined", "segfault",
  "write code", "write a function", "write a script", "code review",
];

const CREATIVE_KEYWORDS = [
  "write a story", "write a poem", "creative writing", "fiction",
  "narrative", "character", "plot", "dialogue", "screenplay",
  "song lyrics", "haiku", "limerick", "metaphor", "imagery",
  "brainstorm ideas", "imagine", "fantasy", "sci-fi",
  "write me a", "compose", "draft a letter", "blog post",
  "essay", "article", "copywriting", "tagline", "slogan",
];

const SUMMARIZATION_KEYWORDS = [
  "summarize", "summary", "summarise", "tldr", "tl;dr",
  "key points", "main points", "brief overview", "condense",
  "recap", "digest", "outline the main", "boil down",
  "in a nutshell", "give me the gist", "shorten this",
];

const QA_KEYWORDS = [
  "what is", "what are", "who is", "who are", "when did", "when was",
  "where is", "where are", "how does", "how do", "how is",
  "why does", "why do", "why is", "explain", "describe",
  "define", "meaning of", "difference between", "compare",
  "tell me about", "what does", "is it true", "can you tell me",
];

interface Signal {
  taskType: TaskType;
  weight: number;
}

function collectSignals(messages: ChatMessage[]): Signal[] {
  const signals: Signal[] = [];
  const allText = messages.map((m) => m.content).join("\n").toLowerCase();
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() || "";
  const systemMessage = messages.find((m) => m.role === "system")?.content.toLowerCase() || "";

  // Code blocks are a strong signal
  const codeBlocks = allText.match(CODE_BLOCK_REGEX);
  if (codeBlocks && codeBlocks.length > 0) {
    signals.push({ taskType: "coding", weight: 0.4 + Math.min(codeBlocks.length * 0.1, 0.3) });
  }

  // Inline code references
  const inlineCode = allText.match(INLINE_CODE_REGEX);
  if (inlineCode && inlineCode.length > 2) {
    signals.push({ taskType: "coding", weight: 0.25 });
  }

  // System prompt hints
  if (systemMessage.includes("code") || systemMessage.includes("developer") || systemMessage.includes("programmer")) {
    signals.push({ taskType: "coding", weight: 0.3 });
  }
  if (systemMessage.includes("creative") || systemMessage.includes("writer") || systemMessage.includes("storyteller")) {
    signals.push({ taskType: "creative", weight: 0.3 });
  }

  // Keyword matching — weight by how many keywords match
  const keywordSets: [TaskType, string[]][] = [
    ["coding", CODING_KEYWORDS],
    ["creative", CREATIVE_KEYWORDS],
    ["summarization", SUMMARIZATION_KEYWORDS],
    ["qa", QA_KEYWORDS],
  ];

  for (const [taskType, keywords] of keywordSets) {
    const matchCount = keywords.filter((kw) => lastUserMessage.includes(kw)).length;
    if (matchCount > 0) {
      const weight = Math.min(0.15 + matchCount * 0.08, 0.5);
      signals.push({ taskType, weight });
    }
  }

  return signals;
}

function resolveSignals(signals: Signal[]): ClassificationResult<TaskType> {
  if (signals.length === 0) {
    return { value: "general", confidence: 0.3, ambiguous: true };
  }

  // Aggregate weights by task type
  const scores: Record<TaskType, number> = {
    coding: 0,
    creative: 0,
    summarization: 0,
    qa: 0,
    general: 0,
  };

  for (const signal of signals) {
    scores[signal.taskType] += signal.weight;
  }

  const sorted = (Object.entries(scores) as [TaskType, number][]).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = sorted[0];
  const [, secondScore] = sorted[1];

  // Normalize to 0-1 range
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? topScore / totalScore : 0;

  // If top two are too close, it's ambiguous
  const margin = topScore - secondScore;
  const ambiguous = confidence < CONFIDENCE_THRESHOLD || margin < 0.15;

  return { value: topType, confidence, ambiguous };
}

export function classifyTaskType(messages: ChatMessage[]): ClassificationResult<TaskType> {
  const signals = collectSignals(messages);
  return resolveSignals(signals);
}
