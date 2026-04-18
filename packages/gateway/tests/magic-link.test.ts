import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { magicLinkTokens, users, teamInvites, sessions } from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { createAuthRoutes } from "../src/routes/auth.js";

/**
 * #204 — magic-link signup/login tests.
 *
 * The routes live under `createAuthRoutes` which is mounted at `/auth`
 * in the real app. Tests mount the same factory to a bare Hono app and
 * drive it directly so we don't need to simulate the full admin/tenant
 * middleware chain.
 */

function app(db: Db) {
  const a = new Hono();
  a.route("/auth", createAuthRoutes(db));
  return a;
}

function hash(plain: string) {
  return createHash("sha256").update(plain).digest("hex");
}

// Set before each test to a predictable value so the verify redirect is testable.
const DASHBOARD = "http://test.local";

describe("magic link request + verify (#204)", () => {
  beforeEach(() => {
    process.env.DASHBOARD_URL = DASHBOARD;
    process.env.MODE = "multi_tenant";
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    vi.restoreAllMocks();
  });

  async function seedUser(db: Db, email: string, tenantId = "t-1") {
    await db.insert(users).values({
      id: "u-" + email,
      email,
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      tenantId,
      role: "owner",
      createdAt: new Date(),
    }).run();
  }

  describe("POST /auth/magic-link/request", () => {
    it("returns new_user when email is unknown and no names were provided", async () => {
      const db = await makeTestDb();
      const res = await app(db).request("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email: "stranger@example.com" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("new_user");
      const tokens = await db.select().from(magicLinkTokens).all();
      expect(tokens).toHaveLength(0);
    });

    it("issues a token and persists pending names for a new signup", async () => {
      const db = await makeTestDb();
      const res = await app(db).request("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email: "new@example.com", firstName: "Ada", lastName: "Lovelace" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("sent");

      const rows = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.email, "new@example.com")).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].pendingFirstName).toBe("Ada");
      expect(rows[0].pendingLastName).toBe("Lovelace");
      expect(rows[0].consumedAt).toBeNull();
    });

    it("issues a token without pending names for an existing user", async () => {
      const db = await makeTestDb();
      await seedUser(db, "existing@example.com");
      const res = await app(db).request("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email: "existing@example.com" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const rows = await db.select().from(magicLinkTokens).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].pendingFirstName).toBeNull();
      expect(rows[0].pendingLastName).toBeNull();
    });

    it("rejects a 4th request in the 15-minute window for the same email", async () => {
      const db = await makeTestDb();
      await seedUser(db, "limit@example.com");
      const r1 = await app(db).request("/auth/magic-link/request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "limit@example.com" }),
      });
      const r2 = await app(db).request("/auth/magic-link/request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "limit@example.com" }),
      });
      const r3 = await app(db).request("/auth/magic-link/request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "limit@example.com" }),
      });
      const r4 = await app(db).request("/auth/magic-link/request", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "limit@example.com" }),
      });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r4.status).toBe(429);
    });

    it("rejects malformed email with 400", async () => {
      const db = await makeTestDb();
      const res = await app(db).request("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("normalizes email to lowercase for user lookup + token storage", async () => {
      const db = await makeTestDb();
      await seedUser(db, "case@example.com");
      const res = await app(db).request("/auth/magic-link/request", {
        method: "POST",
        body: JSON.stringify({ email: "CASE@EXAMPLE.COM" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("sent");
      const rows = await db.select().from(magicLinkTokens).all();
      expect(rows[0].email).toBe("case@example.com");
    });
  });

  describe("GET /auth/magic/verify", () => {
    async function seedToken(db: Db, params: {
      plainToken?: string;
      email: string;
      pendingFirstName?: string | null;
      pendingLastName?: string | null;
      expiresAt?: Date;
      consumedAt?: Date | null;
    }) {
      const plain = params.plainToken ?? "plain-token-abc";
      const now = new Date();
      await db.insert(magicLinkTokens).values({
        id: "mlt-" + plain,
        email: params.email,
        tokenHash: hash(plain),
        pendingFirstName: params.pendingFirstName ?? null,
        pendingLastName: params.pendingLastName ?? null,
        createdAt: now,
        expiresAt: params.expiresAt ?? new Date(now.getTime() + 10 * 60 * 1000),
        consumedAt: params.consumedAt ?? null,
      }).run();
      return plain;
    }

    it("logs an existing user in and consumes the token", async () => {
      const db = await makeTestDb();
      await seedUser(db, "known@example.com");
      const plain = await seedToken(db, { email: "known@example.com" });

      const res = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${DASHBOARD}/dashboard`);
      expect(res.headers.get("set-cookie")).toMatch(/provara_session=/);

      const row = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.tokenHash, hash(plain))).get();
      expect(row?.consumedAt).toBeTruthy();

      const sessionRows = await db.select().from(sessions).all();
      expect(sessionRows).toHaveLength(1);
    });

    it("creates a new user atomically using pending names", async () => {
      const db = await makeTestDb();
      const plain = await seedToken(db, {
        email: "fresh@example.com",
        pendingFirstName: "Grace",
        pendingLastName: "Hopper",
      });

      const res = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${DASHBOARD}/dashboard`);

      const user = await db.select().from(users).where(eq(users.email, "fresh@example.com")).get();
      expect(user).toBeDefined();
      expect(user?.firstName).toBe("Grace");
      expect(user?.lastName).toBe("Hopper");
      expect(user?.name).toBe("Grace Hopper");
      expect(user?.tenantId).toBeTruthy();
      expect(user?.role).toBe("owner");
    });

    it("redirects to /login?error=magic_link_invalid for an unknown token", async () => {
      const db = await makeTestDb();
      const res = await app(db).request(`/auth/magic/verify?token=does-not-exist`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${DASHBOARD}/login?error=magic_link_invalid`);
    });

    it("redirects with magic_link_expired for past-TTL tokens", async () => {
      const db = await makeTestDb();
      await seedUser(db, "a@example.com");
      const plain = await seedToken(db, {
        email: "a@example.com",
        expiresAt: new Date(Date.now() - 1000),
      });
      const res = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(res.headers.get("location")).toBe(`${DASHBOARD}/login?error=magic_link_expired`);
    });

    it("redirects with magic_link_used when token was already consumed", async () => {
      const db = await makeTestDb();
      await seedUser(db, "b@example.com");
      const plain = await seedToken(db, {
        email: "b@example.com",
        consumedAt: new Date(),
      });
      const res = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(res.headers.get("location")).toBe(`${DASHBOARD}/login?error=magic_link_used`);
    });

    it("a second click on a single-use token is rejected (no second session)", async () => {
      const db = await makeTestDb();
      const plain = await seedToken(db, {
        email: "single@example.com",
        pendingFirstName: "Sin",
        pendingLastName: "Gle",
      });
      const r1 = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(r1.status).toBe(302);
      expect(r1.headers.get("location")).toBe(`${DASHBOARD}/dashboard`);

      const r2 = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(r2.headers.get("location")).toBe(`${DASHBOARD}/login?error=magic_link_used`);
      const sessionRows = await db.select().from(sessions).all();
      expect(sessionRows).toHaveLength(1); // only the first one stuck
    });

    it("claims a pending team invite when present", async () => {
      const db = await makeTestDb();
      // Seed the inviter + team invite.
      await seedUser(db, "inviter@example.com", "tenant-inviter");
      const inviteToken = "inv-token-xyz";
      await db.insert(teamInvites).values({
        token: inviteToken,
        tenantId: "tenant-inviter",
        invitedEmail: "invitee@example.com",
        invitedRole: "member",
        invitedByUserId: "u-inviter@example.com",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      }).run();

      const plain = await seedToken(db, {
        email: "invitee@example.com",
        pendingFirstName: "Iona",
        pendingLastName: "Vitee",
      });
      const res = await app(db).request(`/auth/magic/verify?token=${encodeURIComponent(plain)}`);
      expect(res.status).toBe(302);

      const user = await db.select().from(users).where(eq(users.email, "invitee@example.com")).get();
      expect(user?.tenantId).toBe("tenant-inviter");
      expect(user?.role).toBe("member");

      const invite = await db.select().from(teamInvites).where(eq(teamInvites.token, inviteToken)).get();
      expect(invite?.consumedAt).toBeTruthy();
      expect(invite?.consumedByUserId).toBe(user?.id);
    });
  });
});
