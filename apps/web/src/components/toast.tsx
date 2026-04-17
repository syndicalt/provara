"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ToastVariant = "success" | "error" | "info";

interface ToastEntry {
  id: number;
  message: string;
  variant: ToastVariant;
  /** ms until auto-dismiss. 0 = sticky (user must click to close). */
  duration: number;
}

interface ToastContextValue {
  show: (message: string, opts?: { variant?: ToastVariant; duration?: number }) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used within <ToastProvider>");
  return ctx;
}

const DEFAULT_DURATION = 3000;

/**
 * Minimal non-blocking toast. Mount <ToastProvider> at the root; any
 * descendant calls `useToast().show(...)` to append a toast. Toasts
 * auto-dismiss after `duration` ms (default 3000) and fade out via CSS.
 * Clicking a toast dismisses it immediately.
 *
 * One-concern-per-file; no dep. If we ever need richer behavior (swipe
 * to dismiss, undo buttons, promise variants) swap for a library like
 * sonner and keep the same useToast() API.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, opts: { variant?: ToastVariant; duration?: number } = {}) => {
      const id = Date.now() + Math.random();
      const variant = opts.variant ?? "info";
      const duration = opts.duration ?? DEFAULT_DURATION;
      setToasts((prev) => [...prev, { id, message, variant, duration }]);
    },
    [],
  );

  const ctx: ToastContextValue = {
    show,
    success: (msg, duration) => show(msg, { variant: "success", duration }),
    error: (msg, duration) => show(msg, { variant: "error", duration }),
    info: (msg, duration) => show(msg, { variant: "info", duration }),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger the enter transition on next paint.
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (toast.duration === 0) return;
    const id = setTimeout(() => {
      setVisible(false);
      // Give the fade-out transition time before removing from the DOM.
      setTimeout(onDismiss, 200);
    }, toast.duration);
    return () => clearTimeout(id);
  }, [toast.duration, onDismiss]);

  const colors: Record<ToastVariant, string> = {
    success: "bg-emerald-950/90 border-emerald-800 text-emerald-200",
    error: "bg-red-950/90 border-red-800 text-red-200",
    info: "bg-zinc-900/90 border-zinc-700 text-zinc-200",
  };

  return (
    <button
      type="button"
      onClick={() => {
        setVisible(false);
        setTimeout(onDismiss, 200);
      }}
      className={`pointer-events-auto text-left text-sm px-4 py-2.5 border rounded-lg shadow-lg backdrop-blur-sm transition-all duration-200 max-w-sm cursor-pointer ${colors[toast.variant]} ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      {toast.message}
    </button>
  );
}
