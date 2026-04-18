import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function deriveKey(secret: string): Buffer {
  // Accept hex-encoded 256-bit keys directly
  if (secret.length === 64 && /^[0-9a-f]+$/i.test(secret)) {
    return Buffer.from(secret, "hex");
  }
  // Hash arbitrary strings to 32 bytes
  return createHash("sha256").update(secret).digest();
}

export interface EncryptedData {
  encrypted: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

/**
 * Encrypt with an explicit master-key secret. Used by the rotation CLI
 * (#190) which has to operate on two keys — the old one to decrypt
 * stored rows, and the new one to re-encrypt them — without touching
 * the process env. Production paths should prefer `encrypt()` which
 * reads from `PROVARA_MASTER_KEY`.
 */
export function encryptWithKey(plaintext: string, secret: string): EncryptedData {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** See `encryptWithKey`. */
export function decryptWithKey(data: EncryptedData, secret: string): string {
  const key = deriveKey(secret);
  const iv = Buffer.from(data.iv, "hex");
  const authTag = Buffer.from(data.authTag, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function encrypt(plaintext: string): EncryptedData {
  return encryptWithKey(plaintext, requireEnvKey());
}

export function decrypt(data: EncryptedData): string {
  return decryptWithKey(data, requireEnvKey());
}

function requireEnvKey(): string {
  const key = process.env.PROVARA_MASTER_KEY;
  if (!key) {
    throw new Error(
      "PROVARA_MASTER_KEY is required for API key encryption. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return key;
}

/**
 * Obscured display of an API key. Shows a fixed-width bullet prefix + the
 * last 4 chars only. Previously we also surfaced the first 4 chars, but
 * that leaks the vendor prefix (sk-proj-, xai-, etc.) and — across many
 * keys — hints at key structure. Last-4 is enough for users to
 * distinguish which of their stored keys a row represents.
 */
export function maskKey(key: string): string {
  return "••••••••" + key.slice(-4);
}

export function hasMasterKey(): boolean {
  return !!process.env.PROVARA_MASTER_KEY;
}
