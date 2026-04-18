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
  // Await to satisfy Next 15's Promise-based params contract, even
  // though we don't use the value — the token is already in the URL
  // bar for the user to visually confirm.
  await params;
  redirect(`/login?return=${encodeURIComponent("/dashboard")}&reason=invite`);
}
