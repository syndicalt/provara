"use client";

import { useEffect, useState } from "react";

/**
 * Stateful hook that mirrors `useState` to `sessionStorage` under `key`.
 * Used to avoid scattering individual `useEffect(() => sessionStorage.set...)`
 * calls across the call site. On first render the initial value comes from
 * storage (if present and parseable), falling back to `initial`.
 *
 * `pauseWrite` lets the caller skip writes during known-mid-mutation
 * periods (e.g. in-flight streaming). The current and pending values still
 * flow through state — only the disk write is deferred.
 */
export function useSessionPersist<T>(
  key: string,
  initial: T,
  options: { pauseWrite?: boolean } = {},
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    const raw = sessionStorage.getItem(key);
    if (raw === null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (options.pauseWrite) return;
    sessionStorage.setItem(key, JSON.stringify(value));
  }, [key, value, options.pauseWrite]);

  return [value, setValue];
}
