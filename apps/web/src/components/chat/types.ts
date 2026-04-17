import type { ReactNode } from "react";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  model?: string;
  /** Server-assigned id; only present on assistant turns that produced a real completion. */
  requestId?: string;
  /** 1-5 star rating; undefined = not rated yet */
  feedbackScore?: number;
}

export interface ProvaraMetadata {
  provider: string;
  latencyMs: number;
  cached: boolean;
  routing: {
    taskType: string;
    complexity: string;
    routedBy: string;
    usedFallback: boolean;
  };
}

/**
 * One button attached to a message. Shown underneath the bubble. Actions
 * are data, not custom JSX, so the chat client stays in control of layout
 * and spacing across modules.
 */
export interface MessageAction {
  id: string;
  render: (msg: ChatMessage, index: number) => ReactNode;
  /** Defaults to assistant messages only when unset. */
  showFor?: (msg: ChatMessage) => boolean;
}
