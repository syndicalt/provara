import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import type { Db } from "@provara/db";
import { users, oauthAccounts, teamInvites, magicLinkTokens } from "@provara/db";
import { eq, and, gte, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  getGoogleUser,
  buildGitHubAuthUrl,
  exchangeGitHubCode,
  getGitHubUser,
  generateState,
  type OAuthProfile,
} from "../auth/oauth.js";
import {
  createSession,
  validateSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromCookie,
} from "../auth/session.js";
import { sendEmail } from "../email/index.js";
import { welcomeEmail, magicLinkEmail } from "../email/templates.js";
import { ssoRequiredForEmail } from "../auth/saml.js";

const DASHBOARD_URL = () => process.env.DASHBOARD_URL || "http://localhost:3000";
// The gateway's own public URL (same value OAuth callbacks are registered
// at). Used by any flow that needs to generate a URL pointing back at
// the gateway — e.g. the magic-link email (#204). Distinct from
// DASHBOARD_URL, which is the web app.
const GATEWAY_PUBLIC_URL = () => process.env.OAUTH_REDIRECT_BASE || "http://localhost:4000";
const STATE_COOKIE = "provara_oauth_state";
const RETURN_COOKIE = "provara_oauth_return";

// Only allow redirecting to in-app paths (never external URLs)
function sanitizeReturn(raw: string | undefined | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export function createAuthRoutes(db: Db) {
  const app = new Hono();

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 600,
  };

  // --- Login redirects ---

  app.get("/login/google", (c) => {
    const state = generateState();
    const returnTo = sanitizeReturn(c.req.query("return"));
    setCookie(c, STATE_COOKIE, state, cookieOpts);
    setCookie(c, RETURN_COOKIE, returnTo, cookieOpts);
    return c.redirect(buildGoogleAuthUrl(state));
  });

  app.get("/login/github", (c) => {
    const state = generateState();
    const returnTo = sanitizeReturn(c.req.query("return"));
    setCookie(c, STATE_COOKIE, state, cookieOpts);
    setCookie(c, RETURN_COOKIE, returnTo, cookieOpts);
    return c.redirect(buildGitHubAuthUrl(state));
  });

  // --- Callbacks ---

  function loginRedirect(errorCode: string): string {
    return `${DASHBOARD_URL()}/login?error=${errorCode}`;
  }

  function successRedirect(c: Parameters<typeof getCookie>[0]): string {
    const returnTo = sanitizeReturn(getCookie(c, RETURN_COOKIE));
    return `${DASHBOARD_URL()}${returnTo}`;
  }

  app.get("/callback/google", async (c) => {
    // User clicked "cancel" on Google's consent screen
    const providerError = c.req.query("error");
    if (providerError === "access_denied") {
      return c.redirect(loginRedirect("denied"));
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, STATE_COOKIE);

    if (!code || !state || state !== storedState) {
      return c.redirect(loginRedirect("invalid_state"));
    }

    try {
      const accessToken = await exchangeGoogleCode(code);
      const profile = await getGoogleUser(accessToken);
      // SSO-required gate (#209/T4): if this Google account's email is
      // on a domain some tenant has SSO-enforced, refuse the OAuth path
      // and send the caller back to /login to go through SAML.
      if (typeof profile.email === "string") {
        const ssoForced = await ssoRequiredForEmail(db, profile.email);
        if (ssoForced) {
          return c.redirect(loginRedirect("sso_required"));
        }
      }
      const user = await upsertUser(db, "google", profile);
      const sessionId = await createSession(db, user.id);
      setSessionCookie(c, sessionId);
      return c.redirect(successRedirect(c));
    } catch (err) {
      if (err instanceof OAuthMergeRefusedError) {
        return c.redirect(loginRedirect("email_unverified"));
      }
      console.error("Google OAuth error:", err);
      return c.redirect(loginRedirect("oauth_failed"));
    }
  });

  app.get("/callback/github", async (c) => {
    const providerError = c.req.query("error");
    if (providerError === "access_denied") {
      return c.redirect(loginRedirect("denied"));
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, STATE_COOKIE);

    if (!code || !state || state !== storedState) {
      return c.redirect(loginRedirect("invalid_state"));
    }

    try {
      const accessToken = await exchangeGitHubCode(code);
      const profile = await getGitHubUser(accessToken);
      const user = await upsertUser(db, "github", profile);
      const sessionId = await createSession(db, user.id);
      setSessionCookie(c, sessionId);
      return c.redirect(successRedirect(c));
    } catch (err) {
      if (err instanceof OAuthMergeRefusedError) {
        return c.redirect(loginRedirect("email_unverified"));
      }
      console.error("GitHub OAuth error:", err);
      return c.redirect(loginRedirect("oauth_failed"));
    }
  });

  // --- Session management ---

  app.post("/logout", async (c) => {
    const sessionId = getSessionFromCookie(c);
    if (sessionId) {
      await deleteSession(db, sessionId);
      clearSessionCookie(c);
    }
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const sessionId = getSessionFromCookie(c);
    if (!sessionId) {
      return c.json({ user: null });
    }

    const result = await validateSession(db, sessionId);
    if (!result) {
      clearSessionCookie(c);
      return c.json({ user: null });
    }

    return c.json({
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        avatarUrl: result.user.avatarUrl,
        tenantId: result.user.tenantId,
        role: result.user.role,
      },
    });
  });

  // --- Magic link (#204) ---

  /**
   * Request a magic link. Body: `{ email, firstName?, lastName? }`.
   *
   * - If a user with that email exists: generate + email a link,
   *   return `{status: "sent"}`.
   * - If no user and no names provided: return `{status: "new_user"}` so
   *   the client can redirect to the signup form.
   * - If no user but names provided: store the names on the token row
   *   and email the link — verify-time endpoint will create the user
   *   atomically on click.
   *
   * Rate limit: 3 outstanding (non-consumed, non-expired) tokens per
   * email per 15-minute window.
   */
  app.post("/magic-link/request", async (c) => {
    let body: { email?: unknown; firstName?: unknown; lastName?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body.", type: "validation_error" } }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!isValidEmail(email)) {
      return c.json({ error: { message: "A valid email is required.", type: "validation_error" } }, 400);
    }

    // If this email's domain is SSO-enforced (some tenant has an active
    // sso_configs row that claims it), refuse magic-link and send the
    // caller to the SSO start URL. Without this gate a user could
    // side-step their org's IdP by requesting a magic link for their
    // own email. See #209/T4.
    const ssoForced = await ssoRequiredForEmail(db, email);
    if (ssoForced) {
      return c.json(
        {
          error: {
            message: "Your organization requires SSO sign-in. Use SSO instead of the magic link.",
            type: "sso_required",
          },
          sso: {
            startUrl: `/auth/saml/start?email=${encodeURIComponent(email)}`,
            tenantId: ssoForced.tenantId,
          },
        },
        409,
      );
    }

    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";

    const existingUser = await db.select().from(users).where(eq(users.email, email)).get();

    // No user + no names → tell the client to collect names first.
    if (!existingUser && (!firstName || !lastName)) {
      return c.json({ status: "new_user" });
    }

    // Rate limit: recent outstanding tokens for this email.
    const windowStart = new Date(Date.now() - MAGIC_LINK_TTL_MS);
    const outstanding = await db
      .select({ count: sql<number>`count(*)` })
      .from(magicLinkTokens)
      .where(
        and(
          eq(magicLinkTokens.email, email),
          gte(magicLinkTokens.createdAt, windowStart),
          isNull(magicLinkTokens.consumedAt),
        ),
      )
      .get();
    if ((outstanding?.count ?? 0) >= MAGIC_LINK_MAX_OUTSTANDING) {
      return c.json(
        {
          error: {
            message: "Too many magic-link requests for this email. Try again in a few minutes.",
            type: "rate_limited",
          },
        },
        429,
      );
    }

    // Generate token, hash, persist.
    const plainToken = nanoid(32);
    const tokenHash = hashMagicToken(plainToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
    await db.insert(magicLinkTokens).values({
      id: nanoid(),
      email,
      tokenHash,
      pendingFirstName: existingUser ? null : firstName,
      pendingLastName: existingUser ? null : lastName,
      createdAt: now,
      expiresAt,
    }).run();

    // Send. Non-blocking failure logging — we still return 200 so the
    // client shows a consistent "check your inbox" state; a delivery
    // failure surfaces via the user not seeing the email.
    try {
      // The verify URL points to the GATEWAY, not the web app: the
      // endpoint is owned by the gateway, which sets the session cookie
      // on its own origin (matches OAuth callback behavior — see #204
      // post-merge 404 from hitting www.provara.xyz/auth/magic/verify).
      const verifyUrl = `${GATEWAY_PUBLIC_URL()}/auth/magic/verify?token=${encodeURIComponent(plainToken)}`;
      const tmpl = magicLinkEmail({
        verifyUrl,
        email,
        isNewUser: !existingUser,
        expiresAt,
      });
      await sendEmail({
        to: email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
    } catch (err) {
      console.warn("[auth] magic-link email send failed (non-blocking):", err);
    }

    return c.json({ status: "sent" });
  });

  /**
   * Verify + consume a magic-link token. Routes to `/dashboard` on
   * success with a session cookie set. On any validation failure the
   * user is redirected back to `/login?error=<code>` so the reason
   * surfaces in the login UI.
   */
  app.get("/magic/verify", async (c) => {
    const plainToken = c.req.query("token");
    if (!plainToken || typeof plainToken !== "string") {
      return c.redirect(`${DASHBOARD_URL()}/login?error=magic_link_invalid`);
    }
    const tokenHash = hashMagicToken(plainToken);

    const row = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.tokenHash, tokenHash))
      .get();

    if (!row) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=magic_link_invalid`);
    }
    if (row.consumedAt) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=magic_link_used`);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=magic_link_expired`);
    }

    // Atomic consume: UPDATE ... WHERE consumed_at IS NULL so two
    // simultaneous clicks can't both consume.
    const claim = await db
      .update(magicLinkTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(magicLinkTokens.id, row.id), isNull(magicLinkTokens.consumedAt)))
      .run();
    const affected = (claim as unknown as { rowsAffected?: number; changes?: number }).rowsAffected
      ?? (claim as unknown as { changes?: number }).changes
      ?? 0;
    if (affected === 0) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=magic_link_used`);
    }

    // Find or create the user.
    const user = await upsertUserFromMagicLink(db, {
      email: row.email,
      pendingFirstName: row.pendingFirstName,
      pendingLastName: row.pendingLastName,
    });

    const sessionId = await createSession(db, user.id);
    setSessionCookie(c, sessionId);
    return c.redirect(`${DASHBOARD_URL()}/dashboard`);
  });

  return app;
}

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAGIC_LINK_MAX_OUTSTANDING = 3;

function hashMagicToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

function isValidEmail(email: string): boolean {
  // Deliberately permissive — we delegate real validation to whether
  // the provider actually delivers. Block only the obviously-broken.
  if (email.length < 3 || email.length > 254) return false;
  const atIdx = email.indexOf("@");
  return atIdx > 0 && atIdx < email.length - 1 && email.indexOf(" ") === -1;
}

/**
 * Magic-link equivalent of `upsertUser`. Either returns the existing
 * user row (email already in `users`) or inserts a fresh one using the
 * pending names captured at request time. Mirrors the team-invite
 * claim logic from `upsertUser` so a new signup via magic link lands
 * in the inviter's tenant when applicable.
 *
 * Email is treated as verified because the user provably received and
 * clicked the link — that's the whole point of the magic-link primitive.
 */
async function upsertUserFromMagicLink(
  db: Db,
  params: {
    email: string;
    pendingFirstName: string | null;
    pendingLastName: string | null;
  },
) {
  const existing = await db.select().from(users).where(eq(users.email, params.email)).get();
  if (existing) return existing;

  const firstName = params.pendingFirstName ?? "";
  const lastName = params.pendingLastName ?? "";
  const combinedName = [firstName, lastName].filter(Boolean).join(" ") || null;

  const userId = nanoid();
  let tenantId = nanoid(12);
  let role: "owner" | "member" = "owner";
  let claimedInviteToken: string | null = null;

  const pending = await db
    .select()
    .from(teamInvites)
    .where(
      and(
        sql`LOWER(${teamInvites.invitedEmail}) = ${params.email.toLowerCase()}`,
        isNull(teamInvites.consumedAt),
        gte(teamInvites.expiresAt, new Date()),
      ),
    )
    .get();

  if (pending) {
    const claim = await db
      .update(teamInvites)
      .set({ consumedAt: new Date() })
      .where(and(eq(teamInvites.token, pending.token), isNull(teamInvites.consumedAt)))
      .run();
    const affected = (claim as unknown as { rowsAffected?: number; changes?: number }).rowsAffected
      ?? (claim as unknown as { changes?: number }).changes
      ?? 0;
    if (affected > 0) {
      tenantId = pending.tenantId;
      role = pending.invitedRole;
      claimedInviteToken = pending.token;
      console.log(
        `[auth] magic-link invite claimed — token=${pending.token} email=${params.email} tenant=${pending.tenantId} role=${pending.invitedRole}`,
      );
    }
  }

  await db.insert(users).values({
    id: userId,
    email: params.email,
    name: combinedName,
    firstName: firstName || null,
    lastName: lastName || null,
    avatarUrl: null,
    tenantId,
    role,
  }).run();

  if (claimedInviteToken) {
    await db
      .update(teamInvites)
      .set({ consumedByUserId: userId })
      .where(eq(teamInvites.token, claimedInviteToken))
      .run();
  }

  if (!claimedInviteToken) {
    try {
      const dashboardUrl = process.env.DASHBOARD_URL || "https://www.provara.xyz/dashboard";
      const tmpl = welcomeEmail({ name: combinedName ?? params.email, dashboardUrl });
      await sendEmail({
        to: params.email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
    } catch (err) {
      console.warn("[auth] welcome email failed (non-blocking):", err);
    }
  }

  return {
    id: userId,
    email: params.email,
    name: combinedName,
    firstName: firstName || null,
    lastName: lastName || null,
    avatarUrl: null,
    tenantId,
    role,
    createdAt: new Date(),
  };
}

/**
 * Raised by `upsertUser` when an incoming OAuth profile's email matches
 * an existing user but the provider did not verify the email. The
 * callback handlers catch this specifically and redirect the user to
 * the login screen with an explanatory error code, avoiding a unique-
 * constraint DB error and a confusing 500.
 */
export class OAuthMergeRefusedError extends Error {
  constructor(public readonly email: string) {
    super(`OAuth merge refused — provider did not verify email ${email}`);
    this.name = "OAuthMergeRefusedError";
  }
}

// --- Upsert user from OAuth profile ---

/** Exported for tests; route callers consume it indirectly. */
export async function upsertUser(
  db: Db,
  provider: "google" | "github",
  profile: OAuthProfile
) {
  // Check if this OAuth account already exists
  const existingAccount = await db
    .select()
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, provider),
        eq(oauthAccounts.providerAccountId, profile.id)
      )
    )
    .get();

  if (existingAccount) {
    // Return existing user
    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, existingAccount.userId))
      .get();
    if (!user) throw new Error("User not found for existing OAuth account");
    return user;
  }

  // Check if a user with this email already exists (link accounts)
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .get();

  if (existingUser) {
    // Merge gate (#182): only link a new OAuth provider to an existing
    // user if the incoming provider explicitly verified the email. All
    // current providers (Google, GitHub) verify — this gate is defense
    // in depth for future providers that might not.
    if (!profile.emailVerified) {
      console.warn(
        `[auth] OAuth merge REFUSED: ${provider} account ${profile.id} claimed email=${profile.email} ` +
        `but the provider did not verify it. Existing user ${existingUser.id} was NOT linked. ` +
        `Login refused — users.email has a unique constraint so we can't create a sidecar account.`,
      );
      throw new OAuthMergeRefusedError(profile.email);
    } else {
      // Link new OAuth provider to existing user (#178). Merges two
      // different OAuth accounts (different providerAccountId, same
      // verified email) under the same user row → same tenantId.
      // Intentional for "link my Google and GitHub" flows. Logging
      // every merge so operators can audit.
      console.warn(
        `[auth] OAuth merge: ${provider} account ${profile.id} linked to existing user ${existingUser.id} ` +
        `(email=${profile.email}, tenant=${existingUser.tenantId}). If this user did not explicitly intend to ` +
        `link accounts, investigate.`,
      );
      await db.insert(oauthAccounts).values({
        id: nanoid(),
        userId: existingUser.id,
        provider,
        providerAccountId: profile.id,
        email: profile.email,
      }).run();
      return existingUser;
    }
  }

  // Check for a pending team invite matching this email (#177). If
  // found, atomically claim it — the new user lands in the inviter's
  // tenant with the role assigned on the invite. Email comparison is
  // case-insensitive because OAuth providers inconsistently case the
  // local-part. Only verified emails can claim (belt-and-suspenders
  // beyond #182's merge gate — an unverified invite-claim could
  // hijack a shared-email case).
  const userId = nanoid();
  let tenantId = nanoid(12);
  let role: "owner" | "member" = "owner";
  let claimedInviteToken: string | null = null;

  if (profile.emailVerified) {
    const pending = await db
      .select()
      .from(teamInvites)
      .where(and(
        sql`LOWER(${teamInvites.invitedEmail}) = ${profile.email.toLowerCase()}`,
        isNull(teamInvites.consumedAt),
        gte(teamInvites.expiresAt, new Date()),
      ))
      .get();

    if (pending) {
      // Atomic claim — UPDATE ... WHERE consumed_at IS NULL so two
      // simultaneous claims of the same invite can't both win. We only
      // flip `consumedAt` here; `consumedByUserId` is back-filled after
      // the user row is inserted so the FK to users.id is satisfied.
      const claim = await db
        .update(teamInvites)
        .set({ consumedAt: new Date() })
        .where(and(
          eq(teamInvites.token, pending.token),
          isNull(teamInvites.consumedAt),
        ))
        .run();
      const affected = (claim as unknown as { rowsAffected?: number; changes?: number }).rowsAffected
        ?? (claim as unknown as { changes?: number }).changes
        ?? 0;
      if (affected > 0) {
        tenantId = pending.tenantId;
        role = pending.invitedRole;
        claimedInviteToken = pending.token;
        console.log(
          `[auth] invite claimed — token=${pending.token} email=${profile.email} tenant=${pending.tenantId} role=${pending.invitedRole}`,
        );
      }
      // If affected = 0, another claim won the race. Fall through to
      // regular fresh-tenant signup.
    }
  }

  await db.insert(users).values({
    id: userId,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    tenantId,
    role,
  }).run();

  await db.insert(oauthAccounts).values({
    id: nanoid(),
    userId,
    provider,
    providerAccountId: profile.id,
    email: profile.email,
  }).run();

  if (claimedInviteToken) {
    await db
      .update(teamInvites)
      .set({ consumedByUserId: userId })
      .where(eq(teamInvites.token, claimedInviteToken))
      .run();
  }

  // Welcome email for fresh self-service signups (not invite claims —
  // invitees already received the invite email). Non-blocking: send
  // failure is logged but doesn't abort the signup.
  if (!claimedInviteToken) {
    try {
      const dashboardUrl = process.env.DASHBOARD_URL || "https://www.provara.xyz/dashboard";
      const tmpl = welcomeEmail({ name: profile.name, dashboardUrl });
      await sendEmail({
        to: profile.email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
    } catch (err) {
      console.warn("[auth] welcome email failed (non-blocking):", err);
    }
  }

  return { id: userId, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl, tenantId, role, createdAt: new Date() };
}
