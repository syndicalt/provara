import type { Db } from "@provara/db";
import { appConfig } from "@provara/db";
import { eq } from "drizzle-orm";

const ROUTING_CONFIG_KEY = "routing_config";

let abTestPreempts = true;

export function getRoutingConfig() {
  return { abTestPreempts };
}

export async function hydrateRoutingConfig(db: Db) {
  const row = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, ROUTING_CONFIG_KEY))
    .get();
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value) as { abTestPreempts?: boolean };
    if (typeof parsed.abTestPreempts === "boolean") {
      abTestPreempts = parsed.abTestPreempts;
    }
  } catch {
    // Malformed — keep defaults
  }
}

export async function setRoutingConfig(db: Db, config: { abTestPreempts?: boolean }) {
  if (config.abTestPreempts !== undefined) {
    abTestPreempts = config.abTestPreempts;
  }
  const value = JSON.stringify({ abTestPreempts });
  const now = new Date();
  await db
    .insert(appConfig)
    .values({ key: ROUTING_CONFIG_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: now },
    })
    .run();
}
