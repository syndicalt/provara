"use client";

import { useState } from "react";

interface Props {
  text: string;
  label?: string;
  copiedLabel?: string;
}

export function CopyButton({ text, label = "Copy", copiedLabel = "Copied" }: Props) {
  const [copied, setCopied] = useState(false);

  async function onClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard may be blocked in some embedded contexts; fail silently.
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 border border-transparent hover:border-zinc-700 rounded transition-colors"
      aria-label={label}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
