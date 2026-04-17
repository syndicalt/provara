import type { ReactNode } from "react";

interface Props {
  open: boolean;
  title?: string;
  children: ReactNode;
}

/**
 * Right-hand drawer container. Consumers compose the contents via children —
 * sliders, inputs, presets, whatever they need. The drawer handles its own
 * show/hide animation via `open` and provides the shared dark styling.
 */
export function SettingsPanel({ open, title = "Settings", children }: Props) {
  if (!open) return null;
  return (
    <div className="w-72 bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-5 overflow-y-auto">
      <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
      {children}
    </div>
  );
}
