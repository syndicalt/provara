import { redirect } from "next/navigation";

/**
 * Invite landing. Bounces to /login with /dashboard as the return URL.
 * The actual invite claim happens in the gateway's OAuth callback —
 * upsertUser looks up any pending invite matching the authenticated
 * email and atomically consumes it before the session cookie is set.
 *
 * We intentionally do NOT return the user to /invite/:token after
 * login. Doing so would create a redirect loop: the authenticated
 * user hits this page again → redirect to /login → /login sees the
 * session → router.replace(returnTo) back to /invite/:token → …
 *
 * The token in the URL is retained for email traceability (so an
 * invitee can confirm they clicked the right link) but isn't needed
 * by the claim flow — match is on email, not token.
 */
export default async function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  // Forward the invite token to /login so it can thread through the
  // OAuth flow. The server-side callback uses it (#189) to detect a
  // "signed in with the wrong Google/GitHub account" mismatch and
  // surface an actionable banner instead of silently creating a fresh
  // solo workspace.
  const { token } = await params;
  const params_ = new URLSearchParams({
    return: "/dashboard",
    reason: "invite",
    invite_token: token,
  });
  redirect(`/login?${params_.toString()}`);
}
