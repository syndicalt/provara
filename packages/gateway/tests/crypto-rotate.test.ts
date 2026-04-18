import { describe, it, expect, beforeEach } from "vitest";
import { apiKeys } from "@provara/db";
import type { Db } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import { decryptWithKey, encryptWithKey } from "../src/crypto/index.js";
import { rotateMasterKey, RotationError } from "../src/crypto/rotate.js";

const OLD_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NEW_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

async function seedApiKey(
  db: Db,
  id: string,
  plaintext: string,
  key: string,
) {
  const enc = encryptWithKey(plaintext, key);
  await db.insert(apiKeys).values({
    id,
    name: `key-${id}`,
    provider: "openai",
    encryptedValue: enc.encrypted,
    iv: enc.iv,
    authTag: enc.authTag,
    tenantId: "t1",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run();
}

describe("#190 — master-key rotation", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("rotates every row from old key to new key", async () => {
    await seedApiKey(db, "k1", "sk-real-openai-1", OLD_KEY);
    await seedApiKey(db, "k2", "sk-real-openai-2", OLD_KEY);
    await seedApiKey(db, "k3", "sk-real-openai-3", OLD_KEY);

    const stats = await rotateMasterKey(db, { oldKey: OLD_KEY, newKey: NEW_KEY });
    expect(stats.rowsScanned).toBe(3);
    expect(stats.rowsRotated).toBe(3);
    expect(stats.dryRun).toBe(false);

    // Every row now decrypts with the NEW key.
    const rows = await db.select().from(apiKeys).all();
    for (const row of rows) {
      const plaintext = decryptWithKey(
        { encrypted: row.encryptedValue, iv: row.iv, authTag: row.authTag },
        NEW_KEY,
      );
      expect(plaintext).toMatch(/^sk-real-openai-/);
    }
  });

  it("old key stops working on rotated rows", async () => {
    await seedApiKey(db, "k1", "sk-real", OLD_KEY);

    await rotateMasterKey(db, { oldKey: OLD_KEY, newKey: NEW_KEY });

    const row = await db.select().from(apiKeys).where(eq(apiKeys.id, "k1")).get();
    expect(() =>
      decryptWithKey(
        { encrypted: row!.encryptedValue, iv: row!.iv, authTag: row!.authTag },
        OLD_KEY,
      ),
    ).toThrow();
  });

  it("--dry-run writes nothing but verifies all rows decrypt with old key", async () => {
    await seedApiKey(db, "k1", "sk-a", OLD_KEY);
    await seedApiKey(db, "k2", "sk-b", OLD_KEY);
    const before = await db.select().from(apiKeys).all();

    const stats = await rotateMasterKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      dryRun: true,
    });
    expect(stats.dryRun).toBe(true);
    expect(stats.rowsScanned).toBe(2);
    expect(stats.rowsRotated).toBe(0);

    const after = await db.select().from(apiKeys).all();
    // Ciphertext unchanged: dry run wrote nothing.
    expect(after.map((r) => r.encryptedValue).sort()).toEqual(
      before.map((r) => r.encryptedValue).sort(),
    );
  });

  it("aborts cleanly when the --old key doesn't match a row's ciphertext", async () => {
    await seedApiKey(db, "good", "sk-real", OLD_KEY);
    // This row was encrypted with a different key — simulates a
    // mistyped --old or a row nobody knows the history of.
    await seedApiKey(db, "foreign", "sk-other", NEW_KEY);

    await expect(
      rotateMasterKey(db, { oldKey: OLD_KEY, newKey: NEW_KEY }),
    ).rejects.toThrow(RotationError);

    // The transaction rolled back — `good` is still encrypted with OLD_KEY.
    const goodRow = await db.select().from(apiKeys).where(eq(apiKeys.id, "good")).get();
    const stillOld = decryptWithKey(
      { encrypted: goodRow!.encryptedValue, iv: goodRow!.iv, authTag: goodRow!.authTag },
      OLD_KEY,
    );
    expect(stillOld).toBe("sk-real");
  });

  it("rejects identical --old and --new keys", async () => {
    await expect(
      rotateMasterKey(db, { oldKey: OLD_KEY, newKey: OLD_KEY }),
    ).rejects.toThrow(/identical/);
  });

  it("works on an empty table (zero rows, zero rotations)", async () => {
    const stats = await rotateMasterKey(db, { oldKey: OLD_KEY, newKey: NEW_KEY });
    expect(stats).toMatchObject({ rowsScanned: 0, rowsRotated: 0, dryRun: false });
  });
});
