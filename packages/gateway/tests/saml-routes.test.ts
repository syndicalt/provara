import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Db } from "@provara/db";
import { ssoConfigs, users } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";
import {
  createSamlAuthRoutes,
  upsertUserFromSso,
} from "../src/routes/auth-saml.js";

function buildApp(db: Db) {
  const app = new Hono();
  app.route("/auth/saml", createSamlAuthRoutes(db));
  return app;
}

async function seedSso(db: Db, tenantId: string, domains: string[] = ["acme.com"]) {
  const now = new Date();
  await db
    .insert(ssoConfigs)
    .values({
      tenantId,
      idpEntityId: "https://idp.example.com/saml/metadata",
      idpSsoUrl: "https://idp.example.com/saml/sso",
      idpCert:
        "MIIDazCCAlOgAwIBAgIUFixture0000000000000000000000000wDQYJKoZIhvcNAQELBQAw" +
        "RTELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdp",
      spEntityId: `https://gateway.provara.xyz/saml/${tenantId}`,
      emailDomains: domains,
      requireEncryption: false,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("GET /auth/saml/discover", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns sso:true with a startUrl for an SSO-enabled domain", async () => {
    await seedSso(db, "tenant-acme");
    const app = buildApp(db);
    const res = await app.request("/auth/saml/discover?email=alice@acme.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sso).toBe(true);
    expect(body.startUrl).toBe("/auth/saml/start?email=alice%40acme.com");
    expect(body.tenantId).toBe("tenant-acme");
  });

  it("returns sso:false for an unknown domain", async () => {
    await seedSso(db, "tenant-acme");
    const app = buildApp(db);
    const res = await app.request("/auth/saml/discover?email=alice@other.com");
    const body = await res.json();
    expect(body.sso).toBe(false);
  });

  it("returns sso:false for missing email", async () => {
    const app = buildApp(db);
    const res = await app.request("/auth/saml/discover");
    const body = await res.json();
    expect(body.sso).toBe(false);
  });
});

describe("GET /auth/saml/start", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("302s to the IdP SSO URL for a configured domain", async () => {
    await seedSso(db, "tenant-acme");
    const app = buildApp(db);
    const res = await app.request("/auth/saml/start?email=alice@acme.com");
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toMatch(/^https:\/\/idp\.example\.com\/saml\/sso\?SAMLRequest=/);
  });

  it("redirects to /login?error=sso_not_configured for an unknown domain", async () => {
    await seedSso(db, "tenant-acme");
    const app = buildApp(db);
    const res = await app.request("/auth/saml/start?email=alice@other.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=sso_not_configured");
  });

  it("redirects to /login?error=sso_no_email when email param is missing", async () => {
    const app = buildApp(db);
    const res = await app.request("/auth/saml/start");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=sso_no_email");
  });
});

describe("GET /auth/saml/metadata/:tenantId", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("returns SP metadata XML for an Enterprise tenant with SSO configured", async () => {
    // Tier gate now reads the URL-path tenantId, so no mocked tenant
    // header is needed — the IdP will POST to this URL without any
    // Provara session. This is the whole point of the fix.
    await seedSso(db, "tenant-ent");
    await grantIntelligenceAccess(db, "tenant-ent", { tier: "enterprise" });
    const app = buildApp(db);
    const res = await app.request("/auth/saml/metadata/tenant-ent");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("samlmetadata+xml");
    const xml = await res.text();
    expect(xml).toContain("tenant-ent");
  });

  it("returns 404 when the URL-path tenant is not on Enterprise", async () => {
    await seedSso(db, "tenant-pro");
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro" });
    const app = buildApp(db);
    const res = await app.request("/auth/saml/metadata/tenant-pro");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("not_configured");
  });

  it("returns 404 when SSO is not configured at all", async () => {
    await grantIntelligenceAccess(db, "tenant-ent", { tier: "enterprise" });
    const app = buildApp(db);
    const res = await app.request("/auth/saml/metadata/tenant-ent");
    expect(res.status).toBe(404);
  });
});

describe("POST /auth/saml/acs/:tenantId (tier gate)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("redirects to /login?error=sso_tier_revoked when the URL-path tenant is not Enterprise", async () => {
    await seedSso(db, "tenant-pro");
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro" });
    const app = buildApp(db);
    const form = new URLSearchParams({ SAMLResponse: "anything" });
    const res = await app.request("/auth/saml/acs/tenant-pro", {
      method: "POST",
      body: form.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=sso_tier_revoked");
  });

  it("does NOT require a Provara session (unauthenticated IdP POST is the whole flow)", async () => {
    // With the bug: the middleware would 401 here because no session →
    // no getTenantId. With the fix: the URL-path tenant is what gates.
    // The forged SAMLResponse will fail validation after the gate passes,
    // so expect redirect to an sso_invalid_response error, not a 401.
    await seedSso(db, "tenant-ent");
    await grantIntelligenceAccess(db, "tenant-ent", { tier: "enterprise" });
    const app = buildApp(db);
    const form = new URLSearchParams({ SAMLResponse: "forged-not-a-real-response" });
    const res = await app.request("/auth/saml/acs/tenant-ent", {
      method: "POST",
      body: form.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=sso_invalid_response");
  });
});

describe("upsertUserFromSso", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("creates a new user on the SSO tenant when none exists", async () => {
    const result = await upsertUserFromSso(db, {
      tenantId: "tenant-acme",
      email: "alice@acme.com",
      firstName: "Alice",
      lastName: "Anderson",
    });
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.user.tenantId).toBe("tenant-acme");
      expect(result.user.email).toBe("alice@acme.com");
      expect(result.user.role).toBe("developer");
      expect(result.user.firstName).toBe("Alice");
    }
  });

  it("normalizes email to lowercase", async () => {
    const result = await upsertUserFromSso(db, {
      tenantId: "tenant-acme",
      email: "Alice@ACME.COM",
      firstName: null,
      lastName: null,
    });
    if (result.kind === "created") {
      expect(result.user.email).toBe("alice@acme.com");
    } else {
      throw new Error("expected created");
    }
  });

  it("returns existing for a user already on the same tenant", async () => {
    await db.insert(users).values({
      id: "u1",
      email: "alice@acme.com",
      tenantId: "tenant-acme",
      role: "owner",
      createdAt: new Date(),
    }).run();

    const result = await upsertUserFromSso(db, {
      tenantId: "tenant-acme",
      email: "alice@acme.com",
      firstName: null,
      lastName: null,
    });
    expect(result.kind).toBe("existing");
    if (result.kind === "existing") {
      expect(result.user.id).toBe("u1");
      // Role was "owner" (pre-SSO invite path) and should be preserved.
      expect(result.user.role).toBe("owner");
    }
  });

  it("refuses with cross_tenant_collision when the email is on another tenant", async () => {
    await db.insert(users).values({
      id: "u2",
      email: "alice@acme.com",
      tenantId: "tenant-other",
      role: "owner",
      createdAt: new Date(),
    }).run();

    const result = await upsertUserFromSso(db, {
      tenantId: "tenant-acme",
      email: "alice@acme.com",
      firstName: null,
      lastName: null,
    });
    expect(result.kind).toBe("cross_tenant_collision");
    if (result.kind === "cross_tenant_collision") {
      expect(result.existingTenantId).toBe("tenant-other");
    }

    // Verify we did NOT silently create a duplicate row.
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, "alice@acme.com"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe("tenant-other");
  });
});
