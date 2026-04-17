/**
 * Starter prompt library. Curated list; no user-editable presets yet —
 * that can land once there's demand. Categorized so the picker can
 * group visually; each preset optionally pairs a system prompt to set
 * context, and a body that populates the input.
 */
export interface PromptPreset {
  id: string;
  category: string;
  label: string;
  systemPrompt?: string;
  body: string;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "code-review",
    category: "Coding",
    label: "Code review",
    systemPrompt:
      "You are a careful senior engineer. When reviewing code, flag correctness bugs first, performance second, style last. Be specific — cite line numbers.",
    body: "Review the following code for bugs, performance issues, and clarity:\n\n```\n// paste your code here\n```",
  },
  {
    id: "explain-code",
    category: "Coding",
    label: "Explain this code",
    body: "Explain what this code does, line by line, as if I'm a mid-level engineer unfamiliar with the library:\n\n```\n// paste your code here\n```",
  },
  {
    id: "write-tests",
    category: "Coding",
    label: "Write tests",
    systemPrompt:
      "You write pragmatic unit tests. No mocks unless necessary. Focus on behavior, not implementation.",
    body: "Write tests for this function. Cover the happy path, edge cases, and one failure mode:\n\n```\n// paste your function here\n```",
  },
  {
    id: "summarize",
    category: "Writing",
    label: "Summarize",
    body: "Summarize the following in 3 bullet points. Keep it concise and factual:\n\n",
  },
  {
    id: "rewrite-clear",
    category: "Writing",
    label: "Rewrite for clarity",
    body: "Rewrite the following to be clearer and more direct. Preserve the meaning; tighten the prose:\n\n",
  },
  {
    id: "brainstorm",
    category: "Writing",
    label: "Brainstorm names",
    body: "Brainstorm 10 names for the following. Mix short/punchy with longer/descriptive:\n\n",
  },
  {
    id: "compare-options",
    category: "Thinking",
    label: "Compare options",
    systemPrompt:
      "You help users think through decisions. Give a structured comparison with explicit tradeoffs; state your recommendation last with one-sentence rationale.",
    body: "Help me decide between the following options. Compare tradeoffs and recommend one:\n\nOption A: \nOption B: ",
  },
  {
    id: "devils-advocate",
    category: "Thinking",
    label: "Devil's advocate",
    systemPrompt:
      "Push back hard. Your job is to stress-test an argument — point out unstated assumptions, overlooked counter-evidence, and rhetorical weaknesses.",
    body: "Here's my argument. Play devil's advocate — what am I missing?\n\n",
  },
  {
    id: "eli5",
    category: "Q&A",
    label: "Explain like I'm 5",
    body: "Explain the following concept in plain English, as if talking to a smart non-expert. Use concrete analogies:\n\n",
  },
];
