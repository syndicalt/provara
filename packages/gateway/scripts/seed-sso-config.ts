#!/usr/bin/env tsx
/**
 * Operator CLI: seed (or update) a tenant's SAML SSO config (#209).
 *
 * Usage:
 *   tsx packages/gateway/scripts/seed-sso-config.ts \
 *     --tenant-id acme-tenant-xyz \
 *     --idp-entity-id "https://sts.windows.net/abc-123/" \
 *     --idp-sso-url "https://login.microsoftonline.com/abc-123/saml2" \
 *     --idp-cert-file ./acme-idp-cert.pem \
 *     --email-domains "acme.com,acme.co.uk" \
 *     [--gateway-base-url "https://gateway.provara.xyz"] \
 *     [--sp-entity-id "https://custom/entity-id"] \
 *     [--require-encryption]
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

interface Args {
  tenantId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertFile: string;
  emailDomains: string;
  gatewayBaseUrl?: string;
  spEntityId?: string;
  requireEncryption?: boolean;
}

const HELP = `seed-sso-config: create or update a tenant's SAML SSO config

Required flags:
  --tenant-id <id>            The Provara tenant ID
  --idp-entity-id <url>       The IdP's Entity ID / Issuer
  --idp-sso-url <url>         The IdP's SAML SSO endpoint
  --idp-cert-file <path>      Path to the IdP's X.509 signing cert (PEM)
  --email-domains <csv>       Comma-separated email domains to route (e.g. "acme.com,acme.co.uk")

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

  const required = ["tenant-id", "idp-entity-id", "idp-sso-url", "idp-cert-file", "email-domains"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Missing required flags: ${missing.map((k) => "--" + k).join(", ")}`);
    console.error(`Run with --help for usage.`);
    process.exit(2);
  }

  return {
    tenantId: String(args["tenant-id"]),
    idpEntityId: String(args["idp-entity-id"]),
    idpSsoUrl: String(args["idp-sso-url"]),
    idpCertFile: String(args["idp-cert-file"]),
    emailDomains: String(args["email-domains"]),
    gatewayBaseUrl: args["gateway-base-url"] ? String(args["gateway-base-url"]) : undefined,
    spEntityId: args["sp-entity-id"] ? String(args["sp-entity-id"]) : undefined,
    requireEncryption: Boolean(args["require-encryption"]),
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

  const certPath = resolvePath(args.idpCertFile);
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
        idpEntityId: args.idpEntityId,
        idpSsoUrl: args.idpSsoUrl,
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
        idpEntityId: args.idpEntityId,
        idpSsoUrl: args.idpSsoUrl,
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
