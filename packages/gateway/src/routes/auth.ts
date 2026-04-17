import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Db } from "@provara/db";
import { users, oauthAccounts } from "@provara/db";
import { eq, and } from "drizzle-orm";
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

const DASHBOARD_URL = () => process.env.DASHBOARD_URL || "http://localhost:3000";
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
      const user = await upsertUser(db, "google", profile);
      const sessionId = await createSession(db, user.id);
      setSessionCookie(c, sessionId);
      return c.redirect(successRedirect(c));
    } catch (err) {
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

  return app;
}

// --- Upsert user from OAuth profile ---

async function upsertUser(
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
    // Link new OAuth provider to existing user
    await db.insert(oauthAccounts).values({
      id: nanoid(),
      userId: existingUser.id,
      provider,
      providerAccountId: profile.id,
      email: profile.email,
    }).run();
    return existingUser;
  }

  // Create new user with auto-generated tenant
  const userId = nanoid();
  const tenantId = nanoid(12);

  await db.insert(users).values({
    id: userId,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    tenantId,
  }).run();

  await db.insert(oauthAccounts).values({
    id: nanoid(),
    userId,
    provider,
    providerAccountId: profile.id,
    email: profile.email,
  }).run();

  return { id: userId, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl, tenantId, role: "owner" as const, createdAt: new Date() };
}
