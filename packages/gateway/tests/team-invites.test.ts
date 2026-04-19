import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "@provara/db";
import { users, teamInvites, oauthAccounts } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";

// The team routes read the authenticated user via `getAuthUser(req.raw)`
// (populated by the admin middleware in prod). In tests we swap the
// module to read the user from a test header, letting each request
// declare its own "logged-in" user without wiring session cookies.
vi.mock("../src/auth/admin.js", () => ({
  getAuthUser: (req: Request) => {
    const h = req.headers.get("x-test-user");
    if (!h) return null;
    const [id, tenantId, role] = h.split(":");
    return { id, tenantId, role: role as "owner" | "admin" | "developer" | "viewer" };
  },
}));

// Email sending is mocked so tests can assert the invite template was
// dispatched without hitting Resend. Default: "sent ok." Individual
// tests override for "not configured" and "send failed" cases.
const sendEmailMock = vi.fn<
  (args: { to: string; subject: string; html: string; text?: string }) => Promise<{ sent: boolean; skippedReason?: string }>
>();
vi.mock("../src/email/index.js", () => ({
  sendEmail: (args: { to: string; subject: string; html: string; text?: string }) => sendEmailMock(args),
}));

import { createTeamRoutes } from "../src/routes/team.js";
import { getSeatStatus } from "../src/billing/seats.js";
import { upsertUser } from "../src/routes/auth.js";
import type { OAuthProfile } from "../src/auth/oauth.js";

function authHeader(user: { id: string; tenantId: string; role: "owner" | "developer" }) {
  return `${user.id}:${user.tenantId}:${user.role}`;
}

function buildApp(db: Db) {
  const app = new Hono();
  app.route("/v1/admin/team", createTeamRoutes(db));
  return app;
}

async function seedUser(
  db: Db,
  opts: { id: string; tenantId: string; email: string; role?: "owner" | "developer" },
) {
  await db.insert(users).values({
    id: opts.id,
    email: opts.email,
    tenantId: opts.tenantId,
    role: opts.role ?? "developer",
    createdAt: new Date(),
  }).run();
}

async function seedSubscription(db: Db, tenantId: string, tier: "pro" | "team") {
  await grantIntelligenceAccess(db, tenantId, { tier });
}

function profile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    id: "provider-acct-1",
    email: "newbie@example.com",
    emailVerified: true,
    name: "Newbie",
    avatarUrl: null,
    ...overrides,
  };
}

describe("getSeatStatus — seat math (#177)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("free tenant with only the owner has 1/1 used, cannot invite", async () => {
    await seedUser(db, { id: "u1", tenantId: "t1", email: "a@example.com", role: "owner" });
    const s = await getSeatStatus(db, "t1");
    expect(s.tier).toBe("free");
    expect(s.members).toBe(1);
    expect(s.pendingInvites).toBe(0);
    expect(s.used).toBe(1);
    expect(s.limit).toBe(1);
    expect(s.unlimited).toBe(false);
    expect(s.canInvite).toBe(false);
  });

  it("pro tier counts pending invites against the 3-seat quota", async () => {
    await seedUser(db, { id: "u1", tenantId: "t1", email: "owner@example.com", role: "owner" });
    await seedSubscription(db, "t1", "pro");
    await db.insert(teamInvites).values({
      token: "tok-1",
      tenantId: "t1",
      invitedEmail: "pending@example.com",
      invitedRole: "developer",
      invitedByUserId: "u1",
      expiresAt: new Date(Date.now() + 86400_000),
      createdAt: new Date(),
    }).run();
    const s = await getSeatStatus(db, "t1");
    expect(s.tier).toBe("pro");
    expect(s.members).toBe(1);
    expect(s.pendingInvites).toBe(1);
    expect(s.used).toBe(2);
    expect(s.limit).toBe(3);
    expect(s.canInvite).toBe(true);
  });

  it("expired invites do not count against the quota", async () => {
    await seedUser(db, { id: "u1", tenantId: "t1", email: "o@example.com", role: "owner" });
    await seedSubscription(db, "t1", "pro");
    // Three expired invites — none count
    for (let i = 0; i < 3; i++) {
      await db.insert(teamInvites).values({
        token: `expired-${i}`,
        tenantId: "t1",
        invitedEmail: `old${i}@example.com`,
        invitedRole: "developer",
        invitedByUserId: "u1",
        expiresAt: new Date(Date.now() - 86400_000),
        createdAt: new Date(Date.now() - 86400_000 * 10),
      }).run();
    }
    const s = await getSeatStatus(db, "t1");
    expect(s.pendingInvites).toBe(0);
    expect(s.used).toBe(1);
    expect(s.canInvite).toBe(true);
  });

  it("consumed invites do not count against the quota", async () => {
    await seedUser(db, { id: "u1", tenantId: "t1", email: "o@example.com", role: "owner" });
    await seedSubscription(db, "t1", "pro");
    await db.insert(teamInvites).values({
      token: "consumed-1",
      tenantId: "t1",
      invitedEmail: "consumed@example.com",
      invitedRole: "developer",
      invitedByUserId: "u1",
      expiresAt: new Date(Date.now() + 86400_000),
      consumedAt: new Date(),
      consumedByUserId: "u1",
      createdAt: new Date(),
    }).run();
    const s = await getSeatStatus(db, "t1");
    expect(s.pendingInvites).toBe(0);
    expect(s.used).toBe(1);
  });

  it("team tier has 10-seat quota", async () => {
    await seedUser(db, { id: "u1", tenantId: "t1", email: "o@example.com", role: "owner" });
    await seedSubscription(db, "t1", "team");
    const s = await getSeatStatus(db, "t1");
    expect(s.tier).toBe("team");
    expect(s.limit).toBe(10);
    expect(s.unlimited).toBe(false);
  });

  it("operator tenant is treated as unlimited regardless of subscription", async () => {
    process.env.PROVARA_OPERATOR_EMAILS = "ops@corelumen.com";
    await seedUser(db, { id: "u1", tenantId: "t1", email: "ops@corelumen.com", role: "owner" });
    const s = await getSeatStatus(db, "t1");
    expect(s.tier).toBe("operator");
    expect(s.unlimited).toBe(true);
    expect(s.canInvite).toBe(true);
    delete process.env.PROVARA_OPERATOR_EMAILS;
  });
});

describe("Team invite routes (#177)", () => {
  let db: Db;
  const owner = { id: "owner-1", tenantId: "tenant-a", role: "owner" as const };
  // Member fixture lives on a separate tenant so it doesn't consume a
  // seat on tenant-a — we only use it to prove owner-only routes 403.
  const member = { id: "member-1", tenantId: "tenant-b", role: "developer" as const };

  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ sent: true });
    // Pro tier so 3 seats available
    await seedUser(db, { id: owner.id, tenantId: owner.tenantId, email: "owner@example.com", role: "owner" });
    await seedUser(db, { id: member.id, tenantId: member.tenantId, email: "member@example.com", role: "developer" });
    await seedSubscription(db, owner.tenantId, "pro");
  });
  afterEach(() => resetTierEnv());

  describe("POST /invites", () => {
    it("creates an invite, persists it, and sends email with the invite URL", async () => {
      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user": authHeader(owner),
          Origin: "https://dash.test",
        },
        body: JSON.stringify({ email: "NewPerson@Example.com", role: "developer" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.invitedEmail).toBe("newperson@example.com");
      expect(body.invitedRole).toBe("developer");
      expect(body.inviteUrl).toBe(`https://dash.test/invite/${body.token}`);
      expect(body.emailSent).toBe(true);

      const persisted = await db.select().from(teamInvites).all();
      expect(persisted).toHaveLength(1);
      expect(persisted[0].invitedEmail).toBe("newperson@example.com");
      expect(persisted[0].tenantId).toBe(owner.tenantId);

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const sent = sendEmailMock.mock.calls[0][0];
      expect(sent.to).toBe("newperson@example.com");
      expect(sent.html).toContain(body.token);
    });

    it("rejects non-owners with 403", async () => {
      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(member) },
        body: JSON.stringify({ email: "x@example.com", role: "developer" }),
      });
      expect(res.status).toBe(403);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("validates email shape with 400", async () => {
      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(owner) },
        body: JSON.stringify({ email: "not-an-email", role: "developer" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 when inviting an existing team member", async () => {
      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(owner) },
        body: JSON.stringify({ email: "owner@example.com", role: "developer" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.message).toMatch(/already a member/i);
    });

    it("returns 409 when an active invite for that email already exists", async () => {
      const app = buildApp(db);
      const first = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(owner) },
        body: JSON.stringify({ email: "dup@example.com", role: "developer" }),
      });
      expect(first.status).toBe(201);

      const dup = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(owner) },
        body: JSON.stringify({ email: "dup@example.com", role: "developer" }),
      });
      expect(dup.status).toBe(409);
      const body = await dup.json();
      expect(body.error.type).toBe("duplicate_invite");
    });

    it("returns 402 with gate payload when seat limit reached", async () => {
      // Pro = 3 seats. Owner + 2 more members = 3/3. Next invite must 402.
      await seedUser(db, { id: "u-2", tenantId: owner.tenantId, email: "two@example.com", role: "developer" });
      await seedUser(db, { id: "u-3", tenantId: owner.tenantId, email: "three@example.com", role: "developer" });

      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(owner) },
        body: JSON.stringify({ email: "late@example.com", role: "developer" }),
      });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error.type).toBe("seat_limit");
      expect(body.gate).toMatchObject({
        reason: "seat_limit",
        currentTier: "pro",
        used: 3,
        limit: 3,
        upgradeUrl: "/dashboard/billing",
      });
      // No invite row was written
      const persisted = await db.select().from(teamInvites).all();
      expect(persisted).toHaveLength(0);
    });

    it("still persists the invite even if email dispatch fails (non-blocking)", async () => {
      sendEmailMock.mockResolvedValueOnce({ sent: false, skippedReason: "send_failed" });
      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-user": authHeader(owner) },
        body: JSON.stringify({ email: "offline@example.com", role: "developer" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.emailSent).toBe(false);
      expect(body.inviteUrl).toContain("/invite/");
      const persisted = await db.select().from(teamInvites).all();
      expect(persisted).toHaveLength(1);
    });
  });

  describe("GET /invites", () => {
    it("lists only unconsumed unexpired invites for the caller's tenant", async () => {
      // Two active on tenant-a, one expired, one consumed, one on a different tenant
      await db.insert(teamInvites).values([
        {
          token: "active-1",
          tenantId: owner.tenantId,
          invitedEmail: "a1@example.com",
          invitedRole: "developer",
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() + 86400_000),
          createdAt: new Date(),
        },
        {
          token: "active-2",
          tenantId: owner.tenantId,
          invitedEmail: "a2@example.com",
          invitedRole: "developer",
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() + 86400_000),
          createdAt: new Date(),
        },
        {
          token: "expired-1",
          tenantId: owner.tenantId,
          invitedEmail: "old@example.com",
          invitedRole: "developer",
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() - 86400_000),
          createdAt: new Date(Date.now() - 86400_000 * 10),
        },
        {
          token: "consumed-1",
          tenantId: owner.tenantId,
          invitedEmail: "done@example.com",
          invitedRole: "developer",
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() + 86400_000),
          consumedAt: new Date(),
          consumedByUserId: owner.id,
          createdAt: new Date(),
        },
        {
          token: "other-tenant",
          tenantId: "tenant-b",
          invitedEmail: "other@example.com",
          invitedRole: "developer",
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() + 86400_000),
          createdAt: new Date(),
        },
      ]).run();

      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites", {
        headers: { "x-test-user": authHeader(owner) },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const tokens = (body.invites as Array<{ token: string }>).map((i) => i.token).sort();
      expect(tokens).toEqual(["active-1", "active-2"]);
    });
  });

  describe("DELETE /invites/:token", () => {
    it("revokes a pending invite (owner)", async () => {
      await db.insert(teamInvites).values({
        token: "to-revoke",
        tenantId: owner.tenantId,
        invitedEmail: "bye@example.com",
        invitedRole: "developer",
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() + 86400_000),
        createdAt: new Date(),
      }).run();

      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites/to-revoke", {
        method: "DELETE",
        headers: { "x-test-user": authHeader(owner) },
      });
      expect(res.status).toBe(200);
      const remaining = await db.select().from(teamInvites).all();
      expect(remaining).toHaveLength(0);
    });

    it("returns 409 when revoking an already-consumed invite", async () => {
      await db.insert(teamInvites).values({
        token: "used-up",
        tenantId: owner.tenantId,
        invitedEmail: "gone@example.com",
        invitedRole: "developer",
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() + 86400_000),
        consumedAt: new Date(),
        consumedByUserId: owner.id,
        createdAt: new Date(),
      }).run();

      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites/used-up", {
        method: "DELETE",
        headers: { "x-test-user": authHeader(owner) },
      });
      expect(res.status).toBe(409);
      // Row still there — we don't destroy consumed invites
      const remaining = await db.select().from(teamInvites).all();
      expect(remaining).toHaveLength(1);
    });

    it("returns 404 for invites from another tenant", async () => {
      await db.insert(teamInvites).values({
        token: "not-mine",
        tenantId: "tenant-b",
        invitedEmail: "x@example.com",
        invitedRole: "developer",
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() + 86400_000),
        createdAt: new Date(),
      }).run();

      const app = buildApp(db);
      const res = await app.request("/v1/admin/team/invites/not-mine", {
        method: "DELETE",
        headers: { "x-test-user": authHeader(owner) },
      });
      expect(res.status).toBe(404);
    });

    it("rejects non-owners with 403", async () => {
      await db.insert(teamInvites).values({
        token: "tok",
        tenantId: owner.tenantId,
        invitedEmail: "x@example.com",
        invitedRole: "developer",
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() + 86400_000),
        createdAt: new Date(),
      }).run();

      const app = buildApp(db);
      // Seed a member on the same tenant (current member fixture is on tenant-a too... wait no,
      // fixture has member on tenant-a:member role? Actually: member fixture is tenantId "tenant-a"
      // and role "developer" — same tenant.
      const res = await app.request("/v1/admin/team/invites/tok", {
        method: "DELETE",
        headers: { "x-test-user": `${member.id}:${owner.tenantId}:member` },
      });
      expect(res.status).toBe(403);
    });
  });
});

describe("OAuth invite claim (#177)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ sent: true });
  });

  async function seedInvite(
    db: Db,
    opts: {
      token?: string;
      tenantId: string;
      email: string;
      role?: "owner" | "developer";
      expiresAt?: Date;
      consumedAt?: Date | null;
      invitedByUserId?: string;
      consumedByUserId?: string;
    },
  ) {
    await db.insert(teamInvites).values({
      token: opts.token ?? `tok-${opts.email}`,
      tenantId: opts.tenantId,
      invitedEmail: opts.email,
      invitedRole: opts.role ?? "developer",
      invitedByUserId: opts.invitedByUserId ?? "inv-owner",
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86400_000),
      consumedAt: opts.consumedAt ?? null,
      consumedByUserId: opts.consumedByUserId,
      createdAt: new Date(),
    }).run();
  }

  it("new signup with matching pending invite lands on inviter's tenant with invite role", async () => {
    // Seed inviter and their pending invite
    await seedUser(db, { id: "inv-owner", tenantId: "team-alpha", email: "owner@alpha.com", role: "owner" });
    await seedInvite(db, { tenantId: "team-alpha", email: "newbie@example.com", role: "developer" });

    const user = await upsertUser(db, "google", profile());
    expect(user.tenantId).toBe("team-alpha");
    expect(user.role).toBe("developer");

    const claimed = await db.select().from(teamInvites).where(eq(teamInvites.invitedEmail, "newbie@example.com")).get();
    expect(claimed?.consumedAt).toBeTruthy();
    expect(claimed?.consumedByUserId).toBe(user.id);
  });

  it("claim does NOT fire welcome email (invitee already received invite email)", async () => {
    await seedUser(db, { id: "inv-owner", tenantId: "team-alpha", email: "owner@alpha.com", role: "owner" });
    await seedInvite(db, { tenantId: "team-alpha", email: "newbie@example.com" });
    await upsertUser(db, "google", profile());
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("fresh signup with no pending invite gets new tenant, owner role, and a welcome email", async () => {
    const user = await upsertUser(db, "google", profile({ email: "solo@example.com" }));
    expect(user.role).toBe("owner");
    expect(user.tenantId).toBeTruthy();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("solo@example.com");
    expect(sendEmailMock.mock.calls[0][0].subject).toMatch(/welcome/i);
  });

  it("expired invite is NOT claimed — user gets a fresh tenant instead", async () => {
    await seedUser(db, { id: "inv-owner", tenantId: "team-alpha", email: "owner@alpha.com", role: "owner" });
    await seedInvite(db, {
      tenantId: "team-alpha",
      email: "newbie@example.com",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const user = await upsertUser(db, "google", profile());
    expect(user.tenantId).not.toBe("team-alpha");
    expect(user.role).toBe("owner");
    // Welcome email goes out since this is a fresh signup, not a claim
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("unverified email does NOT claim an invite (defense-in-depth on #182 gate)", async () => {
    await seedUser(db, { id: "inv-owner", tenantId: "team-alpha", email: "owner@alpha.com", role: "owner" });
    await seedInvite(db, { tenantId: "team-alpha", email: "newbie@example.com" });

    const user = await upsertUser(db, "github", profile({ emailVerified: false }));
    expect(user.tenantId).not.toBe("team-alpha");
    expect(user.role).toBe("owner");

    const invite = await db.select().from(teamInvites).where(eq(teamInvites.invitedEmail, "newbie@example.com")).get();
    expect(invite?.consumedAt).toBeNull();
  });

  it("email comparison is case-insensitive", async () => {
    await seedUser(db, { id: "inv-owner", tenantId: "team-alpha", email: "owner@alpha.com", role: "owner" });
    await seedInvite(db, { tenantId: "team-alpha", email: "newbie@example.com" });

    const user = await upsertUser(db, "google", profile({ email: "Newbie@Example.COM" }));
    expect(user.tenantId).toBe("team-alpha");
  });

  it("already-consumed invite is not re-claimed", async () => {
    await seedUser(db, { id: "inv-owner", tenantId: "team-alpha", email: "owner@alpha.com", role: "owner" });
    await seedInvite(db, {
      tenantId: "team-alpha",
      email: "newbie@example.com",
      consumedAt: new Date(Date.now() - 60_000),
    });

    const user = await upsertUser(db, "google", profile());
    expect(user.tenantId).not.toBe("team-alpha");
    expect(user.role).toBe("owner");
  });
});


describe("DELETE /v1/admin/team/:id (member removal)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("removes a member whose user row has an attached oauth_accounts (regression for #209 UAT)", async () => {
    // Repro of the live edge case: a member who authenticated via
    // Google OAuth before their tenant enabled SSO carries an
    // oauth_accounts row. The original remove path deleted sessions +
    // users but not oauth_accounts → SQLite refused the user DELETE
    // with a FOREIGN KEY constraint → 500 → dashboard generic error.
    const ownerId = "owner-1";
    const memberId = "member-1";
    await seedUser(db, { id: ownerId, tenantId: "t-1", email: "owner@example.com", role: "owner" });
    await seedUser(db, { id: memberId, tenantId: "t-1", email: "member@example.com", role: "developer" });
    await db.insert(oauthAccounts).values({
      id: "oauth-1",
      userId: memberId,
      provider: "google",
      providerAccountId: "google-acct-xyz",
      email: "member@example.com",
      createdAt: new Date(),
    }).run();

    const app = buildApp(db);
    const res = await app.request(`/v1/admin/team/${memberId}`, {
      method: "DELETE",
      headers: {
        "x-test-user": authHeader({ id: ownerId, tenantId: "t-1", role: "owner" }),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    // All three rows gone — user and the oauth_accounts that referenced it.
    const usersLeft = await db.select().from(users).where(eq(users.id, memberId)).all();
    expect(usersLeft).toHaveLength(0);
    const oauthLeft = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, memberId)).all();
    expect(oauthLeft).toHaveLength(0);
  });

  it("preserves team_invites history — consumed_by_user_id is nulled, not cascaded", async () => {
    const ownerId = "owner-1";
    const memberId = "member-1";
    await seedUser(db, { id: ownerId, tenantId: "t-1", email: "owner@example.com", role: "owner" });
    await seedUser(db, { id: memberId, tenantId: "t-1", email: "member@example.com", role: "developer" });
    await db.insert(teamInvites).values({
      token: "inv-1",
      tenantId: "t-1",
      invitedEmail: "member@example.com",
      invitedRole: "developer",
      invitedByUserId: ownerId,
      consumedByUserId: memberId,
      consumedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }).run();

    const app = buildApp(db);
    const res = await app.request(`/v1/admin/team/${memberId}`, {
      method: "DELETE",
      headers: {
        "x-test-user": authHeader({ id: ownerId, tenantId: "t-1", role: "owner" }),
      },
    });
    expect(res.status).toBe(200);

    const invite = await db.select().from(teamInvites).where(eq(teamInvites.token, "inv-1")).get();
    expect(invite).toBeTruthy();
    expect(invite?.consumedByUserId).toBeNull();
    expect(invite?.consumedAt).toBeTruthy(); // audit trail preserved
  });

  it("deletes team_invites where the removed user was the inviter (NOT NULL FK)", async () => {
    const ownerId = "owner-1";
    const inviterId = "member-inviter";
    await seedUser(db, { id: ownerId, tenantId: "t-1", email: "owner@example.com", role: "owner" });
    await seedUser(db, { id: inviterId, tenantId: "t-1", email: "inviter@example.com", role: "developer" });
    await db.insert(teamInvites).values({
      token: "inv-2",
      tenantId: "t-1",
      invitedEmail: "pending@example.com",
      invitedRole: "developer",
      invitedByUserId: inviterId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }).run();

    const app = buildApp(db);
    const res = await app.request(`/v1/admin/team/${inviterId}`, {
      method: "DELETE",
      headers: {
        "x-test-user": authHeader({ id: ownerId, tenantId: "t-1", role: "owner" }),
      },
    });
    expect(res.status).toBe(200);

    const inviteLeft = await db.select().from(teamInvites).where(eq(teamInvites.token, "inv-2")).all();
    expect(inviteLeft).toHaveLength(0);
  });
});
