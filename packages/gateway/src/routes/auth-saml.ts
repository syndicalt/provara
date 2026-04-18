import { Hono } from "hono";
import type { Db } from "@provara/db";
import { users } from "@provara/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  acsUrlFor,
  buildLoginRequestUrl,
  buildMetadataXml,
  extractEmailFromProfile,
  findSsoConfigForEmail,
  getActiveSsoConfig,
  validatePostResponse,
} from "../auth/saml.js";
import { createSession, setSessionCookie } from "../auth/session.js";
import { tenantHasEnterpriseAccess } from "../auth/tier.js";
import { emitAudit } from "../audit/emit.js";
import { AUDIT_AUTH_LOGIN_SUCCESS } from "../audit/actions.js";

/**
 * SAML SSO routes (#209). Mounted at `/auth/saml`. Per-tenant flow:
 *
 *   GET  /auth/saml/discover?email=...    email → { sso: bool, startUrl? }
 *   GET  /auth/saml/start?email=...       email → 302 IdP
 *   POST /auth/saml/acs/:tenantId         IdP  → session cookie + 302 dashboard
 *   GET  /auth/saml/metadata/:tenantId    SP metadata XML for IdP setup
 *
 * JIT provisioning (#209 design call: pure JIT, trust the IdP): first
 * login from an email in the tenant's allowlist creates the local user
 * row. Cross-tenant email collisions (same email already on a different
 * tenant) are refused — the operator has to manually resolve.
 *
 * Enterprise-tier gated at the start / ACS / metadata entry points so
 * free/pro/team rows with an accidentally-seeded config can't become an
 * auth backdoor.
 */
const DASHBOARD_URL = () => process.env.DASHBOARD_URL || "http://localhost:3000";
const GATEWAY_PUBLIC_URL = () => process.env.OAUTH_REDIRECT_BASE || "http://localhost:4000";

export function createSamlAuthRoutes(db: Db) {
  const app = new Hono();

  /**
   * Discovery endpoint used by `/login`: given an email, returns whether
   * SSO is active for that email's domain and (if so) the start URL.
   * Not gated — the login page for unauthenticated users needs it.
   * Leaks only the existence of SSO for a domain, which is public info
   * anyway once you've enabled it (the IdP's allowlist IS the domain).
   */
  app.get("/discover", async (c) => {
    const email = c.req.query("email")?.trim();
    if (!email) return c.json({ sso: false });
    const config = await findSsoConfigForEmail(db, email);
    if (!config) return c.json({ sso: false });
    const startUrl = `/auth/saml/start?email=${encodeURIComponent(email)}`;
    return c.json({ sso: true, startUrl, tenantId: config.tenantId });
  });

  /**
   * SP-initiated flow: redirect the user to their IdP. Resolves the
   * tenant by email-domain match against active SSO configs.
   */
  app.get("/start", async (c) => {
    const email = c.req.query("email")?.trim();
    if (!email) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_no_email`);
    }
    const config = await findSsoConfigForEmail(db, email);
    if (!config) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_not_configured`);
    }
    try {
      const url = await buildLoginRequestUrl(db, config.tenantId, GATEWAY_PUBLIC_URL());
      return c.redirect(url);
    } catch (err) {
      console.error(`[saml] start failed for tenant ${config.tenantId}:`, err);
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_start_failed`);
    }
  });

  /**
   * Assertion Consumer Service. Accepts both SP- and IdP-initiated POSTs
   * (the per-tenant URL means RelayState isn't needed to identify the
   * tenant). Validates the response, JIT-provisions, issues a session,
   * redirects to the dashboard.
   */
  app.post("/acs/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_missing_tenant`);
    }

    // Tier gate uses the URL-path tenantId, NOT the caller's session —
    // the caller is mid-login and has no session yet. This is the whole
    // point of ACS. Check the tenant that owns the config row; refuse
    // if they're not on Enterprise (defense in depth — ops shouldn't
    // have seeded sso_configs for a non-Enterprise tenant, but if they
    // did, we don't want the free account to be a back-door SSO bypass).
    if (!(await tenantHasEnterpriseAccess(db, tenantId))) {
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_tier_revoked`);
    }

    const form = await c.req.parseBody();
    const samlResponse = form.SAMLResponse;
    if (typeof samlResponse !== "string") {
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_invalid_response`);
    }

    let profile;
    try {
      const validated = await validatePostResponse(
        db,
        tenantId,
        form as Record<string, string>,
        GATEWAY_PUBLIC_URL(),
      );
      profile = validated.profile;
    } catch (err) {
      console.warn(`[saml] response validation failed for tenant ${tenantId}:`, err);
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_invalid_response`);
    }

    const email = extractEmailFromProfile(profile);
    if (!email) {
      console.warn(`[saml] no email in profile for tenant ${tenantId}`);
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_no_email_in_assertion`);
    }

    const result = await upsertUserFromSso(db, {
      tenantId,
      email,
      firstName: typeof profile.firstName === "string" ? profile.firstName : null,
      lastName: typeof profile.lastName === "string" ? profile.lastName : null,
    });

    if (result.kind === "cross_tenant_collision") {
      console.warn(
        `[saml] refused login: email ${email} already on tenant ${result.existingTenantId}, SSO for tenant ${tenantId}`,
      );
      return c.redirect(`${DASHBOARD_URL()}/login?error=sso_email_on_other_tenant`);
    }

    const sessionId = await createSession(db, result.user.id);
    setSessionCookie(c, sessionId);
    emitAudit(db, {
      tenantId: result.user.tenantId,
      actorUserId: result.user.id,
      actorEmail: result.user.email,
      action: AUDIT_AUTH_LOGIN_SUCCESS,
      metadata: { method: "saml", jit: result.kind === "created" },
    });
    return c.redirect(`${DASHBOARD_URL()}/dashboard`);
  });

  /**
   * SP metadata XML. Enterprise admins paste the URL (or the XML) into
   * their IdP's SAML app config. Gated on Enterprise tier too — if a
   * tenant downgrades, metadata stops serving (also stops the IdP from
   * successfully POSTing to ACS since ACS is gated identically).
   */
  app.get("/metadata/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      return c.json({ error: { message: "SSO not configured.", type: "not_configured" } }, 404);
    }
    // Tier gate on the URL-path tenant, same reasoning as ACS: the IdP
    // fetches this endpoint without a Provara session.
    if (!(await tenantHasEnterpriseAccess(db, tenantId))) {
      return c.json({ error: { message: "SSO not configured.", type: "not_configured" } }, 404);
    }
    const xml = await buildMetadataXml(db, tenantId, GATEWAY_PUBLIC_URL());
    if (!xml) {
      return c.json({ error: { message: "SSO not configured.", type: "not_configured" } }, 404);
    }
    return c.body(xml, 200, { "content-type": "application/samlmetadata+xml" });
  });

  return app;
}

// Exported for tests.
export type SsoUpsertResult =
  | { kind: "created" | "existing"; user: typeof users.$inferSelect }
  | { kind: "cross_tenant_collision"; existingTenantId: string };

/**
 * Pure-JIT provisioning. Trusts the IdP: no invite required. Rule set:
 *
 *   1. Email already on this tenant → log in (`existing`).
 *   2. Email on a different tenant  → refuse (`cross_tenant_collision`).
 *      Operator resolves manually; see #209 design notes.
 *   3. Email not known              → create on the SSO tenant
 *      (`created`), role=member. Admin is whoever seeded the SSO config.
 */
export async function upsertUserFromSso(
  db: Db,
  params: {
    tenantId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  },
): Promise<SsoUpsertResult> {
  const emailLc = params.email.toLowerCase();
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, emailLc))
    .get();

  if (existing) {
    if (existing.tenantId !== params.tenantId) {
      return { kind: "cross_tenant_collision", existingTenantId: existing.tenantId };
    }
    return { kind: "existing", user: existing };
  }

  const combinedName =
    [params.firstName, params.lastName].filter(Boolean).join(" ") || null;
  const userId = nanoid();
  await db
    .insert(users)
    .values({
      id: userId,
      email: emailLc,
      name: combinedName,
      firstName: params.firstName,
      lastName: params.lastName,
      tenantId: params.tenantId,
      role: "member",
      createdAt: new Date(),
    })
    .run();

  const created = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!created) {
    throw new Error(`SSO user insert did not round-trip for ${emailLc}`);
  }
  return { kind: "created", user: created };
}

// Re-export the canonical ACS URL builder so callers outside this module
// can compose it without depending on the SAML helpers directly.
export { acsUrlFor, getActiveSsoConfig };
