import type { Db } from "@provara/db";
import { adaptiveIsolationPreferencesLog, tenantAdaptiveIsolation } from "@provara/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantIsolationPolicy, type IsolationPolicy } from "./isolation-policy.js";

/**
 * Per-tenant toggles read + write. Writes atomically:
 *   1. Upsert the `tenant_adaptive_isolation` row.
 *   2. Append one row per changed field to `adaptive_isolation_preferences_log`.
 *
 * The log is append-only and carries `changedBy` so Enterprise audits can
 * answer "who flipped this, and when?".
 */
export interface IsolationPreferences {
  consumesPool: boolean;
  contributesPool: boolean;
}

export async function getIsolationPreferences(
  db: Db,
  tenantId: string,
): Promise<IsolationPreferences> {
  const row = await db
    .select()
    .from(tenantAdaptiveIsolation)
    .where(eq(tenantAdaptiveIsolation.tenantId, tenantId))
    .get();
  return {
    consumesPool: row?.consumesPool ?? false,
    contributesPool: row?.contributesPool ?? false,
  };
}

/**
 * Update a tenant's toggles and log every field that actually changed.
 * Idempotent — calling with the same values as current state is a no-op
 * (no log entry). Throws if the tenant's tier isn't eligible for
 * isolation toggles (Free/Pro); the API layer normally catches this
 * first, but we defend in depth.
 */
export async function updateIsolationPreferences(
  db: Db,
  tenantId: string,
  next: Partial<IsolationPreferences>,
  changedBy: string,
): Promise<IsolationPreferences> {
  const policy = await getTenantIsolationPolicy(db, tenantId);
  if (policy.tier !== "team" && policy.tier !== "enterprise") {
    throw new Error(
      `tenant ${tenantId} on tier "${policy.tier}" cannot modify isolation preferences`,
    );
  }

  const current = await getIsolationPreferences(db, tenantId);
  const merged: IsolationPreferences = {
    consumesPool: next.consumesPool ?? current.consumesPool,
    contributesPool: next.contributesPool ?? current.contributesPool,
  };

  const changes: { field: string; oldValue: boolean; newValue: boolean }[] = [];
  if (merged.consumesPool !== current.consumesPool) {
    changes.push({ field: "consumes_pool", oldValue: current.consumesPool, newValue: merged.consumesPool });
  }
  if (merged.contributesPool !== current.contributesPool) {
    changes.push({ field: "contributes_pool", oldValue: current.contributesPool, newValue: merged.contributesPool });
  }

  if (changes.length === 0) return current;

  const now = new Date();
  await db
    .insert(tenantAdaptiveIsolation)
    .values({ tenantId, ...merged, updatedAt: now })
    .onConflictDoUpdate({
      target: tenantAdaptiveIsolation.tenantId,
      set: { ...merged, updatedAt: now },
    })
    .run();

  for (const c of changes) {
    await db.insert(adaptiveIsolationPreferencesLog).values({
      id: nanoid(),
      tenantId,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      changedAt: now,
      changedBy,
    }).run();
  }

  return merged;
}

/** Re-exports so API layer can keep imports flat. */
export { getTenantIsolationPolicy, type IsolationPolicy };
