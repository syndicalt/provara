"use client";

import { useState } from "react";

interface Props {
  value?: number;
  onChange: (v: number) => void;
}

export function StarRating({ value, onChange }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const displayed = hover ?? value ?? 0;
  return (
    <div className="flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= displayed;
        return (
          <button
            key={star}
            type="button"
            onClick={() => onChange(star)}
            onMouseEnter={() => setHover(star)}
            title={`Rate ${star} of 5`}
            aria-label={`Rate ${star} of 5`}
            className={`w-6 h-6 flex items-center justify-center text-base leading-none transition-colors ${
              filled ? "text-amber-400 hover:text-amber-300" : "text-zinc-700 hover:text-zinc-500"
            }`}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
