import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@provara/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dirname, "../../../db/drizzle");

/**
 * Build a fresh in-memory SQLite database with all migrations applied.
 * Each call returns a completely isolated DB — safe to use as a per-test fixture.
 */
export async function makeTestDb(): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db, MIGRATIONS);
  return db;
}
