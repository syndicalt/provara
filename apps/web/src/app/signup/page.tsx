"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { gatewayFetchRaw } from "../../lib/gateway-client";
import { PublicNav } from "../../components/public-nav";

/**
 * Magic-link signup form (#204). Reached when /login determines no user
 * row matches the entered email. Collects first + last name, then re-
 * issues the magic-link request with those names attached — the verify
 * endpoint creates the user atomically on click.
 */
function SignupContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const email = searchParams.get("email") ?? "";
  const returnTo = searchParams.get("return") ?? "/dashboard";

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Direct visit without a seeded email is useless — send them back.
    if (!email) {
      router.replace("/login");
    }
  }, [email, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const first = firstName.trim();
    const last = lastName.trim();
    if (!first || !last) {
      setError("Please enter both your first and last name.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await gatewayFetchRaw("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email, firstName: first, lastName: last }),
      });
      if (res.status === 429) {
        setError("Too many requests for this email. Try again in a few minutes.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      setSentTo(email);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (!email) return null;

  if (sentTo) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-4">
        <div className="w-full max-w-md space-y-5">
          <h1 className="text-2xl font-bold text-center">Check your inbox</h1>
          <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-4 py-4 text-sm text-emerald-100 space-y-2">
            <p>
              We sent a sign-in link to <span className="font-mono text-emerald-50">{sentTo}</span>. Click it to finish creating your account. The link expires in 15 minutes.
            </p>
          </div>
          <p className="text-xs text-zinc-500 text-center">
            Wrong email?{" "}
            <Link href="/login" className="text-blue-400 hover:text-blue-300">
              Go back
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Finish signing up</h1>
          <p className="text-zinc-400 mt-2 text-sm">
            We&apos;ll email a magic link to{" "}
            <span className="font-mono text-zinc-200">{email}</span> once you add your name.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="first-name" className="text-xs text-zinc-400">First name</label>
              <input
                id="first-name"
                type="text"
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={sending}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                placeholder="Ada"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="last-name" className="text-xs text-zinc-400">Last name</label>
              <input
                id="last-name"
                type="text"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={sending}
                className="w-full px-3 py-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                placeholder="Lovelace"
              />
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={sending}
            className="w-full px-4 py-3 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-60"
          >
            {sending ? "Sending link…" : "Send my magic link"}
          </button>
        </form>

        {returnTo !== "/dashboard" && (
          <p className="text-xs text-zinc-500 text-center">
            After signing in we&apos;ll take you to{" "}
            <span className="font-mono text-zinc-300">{returnTo}</span>.
          </p>
        )}

        <p className="text-xs text-zinc-500 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-blue-400 hover:text-blue-300">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <>
      <PublicNav />
      <Suspense>
        <SignupContent />
      </Suspense>
    </>
  );
}
