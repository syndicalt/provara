"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PROMPT_PRESETS, type PromptPreset } from "./presets";

interface Props {
  onPick: (preset: PromptPreset) => void;
}

/**
 * "Presets" button (mounted as an `inputAddon` on ChatInput). Click opens a
 * small popover grouped by category; clicking a preset fires `onPick` which
 * the playground uses to populate the input and (if set) the system prompt.
 */
export function PromptPresetPicker({ onPick }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const grouped = useMemo(() => {
    const by: Record<string, PromptPreset[]> = {};
    for (const p of PROMPT_PRESETS) {
      by[p.category] = by[p.category] || [];
      by[p.category].push(p);
    }
    return by;
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Prompt presets"
        aria-label="Prompt presets"
        className="h-[44px] px-3 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-700 rounded-xl transition-colors shrink-0"
      >
        Presets
      </button>
      {open && (
        <div className="absolute left-0 bottom-12 z-10 w-72 rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl p-2 max-h-96 overflow-y-auto">
          {Object.entries(grouped).map(([category, presets]) => (
            <div key={category} className="mb-2 last:mb-0">
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest px-2 py-1">
                {category}
              </p>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onPick(p);
                    setOpen(false);
                  }}
                  className="w-full text-left px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 rounded transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
