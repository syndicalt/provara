import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export function createDb(url?: string) {
  const sqlite = new Database(url || process.env.DATABASE_URL || "provara.db");
  sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema.js";
