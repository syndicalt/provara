import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, "..", "provara.db");

export function createDb(url?: string) {
  const sqlite = new Database(url || process.env.DATABASE_URL || DEFAULT_DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema.js";
