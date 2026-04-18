#!/usr/bin/env tsx
/**
 * Operator CLI: rotate `PROVARA_MASTER_KEY` (#190).
 *
 * Re-encrypts every row in `api_keys` from `--old` to `--new` inside
 * a single transaction. See `docs/runbooks/master-key-rotation.md`
 * for the full operator procedure (when, how, verify, rollback).
 *
 * Usage:
 *   tsx packages/gateway/scripts/rotate-master-key.ts \
 *     --old "<current PROVARA_MASTER_KEY>" \
 *     --new "<new 32-byte hex key>" \
 *     [--dry-run]
 *
 * Environment:
 *   DATABASE_URL         libSQL/Turso URL (required — points at prod DB)
 *   DATABASE_AUTH_TOKEN  libSQL auth token (required for Turso)
 *
 * Safety:
 *   - Both --old and --new are read from argv, not env, so the
 *     current `PROVARA_MASTER_KEY` env var on the operator's machine
 *     does not need to match the DB's key (which matters during
 *     recovery scenarios where the in-use env key is wrong).
 *   - `--dry-run` decrypts every row with the old key but writes
 *     nothing. Always run it first.
 *   - The rotation itself is a single transaction; a crash mid-way
 *     rolls back. The pre-rotation state is always recoverable by
 *     simply not swapping the deployment's env var.
 */

import { parseArgs } from "node:util";
import { createDb } from "@provara/db";
import { rotateMasterKey, RotationError } from "../src/crypto/rotate.js";

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      old: { type: "string" },
      new: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(
      [
        "Usage: rotate-master-key --old <key> --new <key> [--dry-run]",
        "",
        "Re-encrypts api_keys rows from --old to --new. See",
        "docs/runbooks/master-key-rotation.md for the full procedure.",
      ].join("\n"),
    );
    process.exit(0);
  }

  if (!values.old) die("--old is required");
  if (!values.new) die("--new is required");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) die("DATABASE_URL is required");

  console.log(`[rotate] connecting to ${dbUrl.replace(/token=[^&]+/i, "token=***")}`);
  const db = createDb(dbUrl);

  try {
    const stats = await rotateMasterKey(db, {
      oldKey: values.old!,
      newKey: values.new!,
      dryRun: values["dry-run"],
    });
    if (stats.dryRun) {
      console.log(
        `[rotate] DRY RUN — scanned ${stats.rowsScanned} row(s). Every row decrypts cleanly with the --old key. Re-run without --dry-run to perform the rotation.`,
      );
    } else {
      console.log(
        `[rotate] rotated ${stats.rowsRotated} of ${stats.rowsScanned} row(s). Next: update the PROVARA_MASTER_KEY env var to the new value and restart the gateway.`,
      );
    }
  } catch (err) {
    if (err instanceof RotationError) {
      die(`${err.message}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    die(msg);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  die(msg);
});
