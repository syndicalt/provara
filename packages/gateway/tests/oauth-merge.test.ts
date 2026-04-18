import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { users, oauthAccounts } from "@provara/db";
import type { Db } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { upsertUser, OAuthMergeRefusedError } from "../src/routes/auth.js";
import type { OAuthProfile } from "../src/auth/oauth.js";

function profile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    id: "provider-account-123",
    email: "user@example.com",
    emailVerified: true,
    name: "Test User",
    avatarUrl: "https://example.com/a.png",
    ...overrides,
  };
}

describe("OAuth account-merge gate (#182)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("first signup creates a new user + tenant, no merge", async () => {
    const user = await upsertUser(db, "google", profile());
    expect(user.email).toBe("user@example.com");
    expect(user.tenantId).toBeTruthy();
    expect(user.role).toBe("owner");

    const all = await db.select().from(users).all();
    expect(all).toHaveLength(1);
  });

  it("returning same provider+id returns the same user (no duplicate)", async () => {
    const first = await upsertUser(db, "google", profile({ id: "prov-1" }));
    const second = await upsertUser(db, "google", profile({ id: "prov-1" }));
    expect(second.id).toBe(first.id);
    expect(second.tenantId).toBe(first.tenantId);

    const all = await db.select().from(users).all();
    expect(all).toHaveLength(1);
  });

  it("second provider with same VERIFIED email merges to existing user", async () => {
    const google = await upsertUser(db, "google", profile({ id: "g-1", emailVerified: true }));
    const github = await upsertUser(db, "github", profile({ id: "gh-1", emailVerified: true }));

    // Same user, same tenant
    expect(github.id).toBe(google.id);
    expect(github.tenantId).toBe(google.tenantId);

    // Both OAuth accounts linked to that user
    const accounts = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, google.id)).all();
    expect(accounts).toHaveLength(2);
    const providers = accounts.map((a) => a.provider).sort();
    expect(providers).toEqual(["github", "google"]);
  });

  it("second provider with UNVERIFIED email of an existing user is REFUSED", async () => {
    // User signs up via Google with verified email
    await upsertUser(db, "google", profile({ id: "g-1", emailVerified: true }));

    // Attacker tries to claim same email via a hypothetical unverified provider
    await expect(
      upsertUser(db, "github", profile({ id: "gh-1", emailVerified: false })),
    ).rejects.toThrow(OAuthMergeRefusedError);

    // No new OAuth account was linked
    const accounts = await db.select().from(oauthAccounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].provider).toBe("google");
  });

  it("first signup with UNVERIFIED email still creates the account (no existing user to protect)", async () => {
    const user = await upsertUser(db, "github", profile({ emailVerified: false }));
    expect(user.email).toBe("user@example.com");
    // Verified flag only gates the MERGE path, not fresh signup — the latter
    // is idempotent (no pre-existing claim to protect).
  });

  it("merge-refused leaves the existing user's tenant untouched", async () => {
    const original = await upsertUser(db, "google", profile({ id: "g-1", emailVerified: true }));

    try {
      await upsertUser(db, "github", profile({ id: "gh-1", emailVerified: false }));
    } catch {
      // Expected — swallow
    }

    const users_ = await db.select().from(users).where(eq(users.email, "user@example.com")).all();
    expect(users_).toHaveLength(1);
    expect(users_[0].tenantId).toBe(original.tenantId);
  });
});
