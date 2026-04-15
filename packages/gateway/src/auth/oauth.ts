import { randomBytes } from "node:crypto";

const REDIRECT_BASE = () => process.env.OAUTH_REDIRECT_BASE || "http://localhost:4000";

// --- Google OAuth ---

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: `${REDIRECT_BASE()}/auth/callback/google`,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(code: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri: `${REDIRECT_BASE()}/auth/callback/google`,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json() as { access_token: string };
  if (!data.access_token) throw new Error("Failed to exchange Google code");
  return data.access_token;
}

export async function getGoogleUser(accessToken: string): Promise<OAuthProfile> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json() as { id: string; email: string; name: string; picture: string };
  return {
    id: data.id,
    email: data.email,
    name: data.name,
    avatarUrl: data.picture,
  };
}

// --- GitHub OAuth ---

export function buildGitHubAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID || "",
    redirect_uri: `${REDIRECT_BASE()}/auth/callback/github`,
    scope: "read:user user:email",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGitHubCode(code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID || "",
      client_secret: process.env.GITHUB_CLIENT_SECRET || "",
      code,
      redirect_uri: `${REDIRECT_BASE()}/auth/callback/github`,
    }),
  });
  const data = await res.json() as { access_token: string };
  if (!data.access_token) throw new Error("Failed to exchange GitHub code");
  return data.access_token;
}

export async function getGitHubUser(accessToken: string): Promise<OAuthProfile> {
  const [userRes, emailsRes] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "Provara" },
    }),
    fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "Provara" },
    }),
  ]);

  const user = await userRes.json() as { id: number; login: string; name: string; avatar_url: string };
  const emails = await emailsRes.json() as { email: string; primary: boolean; verified: boolean }[];
  const primaryEmail = emails.find((e) => e.primary && e.verified)?.email || emails[0]?.email;

  return {
    id: String(user.id),
    email: primaryEmail || "",
    name: user.name || user.login,
    avatarUrl: user.avatar_url,
  };
}

// --- Shared ---

export interface OAuthProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}
