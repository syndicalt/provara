import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

const DEFAULT_DB_URL = "file:provara.db";

export function createDb(url?: string) {
  const client = createClient({
    url: url || process.env.DATABASE_URL || DEFAULT_DB_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema.js";
