import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@provara/db";
import { ssoConfigs } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import {
  getActiveSsoConfig,
  findSsoConfigForEmail,
  acsUrlFor,
  defaultSpEntityIdFor,
  buildMetadataXml,
  buildLoginRequestUrl,
  extractEmailFromProfile,
} from "../src/auth/saml.js";

const GATEWAY = "https://gateway.provara.xyz";

async function seedConfig(
  db: Db,
  overrides: Partial<{
    tenantId: string;
    status: "active" | "disabled";
    emailDomains: string[];
    idpSsoUrl: string;
    idpEntityId: string;
    idpCert: string;
    spEntityId: string;
  }> = {},
) {
  const now = new Date();
  const values = {
    tenantId: overrides.tenantId ?? "tenant-acme",
    idpEntityId: overrides.idpEntityId ?? "https://idp.example.com/saml/metadata",
    idpSsoUrl: overrides.idpSsoUrl ?? "https://idp.example.com/saml/sso",
    // Fixture X.509 cert, self-signed, 2048-bit, used only for library
    // construction paths that don't perform signature verification. Tests
    // that hit validatePostResponseAsync are deferred to staging QA since
    // generating signed SAML responses in a unit test needs the IdP's
    // private key too.
    idpCert: overrides.idpCert ??
      "MIIDazCCAlOgAwIBAgIUFixture0000000000000000000000000wDQYJKoZIhvcNAQELBQAwRTELMAkGA1UEBhMC" +
      "VVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0y",
    spEntityId: overrides.spEntityId ?? `${GATEWAY}/saml/${overrides.tenantId ?? "tenant-acme"}`,
    emailDomains: overrides.emailDomains ?? ["acme.com"],
    requireEncryption: false,
    status: overrides.status ?? ("active" as const),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(ssoConfigs).values(values).run();
}

describe("getActiveSsoConfig", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns config for an active row", async () => {
    await seedConfig(db);
    const cfg = await getActiveSsoConfig(db, "tenant-acme");
    expect(cfg).not.toBeNull();
    expect(cfg?.tenantId).toBe("tenant-acme");
    expect(cfg?.emailDomains).toEqual(["acme.com"]);
  });

  it("returns null when the row is disabled", async () => {
    await seedConfig(db, { status: "disabled" });
    expect(await getActiveSsoConfig(db, "tenant-acme")).toBeNull();
  });

  it("returns null when no row exists", async () => {
    expect(await getActiveSsoConfig(db, "nonexistent")).toBeNull();
  });
});

describe("findSsoConfigForEmail", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("finds a tenant by email domain match", async () => {
    await seedConfig(db, { tenantId: "tenant-acme", emailDomains: ["acme.com"] });
    const cfg = await findSsoConfigForEmail(db, "user@acme.com");
    expect(cfg?.tenantId).toBe("tenant-acme");
  });

  it("is case-insensitive on the domain", async () => {
    await seedConfig(db, { tenantId: "tenant-acme", emailDomains: ["Acme.com"] });
    const cfg = await findSsoConfigForEmail(db, "User@ACME.COM");
    expect(cfg?.tenantId).toBe("tenant-acme");
  });

  it("ignores disabled rows", async () => {
    await seedConfig(db, { tenantId: "tenant-acme", status: "disabled" });
    expect(await findSsoConfigForEmail(db, "user@acme.com")).toBeNull();
  });

  it("returns null for unmatched domains", async () => {
    await seedConfig(db, { emailDomains: ["acme.com"] });
    expect(await findSsoConfigForEmail(db, "user@other.com")).toBeNull();
  });

  it("returns null for malformed emails", async () => {
    await seedConfig(db);
    expect(await findSsoConfigForEmail(db, "not-an-email")).toBeNull();
    expect(await findSsoConfigForEmail(db, "")).toBeNull();
  });

  it("matches multi-domain allowlists", async () => {
    await seedConfig(db, { tenantId: "tenant-acme", emailDomains: ["acme.com", "acme.co.uk"] });
    expect((await findSsoConfigForEmail(db, "x@acme.co.uk"))?.tenantId).toBe("tenant-acme");
  });
});

describe("URL helpers", () => {
  it("builds the ACS URL with the tenant encoded", () => {
    expect(acsUrlFor("https://gateway.provara.xyz", "tenant-acme")).toBe(
      "https://gateway.provara.xyz/auth/saml/acs/tenant-acme",
    );
  });

  it("percent-encodes special tenant IDs", () => {
    expect(acsUrlFor("https://gateway.provara.xyz", "tenant/with space")).toBe(
      "https://gateway.provara.xyz/auth/saml/acs/tenant%2Fwith%20space",
    );
  });

  it("strips trailing slash from the base URL", () => {
    expect(acsUrlFor("https://gateway.provara.xyz/", "x")).toBe(
      "https://gateway.provara.xyz/auth/saml/acs/x",
    );
  });

  it("builds a deterministic default SP entity ID", () => {
    expect(defaultSpEntityIdFor("https://gateway.provara.xyz", "tenant-acme")).toBe(
      "https://gateway.provara.xyz/saml/tenant-acme",
    );
  });
});

describe("buildMetadataXml", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns null when SSO is not configured", async () => {
    expect(await buildMetadataXml(db, "no-such", GATEWAY)).toBeNull();
  });

  it("includes the SP entity ID and ACS URL for an active tenant", async () => {
    await seedConfig(db);
    const xml = await buildMetadataXml(db, "tenant-acme", GATEWAY);
    expect(xml).toBeTruthy();
    expect(xml).toContain(`${GATEWAY}/saml/tenant-acme`);
    expect(xml).toContain(`${GATEWAY}/auth/saml/acs/tenant-acme`);
  });
});

describe("buildLoginRequestUrl", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("throws when SSO is not configured for the tenant", async () => {
    await expect(buildLoginRequestUrl(db, "no-such", GATEWAY)).rejects.toThrow(/SSO not configured/);
  });

  it("returns a URL pointing at the IdP's SSO endpoint", async () => {
    await seedConfig(db, {
      idpSsoUrl: "https://idp.example.com/saml/sso",
    });
    const url = await buildLoginRequestUrl(db, "tenant-acme", GATEWAY);
    expect(url).toMatch(/^https:\/\/idp\.example\.com\/saml\/sso\?SAMLRequest=/);
    // RelayState carries the tenantId for optional round-trip continuity;
    // the ACS handler does NOT trust it — it uses the URL-path tenant ID.
    expect(url).toMatch(/RelayState=tenant-acme/);
  });
});

describe("extractEmailFromProfile", () => {
  it("prefers the email attribute when present", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = { email: "User@Example.com", nameID: "something-else" } as any;
    expect(extractEmailFromProfile(profile)).toBe("user@example.com");
  });

  it("falls back to NameID when it looks like an email", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = { nameID: "User@Example.com" } as any;
    expect(extractEmailFromProfile(profile)).toBe("user@example.com");
  });

  it("returns null when neither is an email", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = { nameID: "opaque-identifier-12345" } as any;
    expect(extractEmailFromProfile(profile)).toBeNull();
  });
});
