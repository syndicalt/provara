import { createHash, createHmac } from "node:crypto";

const DEFAULT_R2_REGION = "auto";
const DEFAULT_R2_PREFIX = "context-documents/";

export interface StoredDocumentObject {
  driver: "r2";
  bucket: string;
  key: string;
  uri: string;
  sizeBytes: number;
  contentHash: string;
  storedAt: string;
}

interface R2DocumentStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  prefix: string;
}

interface StoreContextDocumentInput {
  tenantId: string | null;
  collectionId: string;
  documentId: string;
  title: string;
  text: string;
  contentHash: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function normalizePrefix(value: string | undefined): string {
  const trimmed = value?.trim().replace(/^\/+/, "") || DEFAULT_R2_PREFIX;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function normalizeR2Endpoint(rawEndpoint: string, bucket: string): string {
  const url = new URL(rawEndpoint.trim());
  url.search = "";
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-1) === bucket) parts.pop();
  url.pathname = parts.length > 0 ? `/${parts.join("/")}` : "";
  return url.toString().replace(/\/$/, "");
}

function getR2DocumentStorageConfig(): R2DocumentStorageConfig | null {
  const driver = process.env.DOCUMENT_STORAGE_DRIVER?.trim().toLowerCase();
  if (!driver) return null;
  if (driver !== "r2") throw new Error("DOCUMENT_STORAGE_DRIVER must be r2 when set");

  const bucket = process.env.R2_BUCKET?.trim();
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!bucket) throw new Error("R2_BUCKET is required when DOCUMENT_STORAGE_DRIVER=r2");
  if (!endpoint) throw new Error("R2_ENDPOINT is required when DOCUMENT_STORAGE_DRIVER=r2");
  if (!accessKeyId) throw new Error("R2_ACCESS_KEY_ID is required when DOCUMENT_STORAGE_DRIVER=r2");
  if (!secretAccessKey) throw new Error("R2_SECRET_ACCESS_KEY is required when DOCUMENT_STORAGE_DRIVER=r2");

  return {
    endpoint: normalizeR2Endpoint(endpoint, bucket),
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.R2_REGION?.trim() || DEFAULT_R2_REGION,
    prefix: normalizePrefix(process.env.R2_PREFIX),
  };
}

function encodeObjectKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function documentObjectKey(config: R2DocumentStorageConfig, input: StoreContextDocumentInput): string {
  const tenant = input.tenantId ?? "pool";
  const titleHash = sha256Hex(input.title).slice(0, 12);
  return `${config.prefix}${tenant}/${input.collectionId}/${input.documentId}-${titleHash}.txt`;
}

function signR2PutRequest(
  url: URL,
  config: R2DocumentStorageConfig,
  payloadHash: string,
  now = new Date(),
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = [
    "PUT",
    url.pathname || "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    Host: headers.host,
    "Content-Type": "text/plain; charset=utf-8",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function storeContextDocumentObject(input: StoreContextDocumentInput): Promise<StoredDocumentObject | null> {
  const config = getR2DocumentStorageConfig();
  if (!config) return null;
  const fetchFn = globalThis.fetch;
  if (!fetchFn) throw new Error("fetch is unavailable");

  const key = documentObjectKey(config, input);
  const url = new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeObjectKeyPath(key)}`);
  const payloadHash = sha256Hex(input.text);
  const response = await fetchFn(url, {
    method: "PUT",
    headers: signR2PutRequest(url, config, payloadHash),
    body: input.text,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = text ? `: ${text.slice(0, 200)}` : "";
    throw new Error(`R2 document storage failed (${response.status})${detail}`);
  }

  return {
    driver: "r2",
    bucket: config.bucket,
    key,
    uri: `r2://${config.bucket}/${key}`,
    sizeBytes: Buffer.byteLength(input.text, "utf8"),
    contentHash: input.contentHash,
    storedAt: new Date().toISOString(),
  };
}
