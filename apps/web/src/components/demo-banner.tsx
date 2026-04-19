"use client";

import { useAuth } from "../lib/auth-context";

/**
 * Read-only demo banner (#229). Renders only when the caller's session
 * is a demo session (`/auth/me` returns `isDemo: true`). Non-dismissible
 * — a demo visitor losing this context and then wondering why write
 * actions 403 is the worst UX outcome.
 *
 * Sits above the dashboard nav at `z-[60]` so it stays visible even if
 * individual pages stack banners (e.g. the invite-mismatch banner).
 */
export function DemoBanner() {
  const { isDemo } = useAuth();
  if (!isDemo) return null;

  return (
    <div className="sticky top-0 z-[60] bg-gradient-to-r from-blue-700 to-violet-700 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm">
          <span className="font-semibold">You're in demo mode.</span>{" "}
          <span className="text-white/80">
            Data is pre-seeded and resets nightly. Writes are disabled on this session.
          </span>
        </p>
        <a
          href="/login"
          className="shrink-0 px-3 py-1.5 rounded-md bg-white text-zinc-900 text-sm font-medium hover:bg-zinc-100 transition-colors"
        >
          Sign up →
        </a>
      </div>
    </div>
  );
}
