#!/usr/bin/env tsx
/**
 * Operator CLI: seed (or update) a tenant's SAML SSO config (#209).
 *
 * Two ways to provide IdP details:
 *
 *   (A) Metadata XML (recommended):
 *     tsx packages/gateway/scripts/seed-sso-config.ts \
 *       --tenant-id acme-tenant-xyz \
 *       --idp-metadata-file ./google-idp-metadata.xml \
 *       --email-domains "acme.com,acme.co.uk"
 *
 *   (B) Individual values (for edge cases or override):
 *     tsx packages/gateway/scripts/seed-sso-config.ts \
 *       --tenant-id acme-tenant-xyz \
 *       --idp-entity-id "https://sts.windows.net/abc-123/" \
 *       --idp-sso-url "https://login.microsoftonline.com/abc-123/saml2" \
 *       --idp-cert-file ./acme-idp-cert.pem \
 *       --email-domains "acme.com,acme.co.uk"
 *
 * Optional flags (both modes):
 *   --gateway-base-url "https://gateway.provara.xyz"
 *   --sp-entity-id     "https://custom/entity-id"
 *   --require-encryption
 *
 * Environment:
 *   DATABASE_URL         libSQL/Turso URL (required — points at prod DB)
 *   DATABASE_AUTH_TOKEN  libSQL auth token (required for Turso)
 *
 * Output: the SP metadata URL for the operator to forward to the
 * customer for their IdP configuration.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createDb, ssoConfigs } from "@provara/db";
import { eq } from "drizzle-orm";
import { acsUrlFor, defaultSpEntityIdFor } from "../src/auth/saml.js";
import { parseIdpMetadataXml } from "../src/auth/saml-metadata.js";

interface Args {
  tenantId: string;
  idpMetadataFile?: string;
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpCertFile?: string;
  emailDomains: string;
  gatewayBaseUrl?: string;
  spEntityId?: string;
  requireEncryption?: boolean;
}

const HELP = `seed-sso-config: create or update a tenant's SAML SSO config

Required flags:
  --tenant-id <id>            The Provara tenant ID
  --email-domains <csv>       Comma-separated email domains to route (e.g. "acme.com,acme.co.uk")

One of (A) or (B) is required:

  (A) Metadata XML (recommended — avoids copy-paste errors):
    --idp-metadata-file <path>   Path to the IdP's metadata XML export

  (B) Individual values:
    --idp-entity-id <url>        The IdP's Entity ID / Issuer
    --idp-sso-url <url>          The IdP's SAML SSO endpoint
    --idp-cert-file <path>       Path to the IdP's X.509 signing cert (PEM)

Optional flags:
  --gateway-base-url <url>    Public gateway origin (default: https://gateway.provara.xyz)
  --sp-entity-id <url>        Override the default SP Entity ID
  --require-encryption        Require the IdP to encrypt assertions
  --help                      Print this help

Environment:
  DATABASE_URL                libSQL connection string (required)
  DATABASE_AUTH_TOKEN         libSQL auth token (required for Turso)
`;

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    if (flag === "--help") {
      args.help = true;
      continue;
    }
    const name = flag.slice(2);
    // Boolean flags — no value after
    if (name === "require-encryption") {
      args[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    args[name] = value;
    i++;
  }

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!args["tenant-id"]) {
    console.error("Missing required flag: --tenant-id");
    console.error("Run with --help for usage.");
    process.exit(2);
  }
  if (!args["email-domains"]) {
    console.error("Missing required flag: --email-domains");
    console.error("Run with --help for usage.");
    process.exit(2);
  }

  const hasMetadata = Boolean(args["idp-metadata-file"]);
  const hasIndividual =
    Boolean(args["idp-entity-id"]) && Boolean(args["idp-sso-url"]) && Boolean(args["idp-cert-file"]);
  if (!hasMetadata && !hasIndividual) {
    console.error(
      "Provide either --idp-metadata-file, or all three of --idp-entity-id + --idp-sso-url + --idp-cert-file.",
    );
    console.error("Run with --help for usage.");
    process.exit(2);
  }
  if (hasMetadata && hasIndividual) {
    console.error("Provide either --idp-metadata-file OR the individual flags, not both.");
    process.exit(2);
  }

  return {
    tenantId: String(args["tenant-id"]),
    idpMetadataFile: args["idp-metadata-file"] ? String(args["idp-metadata-file"]) : undefined,
    idpEntityId: args["idp-entity-id"] ? String(args["idp-entity-id"]) : undefined,
    idpSsoUrl: args["idp-sso-url"] ? String(args["idp-sso-url"]) : undefined,
    idpCertFile: args["idp-cert-file"] ? String(args["idp-cert-file"]) : undefined,
    emailDomains: String(args["email-domains"]),
    gatewayBaseUrl: args["gateway-base-url"] ? String(args["gateway-base-url"]) : undefined,
    spEntityId: args["sp-entity-id"] ? String(args["sp-entity-id"]) : undefined,
    requireEncryption: Boolean(args["require-encryption"]),
  };
}

/**
 * Produce the three IdP-sourced fields regardless of which input mode
 * the operator chose. Metadata XML path parses once and stops; the
 * individual-flag path reads the cert file and trusts the caller's URLs.
 */
async function resolveIdpFields(args: Args): Promise<{ entityId: string; ssoUrl: string; cert: string }> {
  if (args.idpMetadataFile) {
    const path = resolvePath(args.idpMetadataFile);
    let xml: string;
    try {
      xml = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`Could not read IdP metadata at ${path}: ${(err as Error).message}`);
      process.exit(2);
    }
    try {
      return await parseIdpMetadataXml(xml);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }
  // Individual-flag mode — the parseArgs gate above has already verified
  // all three are present, so this branch is safe to narrow.
  const certPath = resolvePath(args.idpCertFile!);
  let cert: string;
  try {
    cert = readFileSync(certPath, "utf8");
  } catch (err) {
    console.error(`Could not read IdP cert at ${certPath}: ${(err as Error).message}`);
    process.exit(2);
  }
  if (!cert.includes("BEGIN CERTIFICATE")) {
    console.error(`Cert at ${certPath} does not look like a PEM X.509 certificate.`);
    process.exit(2);
  }
  return {
    entityId: args.idpEntityId!,
    ssoUrl: args.idpSsoUrl!,
    cert,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (points at the target libSQL DB).");
    process.exit(2);
  }

  const gatewayBaseUrl = args.gatewayBaseUrl ?? "https://gateway.provara.xyz";
  const spEntityId = args.spEntityId ?? defaultSpEntityIdFor(gatewayBaseUrl, args.tenantId);

  const { entityId: idpEntityId, ssoUrl: idpSsoUrl, cert } = await resolveIdpFields(args);

  const emailDomains = args.emailDomains
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (emailDomains.length === 0) {
    console.error("--email-domains must contain at least one domain.");
    process.exit(2);
  }

  const db = createDb();

  const now = new Date();
  const existing = await db
    .select({ tenantId: ssoConfigs.tenantId })
    .from(ssoConfigs)
    .where(eq(ssoConfigs.tenantId, args.tenantId))
    .get();

  if (existing) {
    await db
      .update(ssoConfigs)
      .set({
        idpEntityId,
        idpSsoUrl,
        idpCert: cert,
        spEntityId,
        emailDomains,
        requireEncryption: args.requireEncryption ?? false,
        status: "active",
        updatedAt: now,
      })
      .where(eq(ssoConfigs.tenantId, args.tenantId))
      .run();
    console.log(`[seed-sso-config] updated existing config for tenant ${args.tenantId}`);
  } else {
    await db
      .insert(ssoConfigs)
      .values({
        tenantId: args.tenantId,
        idpEntityId,
        idpSsoUrl,
        idpCert: cert,
        spEntityId,
        emailDomains,
        requireEncryption: args.requireEncryption ?? false,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`[seed-sso-config] created config for tenant ${args.tenantId}`);
  }

  console.log("");
  console.log("Forward the following to the customer's IdP admin:");
  console.log("");
  console.log(`  SP Entity ID:        ${spEntityId}`);
  console.log(`  ACS (Reply) URL:     ${acsUrlFor(gatewayBaseUrl, args.tenantId)}`);
  console.log(`  SP Metadata URL:     ${gatewayBaseUrl.replace(/\/$/, "")}/auth/saml/metadata/${encodeURIComponent(args.tenantId)}`);
  console.log(`  Email domains:       ${emailDomains.join(", ")}`);
  console.log("");
  console.log("Members of these domains will be required to sign in via SSO.");
}

main().catch((err) => {
  console.error(`[seed-sso-config] ${(err as Error).message}`);
  process.exit(1);
});
