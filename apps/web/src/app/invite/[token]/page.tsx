import { redirect } from "next/navigation";
import { PublicNav } from "../../../components/public-nav";

/**
 * Invite landing. Minimal — just redirects to /login with a return URL
 * pointing back to this page. After sign-in, the OAuth handler in the
 * gateway sees the pending invite matching the user's email and
 * consumes it, landing them on the inviter's tenant.
 *
 * If the user is already signed in and has a session, they skip the
 * login step — the invite will be claimed (or ignored if their email
 * doesn't match) on whatever signup path applies.
 *
 * Server component — no client JS needed beyond the nav.
 */
export default async function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Pass the full /invite/:token path as the return so the post-login
  // redirect lands back here, giving the user a visible confirmation
  // that they were added to the team.
  const returnTo = encodeURIComponent(`/invite/${token}`);
  redirect(`/login?return=${returnTo}&reason=invite`);

  // Unreachable, but TypeScript wants a return:
  void PublicNav;
  return null;
}
