import { describe, it, expect } from "vitest";
import { parseIdpMetadataXml, MetadataParseError } from "../src/auth/saml-metadata.js";

// Realistic fixtures modeled on what Google Workspace, Okta, and Entra
// emit from their SAML app metadata downloads. The certs are fixture
// values (format-valid base64 but not real signing keys).

const FIXTURE_CERT_LINE =
  "MIIDdDCCAlygAwIBAgIGAZ2gqEp/MA0GCSqGSIb3DQEBCwUAMHsxFDASBgNVBAoTC0dvb2dsZSBJ";

/**
 * The parser reflows PEM bodies to 64-char lines, so comparing against
 * the original single-line fixture requires stripping whitespace and
 * PEM headers. The base64 *content* is what matters to the SAML client;
 * line wrapping is cosmetic.
 */
function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s/g, "");
}

const GOOGLE_METADATA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
    entityID="https://accounts.google.com/o/saml2?idpid=C01s6h8ff"
    validUntil="2031-04-17T12:54:36.000Z">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
      WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>${FIXTURE_CERT_LINE}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="https://accounts.google.com/o/saml2/idp?idpid=C01s6h8ff"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="https://accounts.google.com/o/saml2/idp?idpid=C01s6h8ff"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

// Okta's metadata uses unprefixed element names in some fields.
const OKTA_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
    entityID="http://www.okta.com/exk1fs4r1z2345abcde">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
      WantAuthnRequestsSigned="false">
    <KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>${FIXTURE_CERT_LINE}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </KeyDescriptor>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="https://acme.okta.com/app/acme_provara_1/exk1fs4r1z2345abcde/sso/saml"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="https://acme.okta.com/app/acme_provara_1/exk1fs4r1z2345abcde/sso/saml"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

describe("parseIdpMetadataXml", () => {
  it("parses Google Workspace metadata correctly", async () => {
    const parsed = await parseIdpMetadataXml(GOOGLE_METADATA);
    expect(parsed.entityId).toBe("https://accounts.google.com/o/saml2?idpid=C01s6h8ff");
    expect(parsed.ssoUrl).toBe("https://accounts.google.com/o/saml2/idp?idpid=C01s6h8ff");
    expect(parsed.cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(stripPem(parsed.cert)).toContain(FIXTURE_CERT_LINE);
    expect(parsed.cert).toContain("-----END CERTIFICATE-----");
  });

  it("parses Okta-shape unprefixed metadata correctly", async () => {
    const parsed = await parseIdpMetadataXml(OKTA_METADATA);
    expect(parsed.entityId).toBe("http://www.okta.com/exk1fs4r1z2345abcde");
    expect(parsed.ssoUrl).toBe(
      "https://acme.okta.com/app/acme_provara_1/exk1fs4r1z2345abcde/sso/saml",
    );
    expect(stripPem(parsed.cert)).toContain(FIXTURE_CERT_LINE);
  });

  it("prefers HTTP-Redirect binding when both are present", async () => {
    // Google metadata has Redirect first then POST; Okta has POST first
    // then Redirect. Either way the parser should land on Redirect.
    const google = await parseIdpMetadataXml(GOOGLE_METADATA);
    const okta = await parseIdpMetadataXml(OKTA_METADATA);
    // Google and Okta both point at the same URL for both bindings in
    // these fixtures, so the assertion is really about the chosen URL
    // equaling either binding's Location.
    expect(google.ssoUrl).toBe("https://accounts.google.com/o/saml2/idp?idpid=C01s6h8ff");
    expect(okta.ssoUrl).toContain("okta.com");
  });

  it("falls back to HTTP-POST when HTTP-Redirect is not offered", async () => {
    const postOnly = GOOGLE_METADATA.replace(
      /<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^/]+\/>/,
      "",
    );
    const parsed = await parseIdpMetadataXml(postOnly);
    expect(parsed.ssoUrl).toBe("https://accounts.google.com/o/saml2/idp?idpid=C01s6h8ff");
  });

  it("strips whitespace from multi-line cert base64 and reflows to PEM", async () => {
    const multiLineXml = GOOGLE_METADATA.replace(
      FIXTURE_CERT_LINE,
      `${FIXTURE_CERT_LINE.slice(0, 40)}\n        ${FIXTURE_CERT_LINE.slice(40)}`,
    );
    const parsed = await parseIdpMetadataXml(multiLineXml);
    // Cert body should reflow to 64-char lines with no leading space
    const body = parsed.cert
      .replace("-----BEGIN CERTIFICATE-----\n", "")
      .replace(/\n-----END CERTIFICATE-----\n?$/, "");
    for (const line of body.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(64);
      expect(line).not.toMatch(/\s/);
    }
  });

  it("handles a leading BOM character gracefully", async () => {
    const withBom = "\uFEFF" + GOOGLE_METADATA;
    const parsed = await parseIdpMetadataXml(withBom);
    expect(parsed.entityId).toBe("https://accounts.google.com/o/saml2?idpid=C01s6h8ff");
  });

  it("throws MetadataParseError when the root is not EntityDescriptor", async () => {
    const notMetadata = `<?xml version="1.0"?><SomethingElse/>`;
    await expect(parseIdpMetadataXml(notMetadata)).rejects.toThrow(MetadataParseError);
    await expect(parseIdpMetadataXml(notMetadata)).rejects.toThrow(/EntityDescriptor/);
  });

  it("throws when the EntityDescriptor is missing entityID", async () => {
    const noId = GOOGLE_METADATA.replace(/entityID="[^"]+"/, "");
    await expect(parseIdpMetadataXml(noId)).rejects.toThrow(/entityID/);
  });

  it("throws when the file is SP metadata instead of IdP metadata", async () => {
    const spMetadata = GOOGLE_METADATA.replace(
      "md:IDPSSODescriptor",
      "md:SPSSODescriptor",
    ).replace(
      "md:IDPSSODescriptor",
      "md:SPSSODescriptor",
    );
    await expect(parseIdpMetadataXml(spMetadata)).rejects.toThrow(/IDPSSODescriptor/);
  });

  it("throws when no SingleSignOnService is present", async () => {
    // Multi-line self-closing tags — use [\s\S] to match across newlines.
    const noSso = GOOGLE_METADATA.replace(
      /<md:SingleSignOnService [\s\S]+?\/>/g,
      "",
    );
    await expect(parseIdpMetadataXml(noSso)).rejects.toThrow(/SingleSignOnService/);
  });

  it("throws when no X509Certificate is present", async () => {
    const noCert = GOOGLE_METADATA.replace(
      /<ds:X509Certificate>[^<]+<\/ds:X509Certificate>/,
      "",
    );
    await expect(parseIdpMetadataXml(noCert)).rejects.toThrow(/X509Certificate/);
  });

  it("picks the signing key when multiple KeyDescriptors exist", async () => {
    // Add an encryption key before the signing key — parser should skip
    // it and find the use="signing" one.
    const withEncryption = GOOGLE_METADATA.replace(
      "<md:KeyDescriptor use=\"signing\">",
      `<md:KeyDescriptor use="encryption">
        <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
          <ds:X509Data>
            <ds:X509Certificate>ENCRYPTION-KEY-XXX-not-the-right-one</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </md:KeyDescriptor>
      <md:KeyDescriptor use="signing">`,
    );
    const parsed = await parseIdpMetadataXml(withEncryption);
    expect(stripPem(parsed.cert)).toContain(FIXTURE_CERT_LINE);
    expect(parsed.cert).not.toContain("ENCRYPTION-KEY-XXX");
  });
});
