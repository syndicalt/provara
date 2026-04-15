import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "@provara/db";
import { sessions, users } from "@provara/db";
import { eq, and, gt } from "drizzle-orm";
import { nanoid } from "nanoid";

const SESSION_COOKIE = "provara_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export async function createSession(db: Db, userId: string): Promise<string> {
  const id = nanoid(32);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000);

  await db.insert(sessions).values({
    id,
    userId,
    expiresAt,
  }).run();

  return id;
}

export async function validateSession(db: Db, sessionId: string) {
  const row = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, new Date())
      )
    )
    .get();

  if (!row) return null;

  return {
    session: row.session,
    user: row.user,
  };
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
  });
}

export function getSessionFromCookie(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE) || null;
}
