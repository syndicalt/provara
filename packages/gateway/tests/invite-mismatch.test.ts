import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@provara/db";
import { teamInvites, users } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import {
  detectInviteEmailMismatch,
  buildPostOauthRedirect,
} from "../src/auth/invite-mismatch.js";

async function seedInviter(db: Db) {
  await db.insert(users).values({
    id: "u-owner",
    email: "owner@acme.com",
    tenantId: "t-acme",
    role: "owner",
    createdAt: new Date(),
  }).run();
}

async function seedInvite(
  db: Db,
  overrides: Partial<{
    token: string;
    invitedEmail: string;
    consumedAt: Date | null;
  }> = {},
) {
  await db.insert(teamInvites).values({
    token: overrides.token ?? "inv-token-1",
    tenantId: "t-acme",
    invitedEmail: overrides.invitedEmail ?? "bob@acme.com",
    invitedRole: "member",
    invitedByUserId: "u-owner",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    consumedAt: overrides.consumedAt ?? null,
    createdAt: new Date(),
  }).run();
}

describe("#189 — invite-email mismatch detector", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    await seedInviter(db);
  });

  it("returns null when no token was threaded through the flow", async () => {
    await seedInvite(db);
    const result = await detectInviteEmailMismatch(db, null, "alice@example.com");
    expect(result).toBeNull();
  });

  it("returns null when the token is unknown", async () => {
    await seedInvite(db);
    const result = await detectInviteEmailMismatch(db, "bogus-token", "alice@example.com");
    expect(result).toBeNull();
  });

  it("returns null when the invite was already consumed", async () => {
    await seedInvite(db, { consumedAt: new Date() });
    const result = await detectInviteEmailMismatch(db, "inv-token-1", "alice@example.com");
    expect(result).toBeNull();
  });

  it("returns null when the emails match (case-insensitive)", async () => {
    await seedInvite(db, { invitedEmail: "Bob@Acme.com" });
    const result = await detectInviteEmailMismatch(db, "inv-token-1", "BOB@acme.com");
    expect(result).toBeNull();
  });

  it("returns the expected email when OAuth email differs from invited email", async () => {
    await seedInvite(db, { invitedEmail: "bob@acme.com" });
    const result = await detectInviteEmailMismatch(db, "inv-token-1", "alice@example.com");
    expect(result).toEqual({ expected: "bob@acme.com" });
  });

  it("returns null when profile email is missing (provider didn't return one)", async () => {
    await seedInvite(db);
    const result = await detectInviteEmailMismatch(db, "inv-token-1", null);
    expect(result).toBeNull();
  });
});

describe("#189 — post-OAuth redirect builder", () => {
  it("honors returnTo when there's no mismatch", () => {
    const url = buildPostOauthRedirect("http://app.local", "/dashboard/audit", null);
    expect(url).toBe("http://app.local/dashboard/audit");
  });

  it("clamps to /dashboard and encodes the mismatch state when present", () => {
    const url = buildPostOauthRedirect("http://app.local", "/dashboard/audit", {
      expected: "bob@acme.com",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/dashboard");
    expect(parsed.searchParams.get("invite_status")).toBe("wrong_email");
    expect(parsed.searchParams.get("expected")).toBe("bob@acme.com");
  });

  it("URL-encodes special characters in the expected email", () => {
    const url = buildPostOauthRedirect("http://app.local", "/dashboard", {
      expected: "bob+invite@acme.com",
    });
    expect(url).toContain("expected=bob%2Binvite%40acme.com");
  });
});
