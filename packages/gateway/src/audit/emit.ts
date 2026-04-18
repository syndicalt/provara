import type { Db } from "@provara/db";
import { auditLogs, users } from "@provara/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AuditAction } from "./actions.js";

/**
 * Audit event emitter (#210/T2). Called from the ~10 handlers that
 * produce security- or admin-relevant state changes. Writes one row
 * into `audit_logs`.
 *
 * Fire-and-forget semantics: an audit write failure MUST NOT prevent
 * the underlying action from succeeding. If the audit log is down or
 * the DB hiccups, we lose the row but the user still gets their API
 * key created / subscription changed / whatever. The trade-off favors
 * availability over completeness — a security admin can always ask
 * Stripe / OAuth providers for their own logs if ours drops an event.
 *
 * Callers:
 *   - Do NOT await this. (It returns a promise; discard it.)
 *   - Pass a denormalized `actorEmail` if you already have it — saves
 *     a DB roundtrip. Otherwise pass just `actorUserId` and the
 *     function will fetch.
 *   - System-emitted events (scheduler cycles, webhook handlers) pass
 *     `actorUserId: null` and optionally `actorEmail: null`.
 */
export interface AuditEvent {
  tenantId: string;
  action: AuditAction;
  actorUserId?: string | null;
  /** Skip a users-table roundtrip when the caller already has it. */
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function emitAudit(db: Db, event: AuditEvent): void {
  // Don't await — caller paths can return immediately and the write
  // happens on the next tick. Errors are swallowed and logged so a bad
  // audit write doesn't propagate a rejection out of fire-and-forget.
  void writeAuditRow(db, event).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[audit] write failed for tenant=${event.tenantId} action=${event.action}: ${msg}`,
    );
  });
}

/**
 * Awaitable variant for tests that need to observe the written row.
 * Production paths should use `emitAudit` instead — awaiting couples
 * audit-log availability to the success of the underlying action,
 * which is what the fire-and-forget design explicitly avoids.
 */
export async function emitAuditSync(db: Db, event: AuditEvent): Promise<void> {
  await writeAuditRow(db, event);
}

async function writeAuditRow(db: Db, event: AuditEvent): Promise<void> {
  let actorEmail = event.actorEmail ?? null;
  if (actorEmail === null && event.actorUserId) {
    const row = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, event.actorUserId))
      .get();
    actorEmail = row?.email ?? null;
  }
  await db
    .insert(auditLogs)
    .values({
      id: nanoid(),
      tenantId: event.tenantId,
      actorUserId: event.actorUserId ?? null,
      actorEmail,
      action: event.action,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      metadata: event.metadata ?? null,
      createdAt: new Date(),
    })
    .run();
}
