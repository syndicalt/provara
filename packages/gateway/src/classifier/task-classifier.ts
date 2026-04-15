import type { ChatMessage } from "../providers/types.js";
import type { TaskType, ClassificationResult } from "./types.js";

const CONFIDENCE_THRESHOLD = 0.6;

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;

// Split keywords into strong (high-signal) and weak (supporting context)
const CODING_STRONG = [
  "implement", "refactor", "debug", "compile", "deploy", "lint",
  "write code", "write a function", "write a script", "code review",
  "stack trace", "segfault", "unit test", "integration test",
  "pull request", "merge conflict",
];

const CODING_WEAK = [
  "function", "class", "variable", "import", "export", "async", "await",
  "const", "let", "var", "return", "interface", "type", "enum",
  "error", "bug", "fix", "api", "endpoint", "database", "query",
  "sql", "regex", "algorithm", "runtime", "build", "test",
  "typescript", "javascript", "python", "rust", "golang", "java",
  "c++", "ruby", "swift", "kotlin", "scala", "haskell",
  "react", "vue", "angular", "node", "npm", "pip", "cargo",
  "git", "docker", "kubernetes", "ci/cd", "webpack", "vite",
  "exception", "null", "undefined", "boolean", "array", "object",
  "frontend", "backend", "fullstack", "microservice",
  "message queue", "load balancer", "cache", "proxy",
  "distributed", "scalable", "horizontal scaling",
  "exactly-once", "at-least-once", "idempotent",
  "latency", "throughput", "bandwidth",
  "data structure", "tree", "graph", "heap", "queue", "stack",
  "sorting", "quicksort", "mergesort", "binary search",
  "linked list", "hash map", "hash table",
];

const CREATIVE_STRONG = [
  "write a story", "write a poem", "write a song", "write a script",
  "write a letter", "write a blog", "write an essay", "write an article",
  "creative writing", "fiction", "screenplay", "song lyrics",
  "brainstorm ideas", "brainstorm names",
  "compose", "draft a", "come up with",
];

const CREATIVE_WEAK = [
  "story", "poem", "novel", "chapter", "narrative", "character",
  "plot", "dialogue", "monologue", "scene", "setting",
  "noir", "detective", "mystery", "thriller", "romance", "horror",
  "fantasy", "sci-fi", "science fiction", "dystopian", "utopian",
  "haiku", "limerick", "sonnet", "rhyme", "verse", "stanza",
  "metaphor", "imagery", "allegory", "satire", "parody",
  "imagine", "pretend", "roleplay", "persona",
  "blog post", "essay", "article", "copywriting", "tagline", "slogan",
  "headline", "caption", "bio", "pitch", "proposal",
  "funny", "humorous", "witty", "sarcastic", "dramatic", "emotional",
  "inspiring", "motivational",
];

const SUMMARIZATION_STRONG = [
  "summarize", "summary", "summarise", "tldr", "tl;dr",
  "key points", "main points", "brief overview", "condense",
  "boil down", "in a nutshell", "give me the gist", "shorten this",
  "recap", "digest", "outline the main",
];

const SUMMARIZATION_WEAK = [
  "shorter", "concise", "brief", "extract", "highlights",
  "takeaways", "bottom line",
];

const QA_STRONG = [
  "what is", "what are", "who is", "who are", "when did", "when was",
  "where is", "where are", "how does", "how do", "how is",
  "why does", "why do", "why is", "what does", "what causes",
  "explain", "describe", "define", "meaning of",
  "difference between", "compare", "contrast",
  "tell me about", "is it true", "can you tell me",
  "pros and cons", "advantages and disadvantages",
  "tradeoffs", "trade-offs", "tradeoff", "trade-off",
];

const QA_WEAK = [
  "versus", " vs ", " or ", "better",
  "opinion", "recommend", "suggestion", "advice",
  "example", "examples", "instance", "illustration",
];

interface Signal {
  taskType: TaskType;
  weight: number;
}

function matchKeywords(text: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) count++;
  }
  return count;
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
  if (systemMessage.includes("code") || systemMessage.includes("developer") || systemMessage.includes("programmer") || systemMessage.includes("engineer")) {
    signals.push({ taskType: "coding", weight: 0.3 });
  }
  if (systemMessage.includes("creative") || systemMessage.includes("writer") || systemMessage.includes("storyteller") || systemMessage.includes("author") || systemMessage.includes("poet")) {
    signals.push({ taskType: "creative", weight: 0.3 });
  }
  if (systemMessage.includes("summarize") || systemMessage.includes("summarise") || systemMessage.includes("condense")) {
    signals.push({ taskType: "summarization", weight: 0.3 });
  }

  // Strong keyword matching — high weight per match
  const strongSets: [TaskType, string[]][] = [
    ["coding", CODING_STRONG],
    ["creative", CREATIVE_STRONG],
    ["summarization", SUMMARIZATION_STRONG],
    ["qa", QA_STRONG],
  ];

  for (const [taskType, keywords] of strongSets) {
    const matchCount = matchKeywords(lastUserMessage, keywords);
    if (matchCount > 0) {
      const weight = Math.min(0.3 + matchCount * 0.15, 0.7);
      signals.push({ taskType, weight });
    }
  }

  // Weak keyword matching — lower weight, needs more matches to be meaningful
  const weakSets: [TaskType, string[]][] = [
    ["coding", CODING_WEAK],
    ["creative", CREATIVE_WEAK],
    ["summarization", SUMMARIZATION_WEAK],
    ["qa", QA_WEAK],
  ];

  for (const [taskType, keywords] of weakSets) {
    const matchCount = matchKeywords(lastUserMessage, keywords);
    if (matchCount > 0) {
      const weight = Math.min(0.1 + matchCount * 0.06, 0.4);
      signals.push({ taskType, weight });
    }
  }

  // Structural signals
  // Questions ending with "?" lean toward QA
  if (lastUserMessage.trim().endsWith("?")) {
    signals.push({ taskType: "qa", weight: 0.15 });
  }

  // "Write" at the start — check if it's about code or creative
  if (/^write\b/.test(lastUserMessage)) {
    const codeContext = matchKeywords(lastUserMessage, [
      "code", "function", "script", "test", "query", "algorithm",
      "program", "class", "module", "implementation",
      "python", "javascript", "typescript", "rust", "java", "golang",
      "c++", "ruby", "swift", "kotlin", "sql",
      "quicksort", "mergesort", "binary search", "linked list",
      "sorting", "parser", "server", "client", "api",
    ]);
    if (codeContext > 0) {
      signals.push({ taskType: "coding", weight: 0.3 });
    } else {
      signals.push({ taskType: "creative", weight: 0.2 });
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
