"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { useState, useRef, type ReactNode } from "react";

/**
 * Markdown renderer used by the chat client. Adds GFM (tables, strikethrough,
 * task lists) and highlight.js-based code coloring. Inline `code` and fenced
 * ```blocks``` get different styling — the latter gets a hover copy button.
 *
 * The CSS import (`github-dark.css`) is bundled once at module scope so every
 * rendered message gets the same theme without runtime fetches.
 */
export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="chat-markdown text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Code block (fenced ```lang...```) wraps in a relatively positioned
          // container so we can float a copy button in the top-right on hover.
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // Inline code stays as a plain <code>, styled via chat-markdown CSS.
          code: ({ className, children, ...props }) => (
            <code className={className} {...props}>
              {children}
            </code>
          ),
          // Links open in a new tab and get visible styling.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-blue-400 hover:text-blue-300 underline">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  async function onCopy() {
    const text = ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Some embedded contexts block clipboard writes; fail silently.
    }
  }

  return (
    <div className="relative group my-3">
      <pre ref={ref} className="overflow-x-auto rounded-lg bg-zinc-950/80 border border-zinc-800 p-3 text-xs">
        {children}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-zinc-300"
        aria-label="Copy code"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
