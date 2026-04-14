import { randomBytes, createHash } from "node:crypto";
import type { Db } from "@provara/db";
import { apiTokens } from "@provara/db";
import { eq } from "drizzle-orm";

const TOKEN_PREFIX = "pvra_";
const TOKEN_RANDOM_BYTES = 24; // 48 hex chars

export interface TokenInfo {
  id: string;
  name: string;
  tenant: string;
  rateLimit: number | null;
  spendLimit: number | null;
  spendPeriod: string | null;
  expiresAt: Date | null;
}

export function generateToken(): string {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString("hex");
  return `${TOKEN_PREFIX}${random}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function maskToken(token: string): string {
  // Show prefix + first 4 random chars + masked + last 4
  if (token.length <= 12) return token;
  return token.slice(0, 9) + "••••" + token.slice(-4);
}

export function verifyToken(db: Db, token: string): TokenInfo | null {
  const hashed = hashToken(token);
  const row = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.hashedToken, hashed))
    .get();

  if (!row) return null;

  // Check expiry
  if (row.expiresAt && row.expiresAt < new Date()) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    tenant: row.tenant,
    rateLimit: row.rateLimit,
    spendLimit: row.spendLimit,
    spendPeriod: row.spendPeriod,
    expiresAt: row.expiresAt,
  };
}
