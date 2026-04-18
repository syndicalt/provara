import type { Db } from "@provara/db";
import { apiKeys } from "@provara/db";
import { eq } from "drizzle-orm";
import { decryptWithKey, encryptWithKey } from "./index.js";

/**
 * `PROVARA_MASTER_KEY` rotation (#190). Decrypts every row in
 * `api_keys` with `oldKey` and re-encrypts with `newKey`.
 *
 * Atomicity strategy at this scale (~3 rows in prod today, order-of-
 * magnitude low hundreds even for large tenants): **two-phase with a
 * decrypt gate**. Phase 1 reads every row and decrypts with the old
 * key into an in-memory array — if any row fails, we abort before
 * writing anything, so a mistyped --old key cannot produce a
 * half-rotated table. Phase 2 re-encrypts each entry and writes back
 * one UPDATE at a time. The only partial-failure window is a network
 * blip between UPDATE n and UPDATE n+1, which in practice is already
 * handled by the operator rerunning rotation with the keys swapped —
 * the pre-rotation state is always recoverable by simply not
 * swapping the deployment's env var.
 *
 * If this ever grows to thousands of rows, swap to the temp-column
 * pattern: dual-write new-encrypted values into `encrypted_value_v2`
 * / `iv_v2` / `auth_tag_v2`, swap column names in a migration. For
 * now, two-phase is the cheapest correct thing.
 *
 * Dry-run mode performs only phase 1 and writes nothing — an operator
 * can validate the pre-condition (old key is correct for every row)
 * before committing.
 */

export interface RotateOptions {
  oldKey: string;
  newKey: string;
  dryRun?: boolean;
}

export interface RotateStats {
  rowsScanned: number;
  rowsRotated: number;
  dryRun: boolean;
  /** Non-fatal — a row whose decrypt with the old key failed. The
   *  transaction aborts as soon as the first one is hit; this count
   *  will always be 0 on a successful rotation. Kept as a structured
   *  field so the CLI can format the failure on error. */
  rowsFailed: number;
}

export class RotationError extends Error {
  constructor(message: string, public readonly rowId: string) {
    super(message);
    this.name = "RotationError";
  }
}

export async function rotateMasterKey(
  db: Db,
  opts: RotateOptions,
): Promise<RotateStats> {
  if (!opts.oldKey || !opts.newKey) {
    throw new Error("Both `oldKey` and `newKey` are required for rotation.");
  }
  if (opts.oldKey === opts.newKey) {
    throw new Error("`oldKey` and `newKey` are identical — nothing to rotate.");
  }

  const rows = await db.select().from(apiKeys).all();

  // Phase 1 — decrypt everything with the old key. Any failure here
  // aborts before a single UPDATE has been issued.
  const staged: Array<{ id: string; plaintext: string }> = [];
  for (const row of rows) {
    try {
      const plaintext = decryptWithKey(
        { encrypted: row.encryptedValue, iv: row.iv, authTag: row.authTag },
        opts.oldKey,
      );
      staged.push({ id: row.id, plaintext });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RotationError(
        `Decrypt failed for api_keys.id=${row.id}: ${msg}. Aborting before any row is modified — the --old key does not match what this row was encrypted with.`,
        row.id,
      );
    }
  }

  if (opts.dryRun) {
    return {
      rowsScanned: rows.length,
      rowsRotated: 0,
      dryRun: true,
      rowsFailed: 0,
    };
  }

  // Phase 2 — re-encrypt and write. Each UPDATE is independent; on
  // the scale we're operating at (low-hundreds rows), a mid-phase-2
  // failure just means the operator reruns with the deployment still
  // on the old env key, which preserves recoverability.
  let rotated = 0;
  for (const { id, plaintext } of staged) {
    const reencrypted = encryptWithKey(plaintext, opts.newKey);
    await db
      .update(apiKeys)
      .set({
        encryptedValue: reencrypted.encrypted,
        iv: reencrypted.iv,
        authTag: reencrypted.authTag,
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.id, id))
      .run();
    rotated += 1;
  }

  return {
    rowsScanned: rows.length,
    rowsRotated: rotated,
    dryRun: false,
    rowsFailed: 0,
  };
}
