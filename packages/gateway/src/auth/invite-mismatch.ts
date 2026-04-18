import type { Db } from "@provara/db";
import { teamInvites } from "@provara/db";
import { eq } from "drizzle-orm";

/**
 * OAuth invite-email mismatch detection (#189). Given a (nullable)
 * invite token — threaded through the OAuth flow via the
 * `provara_oauth_invite` cookie — compare the invite's
 * `invited_email` to the email the OAuth provider returned.
 *
 * Returns:
 *   - `null` — no token, or invite is missing / already consumed /
 *     malformed, or emails match. Callback should proceed as if the
 *     mismatch check weren't there.
 *   - `{ expected }` — the emails don't match. Callback should still
 *     sign the user in (their own fresh workspace) but redirect with
 *     `invite_status=wrong_email&expected=<email>` so the dashboard
 *     banner (#189/T4) can tell the user what happened.
 *
 * Already-consumed invites return null: whoever this OAuth account
 * belongs to, the invite has served its purpose. No point surfacing a
 * mismatch banner for a stale invite.
 *
 * Comparison is case-insensitive because OAuth providers don't
 * guarantee email casing matches what was originally invited.
 */
export async function detectInviteEmailMismatch(
  db: Db,
  token: string | undefined | null,
  profileEmail: string | undefined | null,
): Promise<{ expected: string } | null> {
  if (!token) return null;
  if (!profileEmail) return null;

  const invite = await db
    .select({
      invitedEmail: teamInvites.invitedEmail,
      consumedAt: teamInvites.consumedAt,
    })
    .from(teamInvites)
    .where(eq(teamInvites.token, token))
    .get();
  if (!invite) return null;
  if (invite.consumedAt) return null;

  if (invite.invitedEmail.toLowerCase() === profileEmail.toLowerCase()) {
    return null;
  }
  return { expected: invite.invitedEmail };
}

/**
 * Builds the post-OAuth redirect URL. When there's no mismatch, the
 * caller's requested `returnTo` path is honored; on mismatch we clamp
 * to `/dashboard` so the banner is visible (sending the user to a
 * deep link would hide the feedback).
 */
export function buildPostOauthRedirect(
  dashboardBaseUrl: string,
  returnTo: string,
  mismatch: { expected: string } | null,
): string {
  if (!mismatch) return `${dashboardBaseUrl}${returnTo}`;
  const params = new URLSearchParams({
    invite_status: "wrong_email",
    expected: mismatch.expected,
  });
  return `${dashboardBaseUrl}/dashboard?${params.toString()}`;
}
