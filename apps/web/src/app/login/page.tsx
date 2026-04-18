"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { gatewayFetchRaw } from "../../lib/gateway-client";
import { PublicNav } from "../../components/public-nav";
import { useAuth } from "../../lib/auth-context";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

function errorMessage(code: string | null): string | null {
  switch (code) {
    case "expired":
      return "Your session expired. Please sign in again.";
    case "denied":
      return "Sign-in was cancelled. You can try again whenever you're ready.";
    case "oauth_failed":
      return "Sign-in failed. Please try again — if this keeps happening, the OAuth provider may be down.";
    case "invalid_state":
      return "The sign-in link expired mid-flow. Please start again.";
    case "email_unverified":
      return "That email is already registered with another sign-in method, and the provider you used did not verify email ownership. Please sign in with your original provider.";
    case "magic_link_invalid":
      return "That magic link is invalid. Request a fresh one below.";
    case "magic_link_expired":
      return "That magic link has expired. Request a fresh one below.";
    case "magic_link_used":
      return "That magic link has already been used. Request a fresh one below.";
    case "sso_required":
      return "Your organization requires SSO sign-in. Enter your work email below to continue via your identity provider.";
    case "sso_not_configured":
      return "SSO is not set up for that email's domain. If this looks wrong, contact your admin.";
    case "sso_invalid_response":
      return "The sign-in response from your identity provider was invalid. Start over and try again.";
    case "sso_no_email_in_assertion":
      return "Your identity provider didn't return an email address. Contact your admin.";
    case "sso_email_on_other_tenant":
      return "That email is already registered to another Provara workspace. Contact your admin to resolve this.";
    case null:
      return null;
    default:
      return "Something went wrong. Please try again.";
  }
}

function LoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const error = searchParams.get("error");
  const reason = searchParams.get("reason");
  const returnTo = searchParams.get("return") || "/dashboard";
  const errorText = errorMessage(error);
  const isInvite = reason === "invite";

  // Append the return path onto the OAuth start URL so the callback can honor it.
  const oauthReturn = returnTo === "/dashboard" ? "" : `?return=${encodeURIComponent(returnTo)}`;

  useEffect(() => {
    // An already-signed-in user clicking an invite link is almost
    // certainly on the wrong account — auto-forwarding to the return
    // URL silently drops the invite. Hold them on this page and show
    // the mismatch banner instead so they can sign out and claim as
    // the invited email.
    if (!loading && user && !isInvite) {
      router.replace(returnTo);
    }
  }, [user, loading, router, returnTo, isInvite]);

  if (loading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <p className="text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (user && isInvite) {
    return <InviteMismatchBanner userEmail={user.email} returnTo={returnTo} />;
  }

  if (user) return null;

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold">
            {isInvite ? "You've been invited" : "Sign in to Provara"}
          </h1>
          <p className="text-zinc-400 mt-2">
            {isInvite
              ? "Sign in with the email address you were invited with. You'll join the team automatically."
              : "Route across OpenAI, Anthropic, Groq, DeepSeek, and more — with adaptive quality scoring and built-in A/B testing."}
          </p>
          {isInvite && (
            <p className="text-xs text-amber-200/80 mt-3 px-3 py-2 rounded bg-amber-950/20 border border-amber-900/40">
              Pick the account matching the invited email. Signing in with a
              different account will start a new workspace and leave the invite
              unclaimed.
            </p>
          )}
        </div>

        {errorText && (
          <div
            className={`border rounded-lg px-4 py-3 text-sm ${
              error === "denied"
                ? "bg-zinc-900 border-zinc-700 text-zinc-300"
                : error === "expired"
                ? "bg-amber-900/30 border-amber-800 text-amber-200"
                : "bg-red-900/30 border-red-800 text-red-300"
            }`}
          >
            {errorText}
          </div>
        )}

        <div className="space-y-3">
          <a
            href={`${GATEWAY}/auth/login/google${oauthReturn}`}
            className="flex items-center justify-center gap-3 w-full px-4 py-3 bg-white text-zinc-900 rounded-lg font-medium hover:bg-zinc-100 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Sign in with Google
          </a>

          <a
            href={`${GATEWAY}/auth/login/github${oauthReturn}`}
            className="flex items-center justify-center gap-3 w-full px-4 py-3 bg-zinc-800 text-white rounded-lg font-medium hover:bg-zinc-700 transition-colors border border-zinc-700"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Sign in with GitHub
          </a>
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <div className="h-px bg-zinc-800 flex-1" />
          <span>or</span>
          <div className="h-px bg-zinc-800 flex-1" />
        </div>

        <MagicLinkForm returnTo={returnTo} />

        <div className="pt-2 text-center space-y-2">
          <p className="text-xs text-zinc-500">
            By signing in, you agree to our{" "}
            <Link href="/terms" className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2 transition-colors">
              terms of service
            </Link>
            .
          </p>
          <p className="text-xs text-zinc-600">
            Want to self-host instead?{" "}
            <a
              href="https://github.com/syndicalt/provara"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 transition-colors"
            >
              Run it yourself →
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Magic-link request form. Two terminal states:
 *
 * - Email belongs to an existing user → `{status: "sent"}` from the
 *   gateway → we swap in a "check your inbox" confirmation.
 * - Email does not exist → `{status: "new_user"}` → redirect to
 *   /signup?email=X so the user can provide first/last name before we
 *   issue the link.
 */
function MagicLinkForm({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // When set, the typed email's domain is SSO-enforced — the submit
  // button becomes "Continue with SSO" and clicking it redirects to the
  // gateway's start URL instead of requesting a magic link.
  const [ssoStartUrl, setSsoStartUrl] = useState<string | null>(null);

  // Debounce-discover as the user types. A 400ms idle window keeps the
  // discover endpoint off the critical path while still feeling
  // responsive — typing pauses naturally cluster around commas and
  // domain boundaries.
  useEffect(() => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@") || trimmed.length < 5) {
      setSsoStartUrl(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await gatewayFetchRaw(
          `/auth/saml/discover?email=${encodeURIComponent(trimmed)}`,
          { method: "GET" },
        );
        if (!res.ok) {
          setSsoStartUrl(null);
          return;
        }
        const body = (await res.json()) as { sso: boolean; startUrl?: string };
        setSsoStartUrl(body.sso && body.startUrl ? body.startUrl : null);
      } catch {
        // Silent — discover failure just means the user gets the normal
        // magic-link path, which will still be refused by the backend
        // if SSO is truly required.
        setSsoStartUrl(null);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [email]);

  function goToSso(startUrl: string) {
    window.location.href = `${GATEWAY}${startUrl}`;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setLocalError(null);

    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      setLocalError("Enter a valid email.");
      return;
    }

    // If discover has already flagged this email as SSO-enforced, skip
    // the magic-link request and go straight to the IdP.
    if (ssoStartUrl) {
      goToSso(ssoStartUrl);
      return;
    }

    setSending(true);
    try {
      const res = await gatewayFetchRaw("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email: trimmed }),
      });
      if (res.status === 429) {
        setLocalError("Too many requests for this email. Try again in a few minutes.");
        return;
      }
      // Backend said SSO is required for this email — the discover call
      // must have raced. Follow the startUrl returned in the body.
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body?.error?.type === "sso_required" && body?.sso?.startUrl) {
          goToSso(body.sso.startUrl);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLocalError(body?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      const data = (await res.json()) as { status: "sent" | "new_user" };
      if (data.status === "new_user") {
        const qs = new URLSearchParams({ email: trimmed });
        if (returnTo && returnTo !== "/dashboard") qs.set("return", returnTo);
        router.push(`/signup?${qs.toString()}`);
        return;
      }
      setSentTo(trimmed);
    } catch (err) {
      setLocalError("Network error. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (sentTo) {
    return (
      <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-4 py-4 text-sm text-emerald-200 space-y-2">
        <p>
          <strong className="text-emerald-100">Check your inbox.</strong> We sent a sign-in link to{" "}
          <span className="font-mono text-emerald-50">{sentTo}</span>. The link expires in 15 minutes.
        </p>
        <p className="text-xs text-emerald-300/70">
          Didn&apos;t get it?{" "}
          <button
            type="button"
            onClick={() => {
              setSentTo(null);
              setEmail("");
            }}
            className="underline hover:text-emerald-100"
          >
            Try a different email
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label htmlFor="magic-email" className="sr-only">
        Email
      </label>
      <input
        id="magic-email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={sending}
        className="w-full px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
      />
      {localError && (
        <p className="text-xs text-red-400">{localError}</p>
      )}
      {ssoStartUrl && (
        <p className="text-xs text-blue-300">
          Your organization uses SSO. You&apos;ll be redirected to your identity provider.
        </p>
      )}
      <button
        type="submit"
        disabled={sending}
        className="flex items-center justify-center gap-3 w-full px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-500 transition-colors disabled:opacity-60"
      >
        {ssoStartUrl ? (
          <>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m0 0v3m0-3h3m-3 0H9m3-12a4 4 0 00-4 4v3H6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2h-2V7a4 4 0 00-4-4z" />
            </svg>
            Continue with SSO
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            {sending ? "Sending…" : "Sign in with Magic Link"}
          </>
        )}
      </button>
    </form>
  );
}

/**
 * Shown when an authenticated user lands on /login?reason=invite. The
 * invite can only be claimed by signing in as the invited email, so we
 * stop here instead of auto-forwarding them into their own workspace
 * (the previous silent-drop behavior). Signing out + re-signing-in with
 * the correct OAuth account is the recovery path.
 */
function InviteMismatchBanner({ userEmail, returnTo }: { userEmail: string; returnTo: string }) {
  const [signingOut, setSigningOut] = useState(false);

  async function signOutAndStay() {
    setSigningOut(true);
    try {
      await gatewayFetchRaw("/auth/logout", { method: "POST" });
    } catch {
      // Best-effort — reload regardless so the auth context re-reads /auth/me
    }
    // Full reload so the auth context refetches and we land on this same
    // login page as an unauthenticated user with the invite copy visible.
    window.location.href = `/login?reason=invite&return=${encodeURIComponent(returnTo)}`;
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-bold">You&apos;re already signed in</h1>
        </div>
        <div className="bg-amber-950/30 border border-amber-900/60 rounded-lg p-4 text-sm text-amber-100 space-y-2">
          <p>
            You&apos;re signed in as <span className="font-mono text-amber-50">{userEmail}</span>.
            Invites can only be claimed by signing in with the email address the invite was sent to.
          </p>
          <p className="text-amber-200/80">
            If the invite was sent to a different address, sign out and sign back in with that account.
          </p>
        </div>
        <div className="space-y-2">
          <button
            onClick={signOutAndStay}
            disabled={signingOut}
            className="w-full px-4 py-3 rounded-lg font-medium bg-white text-zinc-900 hover:bg-zinc-100 transition-colors disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out and continue"}
          </button>
          <Link
            href={returnTo}
            className="block text-center text-xs text-zinc-500 hover:text-zinc-300 pt-1"
          >
            Cancel — stay signed in as {userEmail}
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <>
      <PublicNav />
      <Suspense>
        <LoginContent />
      </Suspense>
    </>
  );
}
