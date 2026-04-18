import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { Profile } from "@node-saml/node-saml";
import type { Db } from "@provara/db";
import { ssoConfigs } from "@provara/db";
import { eq } from "drizzle-orm";
import { getOperatorEmails } from "../config.js";

/**
 * SAML 2.0 SSO support (#209, ops-managed v1).
 *
 * This module wraps `@node-saml/node-saml` and exposes helpers the route
 * layer uses: discover → start → ACS → metadata. Each tenant has at
 * most one row in `sso_configs`; the SP entity ID, ACS URL, and login
 * URL are all deterministically derived from the tenant ID so that
 * rotating the IdP never requires the SP to re-register.
 *
 * Per-tenant ACS URLs (`/auth/saml/acs/:tenantId`) are the key design
 * choice that makes IdP-initiated flows work without RelayState: the
 * IdP POSTs to the tenant-specific URL, so the tenant is known from
 * the path even when the response doesn't carry a RelayState.
 */

/** A hydrated SSO config (status already filtered to "active"). */
export interface ActiveSsoConfig {
  tenantId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCert: string;
  spEntityId: string;
  emailDomains: string[];
  requireEncryption: boolean;
}

export interface ValidatedAssertion {
  tenantId: string;
  profile: Profile;
}

/**
 * Fetch the active SSO config for a tenant. Returns null when the
 * tenant has no row, or when the row is disabled. Callers should
 * treat null as "SSO is not configured for this tenant."
 */
export async function getActiveSsoConfig(
  db: Db,
  tenantId: string,
): Promise<ActiveSsoConfig | null> {
  const row = await db
    .select()
    .from(ssoConfigs)
    .where(eq(ssoConfigs.tenantId, tenantId))
    .get();
  if (!row || row.status !== "active") return null;
  return {
    tenantId: row.tenantId,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpCert: row.idpCert,
    spEntityId: row.spEntityId,
    emailDomains: row.emailDomains,
    requireEncryption: row.requireEncryption,
  };
}

/**
 * Find the active SSO config whose email-domain allowlist contains the
 * given email's domain. Used by:
 *   - the discover endpoint (so /login can auto-redirect),
 *   - the magic-link / OAuth gate (so non-SSO flows can be refused
 *     when the caller's domain is SSO-enforced).
 *
 * Returns null when no tenant claims the domain.
 */
export async function findSsoConfigForEmail(
  db: Db,
  email: string,
): Promise<ActiveSsoConfig | null> {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return null;

  // libSQL doesn't have a JSON contains operator in Drizzle yet; scan
  // active rows in code. Fine at the current scale (dozens of rows).
  // Revisit if the table ever grows into the thousands.
  const rows = await db
    .select()
    .from(ssoConfigs)
    .where(eq(ssoConfigs.status, "active"))
    .all();
  for (const row of rows) {
    const domains = row.emailDomains.map((d) => d.toLowerCase());
    if (domains.includes(domain)) {
      return {
        tenantId: row.tenantId,
        idpEntityId: row.idpEntityId,
        idpSsoUrl: row.idpSsoUrl,
        idpCert: row.idpCert,
        spEntityId: row.spEntityId,
        emailDomains: row.emailDomains,
        requireEncryption: row.requireEncryption,
      };
    }
  }
  return null;
}

/**
 * Is this email required to use SSO — i.e. does some tenant claim its
 * domain via an active `sso_configs` row?
 *
 * Operator accounts (PROVARA_OPERATOR_EMAILS) always bypass. Everyone
 * else whose domain is SSO-enforced gets refused from magic-link /
 * Google OAuth flows (#209/T4) so there is no back-door auth path
 * around the IdP for their email domain.
 *
 * Returns the active config (callers use it to compose the SSO start
 * URL for the error response) or null when no gate applies.
 */
export async function ssoRequiredForEmail(
  db: Db,
  email: string,
): Promise<ActiveSsoConfig | null> {
  const lowered = email.toLowerCase();
  const operators = getOperatorEmails();
  if (operators.includes(lowered)) return null;
  return findSsoConfigForEmail(db, email);
}

/**
 * Build a SAML client from a hydrated config. Pure function — no DB,
 * no env reads — so tests can drive it with fixture configs.
 *
 * `gatewayBaseUrl` is the public origin of the gateway (e.g.
 * "https://gateway.provara.xyz"). It's used to form the per-tenant
 * ACS URL that gets registered with the IdP.
 */
export function makeSamlClient(
  config: ActiveSsoConfig,
  gatewayBaseUrl: string,
): SAML {
  return new SAML({
    entryPoint: config.idpSsoUrl,
    issuer: config.spEntityId,
    callbackUrl: acsUrlFor(gatewayBaseUrl, config.tenantId),
    idpCert: config.idpCert,
    idpIssuer: config.idpEntityId,
    // Signed assertions are a hard requirement. Unsigned assertions
    // mean anyone who can reach the ACS can impersonate anyone — that's
    // how the samlify CVE worked.
    wantAssertionsSigned: true,
    // Response signing is optional in the SAML 2.0 spec; most IdPs do
    // it anyway. Require it.
    wantAuthnResponseSigned: true,
    // "never" is a pragmatic choice until we land a DB-backed replay
    // cache. node-saml's default cache is per-SAML-instance and in-memory;
    // our route handlers build a new SAML instance per request, so the
    // AuthnRequest ID issued in /start is never visible to the /acs
    // handler, causing every valid SP-initiated response to be rejected
    // with "InResponseTo is not valid".
    //
    // Signature, timestamp (NotBefore / NotOnOrAfter), audience, and
    // destination validation all still fire, so forged responses are
    // still refused. The narrowed surface is replay of a valid captured
    // response within its assertion lifetime (typically 5 minutes).
    //
    // Follow-up: replace the in-memory CacheProvider with a libSQL-
    // backed one that persists AuthnRequest IDs across replicas and
    // expires them at assertion lifetime. Then flip this back to
    // `ValidateInResponseTo.ifPresent`.
    validateInResponseTo: ValidateInResponseTo.never,
    // EmailAddress is the universally-supported NameID format; some IdPs
    // (notably Entra by default) emit it as the unspecified format, so
    // leaving this `null` lets the library accept whatever the IdP sends.
    identifierFormat: null,
  });
}

/**
 * Canonical per-tenant ACS URL. Both the route handler and the
 * metadata generator must agree on this, so it's computed in one place.
 */
export function acsUrlFor(gatewayBaseUrl: string, tenantId: string): string {
  return `${trimSlash(gatewayBaseUrl)}/auth/saml/acs/${encodeURIComponent(tenantId)}`;
}

/**
 * Canonical per-tenant SP entity ID — defaults to this when the config
 * row's `sp_entity_id` is empty. Kept separate from the ACS URL so the
 * entity ID can remain stable even if the gateway hostname moves.
 */
export function defaultSpEntityIdFor(
  gatewayBaseUrl: string,
  tenantId: string,
): string {
  return `${trimSlash(gatewayBaseUrl)}/saml/${encodeURIComponent(tenantId)}`;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * SP-initiated flow: produce the URL to 302 the user to. The tenant ID
 * is encoded in the RelayState as a convenience for a later
 * /login → /start round trip but is not trusted — the ACS handler
 * uses the URL-path tenant ID, not the RelayState.
 */
export async function buildLoginRequestUrl(
  db: Db,
  tenantId: string,
  gatewayBaseUrl: string,
): Promise<string> {
  const config = await getActiveSsoConfig(db, tenantId);
  if (!config) {
    throw new Error(`SSO not configured for tenant ${tenantId}`);
  }
  const client = makeSamlClient(config, gatewayBaseUrl);
  return client.getAuthorizeUrlAsync(tenantId, undefined, {});
}

/**
 * Validate a POST response received at the ACS endpoint. Takes the
 * tenant ID from the URL path (caller-supplied) so the flow works for
 * both SP- and IdP-initiated. Returns the validated profile; callers
 * do JIT provisioning off it.
 *
 * Throws on any validation failure. The wrapping route handler should
 * turn those into 400s with a generic message — validation-error detail
 * belongs in server logs, not in user responses.
 */
export async function validatePostResponse(
  db: Db,
  tenantId: string,
  body: Record<string, string>,
  gatewayBaseUrl: string,
): Promise<ValidatedAssertion> {
  const config = await getActiveSsoConfig(db, tenantId);
  if (!config) {
    throw new Error(`SSO not configured for tenant ${tenantId}`);
  }
  const client = makeSamlClient(config, gatewayBaseUrl);
  const { profile } = await client.validatePostResponseAsync(body);
  if (!profile) {
    // The library returns null when the POST is a LogoutResponse rather
    // than an authn response. Our /acs endpoint only accepts authn.
    throw new Error("SAML POST did not carry an authn response");
  }
  return { tenantId, profile };
}

/**
 * SP metadata XML for a tenant. Enterprise admins paste this into their
 * IdP (or upload the URL, depending on the IdP). The XML is deterministic
 * for a given config — cache-friendly, though we don't bother caching yet.
 */
export async function buildMetadataXml(
  db: Db,
  tenantId: string,
  gatewayBaseUrl: string,
): Promise<string | null> {
  const config = await getActiveSsoConfig(db, tenantId);
  if (!config) return null;
  const client = makeSamlClient(config, gatewayBaseUrl);
  return client.generateServiceProviderMetadata(null, null);
}

/**
 * Extract a normalized email from a validated SAML profile. IdPs vary
 * in where they put the user's email: some send it as the NameID (with
 * EmailAddress format), some put it in an attribute. This helper
 * prefers the attribute when present, falls back to NameID.
 *
 * Returns null when no email can be determined; the route handler
 * should refuse JIT in that case rather than creating a ghost user.
 */
export function extractEmailFromProfile(profile: Profile): string | null {
  const attrEmail = profile.email;
  if (typeof attrEmail === "string" && attrEmail.includes("@")) {
    return attrEmail.toLowerCase();
  }
  // nameIDFormat === "...emailAddress" → NameID is the email
  const nameId = profile.nameID;
  if (typeof nameId === "string" && nameId.includes("@")) {
    return nameId.toLowerCase();
  }
  return null;
}
