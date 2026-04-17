"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";

export interface ChatInputHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Label shown on the send button. Default: "Send" / "..." when disabled. */
  sendLabel?: string;
  /** Slot to the left of the textarea (e.g. prompt preset picker, attachment). */
  leftAddon?: ReactNode;
  /** Slot between the textarea and the send button (e.g. stop button). */
  rightAddon?: ReactNode;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  {
    value,
    onChange,
    onSend,
    disabled,
    placeholder = "Type a message... (Enter to send, Shift+Enter for newline)",
    sendLabel,
    leftAddon,
    rightAddon,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  // The textarea is disabled while streaming, which blurs it. When disabled
  // flips back to false, React re-enables on the next commit — refocus
  // there so the user can keep typing without clicking back in. Also fires
  // on mount (disabled starts false) so the page loads focused.
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="flex gap-3 items-end max-w-4xl mx-auto">
        {leftAddon}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50 overflow-hidden"
          style={{ minHeight: "44px", maxHeight: "200px" }}
          onInput={(e) => {
            const t = e.target as HTMLTextAreaElement;
            t.style.height = "44px";
            t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
          }}
        />
        {rightAddon}
        <button
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="px-4 h-[44px] bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-xl text-sm font-medium transition-colors shrink-0"
        >
          {sendLabel ?? (disabled ? "..." : "Send")}
        </button>
      </div>
    </div>
  );
});
