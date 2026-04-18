import { parseStringPromise } from "xml2js";

/**
 * Parse an IdP-published SAML metadata XML into the three fields our
 * `sso_configs` row actually stores (#209/T7 follow-up).
 *
 * Every major IdP (Google Workspace, Okta, Entra, OneLogin, JumpCloud,
 * ADFS) exports a metadata.xml from their SAML app configuration UI.
 * Parsing it replaces the hand-copy of three separate values, which is
 * the class of copy-paste error that produced the Google "saml2 vs
 * saml2/idp" 404 during #209's UAT.
 *
 * Returns the verbatim X.509 certificate (wrapped in a PEM block) and
 * the two URLs. Does NOT hit the DB; the caller (T7 CLI) composes the
 * DB write.
 */
export interface ParsedIdpMetadata {
  entityId: string;
  ssoUrl: string;
  /** PEM-wrapped X.509, ready to drop into `idp_cert`. */
  cert: string;
}

interface RawAttrs {
  $?: Record<string, string>;
}
interface SingleSignOnService extends RawAttrs {}
interface X509Data {
  "ds:X509Certificate"?: string[];
  X509Certificate?: string[];
}
interface KeyInfo {
  "ds:X509Data"?: X509Data[];
  X509Data?: X509Data[];
}
interface KeyDescriptor extends RawAttrs {
  "ds:KeyInfo"?: KeyInfo[];
  KeyInfo?: KeyInfo[];
}
interface IDPSSODescriptor {
  "md:KeyDescriptor"?: KeyDescriptor[];
  KeyDescriptor?: KeyDescriptor[];
  "md:SingleSignOnService"?: SingleSignOnService[];
  SingleSignOnService?: SingleSignOnService[];
}
interface EntityDescriptor extends RawAttrs {
  "md:IDPSSODescriptor"?: IDPSSODescriptor[];
  IDPSSODescriptor?: IDPSSODescriptor[];
}

const HTTP_REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const HTTP_POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

export async function parseIdpMetadataXml(xml: string): Promise<ParsedIdpMetadata> {
  // Some IdPs emit a leading BOM; strip it so the xml2js parser's
  // "must start with <" check doesn't fail.
  const cleaned = xml.replace(/^\uFEFF/, "").trim();

  const doc = (await parseStringPromise(cleaned, {
    explicitArray: true,
    // xml2js by default folds namespace prefixes into the key name; we
    // explicitly tolerate both prefixed and unprefixed keys in the
    // field lookups below, so stripPrefix: false is fine and avoids
    // losing the <ds:> prefix that matters for X.509 data in strict
    // metadata consumers.
    tagNameProcessors: [],
  })) as Record<string, EntityDescriptor>;

  // The top-level element is always EntityDescriptor, possibly prefixed
  // (md:EntityDescriptor). Accept whichever the IdP produces.
  const rootKey = Object.keys(doc).find((k) => /(?:^|:)EntityDescriptor$/.test(k));
  if (!rootKey) {
    throw new MetadataParseError("root element is not EntityDescriptor — is this an IdP metadata file?");
  }
  const root = doc[rootKey];

  const entityId = root.$?.entityID;
  if (!entityId) {
    throw new MetadataParseError("EntityDescriptor is missing the entityID attribute");
  }

  const idpDescriptor = pickFirst(root, "IDPSSODescriptor") as IDPSSODescriptor | undefined;
  if (!idpDescriptor) {
    throw new MetadataParseError("no IDPSSODescriptor — this is not an IdP metadata file (SP metadata?)");
  }

  const ssoUrl = extractSsoUrl(idpDescriptor);
  const cert = extractSigningCertPem(idpDescriptor);

  return { entityId, ssoUrl, cert };
}

/**
 * Prefer HTTP-Redirect binding (what the library emits for SP-init by
 * default), fall back to HTTP-POST if the IdP only exposes that one.
 * Pick the first matching SingleSignOnService element. If none exists,
 * raise — we can't configure SSO without an endpoint.
 */
function extractSsoUrl(idp: IDPSSODescriptor): string {
  const services = pickAll(idp, "SingleSignOnService") as SingleSignOnService[];
  if (services.length === 0) {
    throw new MetadataParseError("IDPSSODescriptor has no SingleSignOnService elements");
  }
  const redirect = services.find((s) => s.$?.Binding === HTTP_REDIRECT_BINDING);
  if (redirect?.$?.Location) return redirect.$.Location;
  const post = services.find((s) => s.$?.Binding === HTTP_POST_BINDING);
  if (post?.$?.Location) return post.$.Location;
  throw new MetadataParseError(
    "no HTTP-Redirect or HTTP-POST SingleSignOnService binding found — unsupported IdP",
  );
}

/**
 * Extract the first X.509 signing certificate and wrap it as a PEM
 * block. IdPs may tag KeyDescriptor with use="signing" (most do) or
 * leave it unspecified — the SAML spec says unspecified means dual-
 * purpose, so we accept both. When multiple signing certs exist
 * (rotation windows), pick the first; node-saml accepts an array via
 * multiple PEM blocks concatenated, but that complication can land in
 * a follow-up if a customer actually needs it.
 */
function extractSigningCertPem(idp: IDPSSODescriptor): string {
  const keyDescriptors = pickAll(idp, "KeyDescriptor") as KeyDescriptor[];
  if (keyDescriptors.length === 0) {
    throw new MetadataParseError("IDPSSODescriptor has no KeyDescriptor elements");
  }
  const signing = keyDescriptors.find((kd) => kd.$?.use === "signing") ?? keyDescriptors[0];

  const keyInfo = pickFirst(signing, "KeyInfo") as KeyInfo | undefined;
  if (!keyInfo) {
    throw new MetadataParseError("KeyDescriptor missing KeyInfo");
  }
  const x509Data = pickFirst(keyInfo, "X509Data") as X509Data | undefined;
  if (!x509Data) {
    throw new MetadataParseError("KeyInfo missing X509Data");
  }
  const certB64Array = x509Data["ds:X509Certificate"] ?? x509Data.X509Certificate;
  const certB64 = certB64Array?.[0];
  if (!certB64) {
    throw new MetadataParseError("X509Data missing X509Certificate");
  }

  // Strip whitespace from the base64 (metadata files often pretty-print
  // the cert across multiple lines). Then reflow to 64-char lines and
  // wrap with PEM headers — node-saml expects a well-formed PEM.
  const compact = certB64.replace(/\s+/g, "");
  const reflowed = compact.match(/.{1,64}/g)?.join("\n") ?? compact;
  return `-----BEGIN CERTIFICATE-----\n${reflowed}\n-----END CERTIFICATE-----\n`;
}

/**
 * Helpers for the xml2js shape: every element is an array, and keys may
 * carry an XML namespace prefix (`md:`, `ds:`) that varies per IdP.
 * `pickFirst` returns the first child that matches `localName`
 * regardless of prefix; `pickAll` flattens across prefix variants.
 */
function pickFirst(parent: object, localName: string): unknown {
  const all = pickAll(parent, localName);
  return all[0];
}
function pickAll(parent: object, localName: string): unknown[] {
  const re = new RegExp(`(?:^|:)${localName}$`);
  const results: unknown[] = [];
  const record = parent as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!re.test(key)) continue;
    const value = record[key];
    if (Array.isArray(value)) results.push(...value);
    else if (value != null) results.push(value);
  }
  return results;
}

export class MetadataParseError extends Error {
  constructor(message: string) {
    super(`IdP metadata parse failed: ${message}`);
  }
}
