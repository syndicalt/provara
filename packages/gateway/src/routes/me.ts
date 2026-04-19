import { Hono } from "hono";
import type { Db } from "@provara/db";
import {
  users,
  sessions,
  oauthAccounts,
  teamInvites,
  apiKeys,
  apiTokens,
  subscriptions,
  auditLogs,
  requests,
  costLogs,
  feedback,
  modelScores,
  promptTemplates,
  promptVersions,
  alertRules,
  alertLogs,
  guardrailRules,
  guardrailLogs,
  spendBudgets,
  abTests,
  abTestVariants,
  conversations,
  semanticCache,
  customProviders,
  usageReports,
  tenantAdaptiveIsolation,
  routingWeightSnapshots,
} from "@provara/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { getAuthUser } from "../auth/admin.js";
import { getSessionFromCookie, deleteSession } from "../auth/session.js";
import { emitAudit } from "../audit/emit.js";
import {
  AUDIT_USER_PROFILE_UPDATED,
  AUDIT_USER_SESSIONS_REVOKED_ALL,
  AUDIT_USER_SELF_REMOVED,
  AUDIT_TENANT_DELETED,
} from "../audit/actions.js";
import { getStripe } from "../stripe/index.js";
import { getSubscriptionForTenant } from "../stripe/subscriptions.js";

/**
 * Self-service profile routes (#251). These are all gated by the
 * adminAuth middleware (session cookie present) so every handler can
 * trust `getAuthUser` without re-checking. They are NOT under
 * /v1/admin/* because there's no admin-role gate — any authenticated
 * user can manage their own profile.
 */
export function createMeRoutes(db: Db) {
  const app = new Hono();

  /**
   * Returns the caller's profile plus a handful of derived flags the
   * UI needs to render the danger zone correctly: isSoleOwner (drives
   * the delete-tenant path vs. leave-tenant path) and authMethods
   * (so we can show "connected via Google" etc.).
   */
  app.get("/", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }

    const me = await db.select().from(users).where(eq(users.id, authUser.id)).get();
    if (!me) {
      return c.json({ error: { message: "User not found", type: "not_found" } }, 404);
    }

    const ownerCountRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.tenantId, authUser.tenantId), eq(users.role, "owner")))
      .get();
    const ownerCount = ownerCountRow?.count ?? 0;
    const isSoleOwner = me.role === "owner" && ownerCount <= 1;

    const methods = await db
      .select({ provider: oauthAccounts.provider })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, authUser.id))
      .all();

    return c.json({
      user: {
        id: me.id,
        email: me.email,
        name: me.name,
        firstName: me.firstName,
        lastName: me.lastName,
        avatarUrl: me.avatarUrl,
        tenantId: me.tenantId,
        role: me.role,
        createdAt: me.createdAt,
        isSoleOwner,
        ownerCount,
        authMethods: methods.map((m) => m.provider),
      },
    });
  });

  /**
   * Update name fields. Email, role, tenant are immutable from this
   * endpoint — those require admin flows. Firstname/lastname are
   * optional; `name` is the concatenated display name we keep in sync
   * on insert elsewhere in the codebase.
   */
  app.patch("/", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }

    const body = await c.req.json<{ firstName?: string; lastName?: string; avatarUrl?: string }>();
    const updates: Record<string, unknown> = {};
    if (typeof body.firstName === "string") updates.firstName = body.firstName.trim();
    if (typeof body.lastName === "string") updates.lastName = body.lastName.trim();
    if (typeof body.avatarUrl === "string") updates.avatarUrl = body.avatarUrl.trim() || null;

    if (typeof body.firstName === "string" || typeof body.lastName === "string") {
      const before = await db.select().from(users).where(eq(users.id, authUser.id)).get();
      const first = (updates.firstName as string | undefined) ?? before?.firstName ?? "";
      const last = (updates.lastName as string | undefined) ?? before?.lastName ?? "";
      const combined = [first, last].filter(Boolean).join(" ");
      updates.name = combined || null;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: { message: "No updatable fields provided", type: "validation_error" } }, 400);
    }

    await db.update(users).set(updates).where(eq(users.id, authUser.id)).run();

    emitAudit(db, {
      tenantId: authUser.tenantId,
      actorUserId: authUser.id,
      action: AUDIT_USER_PROFILE_UPDATED,
      resourceType: "user",
      resourceId: authUser.id,
      metadata: { fields: Object.keys(updates) },
    });

    const updated = await db.select().from(users).where(eq(users.id, authUser.id)).get();
    return c.json({ user: updated });
  });

  /**
   * Active sessions for the caller. We don't track user-agent or IP on
   * the sessions table today, so the UI surfaces id prefix, createdAt,
   * expiresAt, and whether this is the "current" session (matched via
   * the cookie).
   */
  app.get("/sessions", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }

    const currentSessionId = getSessionFromCookie(c);
    const rows = await db
      .select({ id: sessions.id, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, authUser.id))
      .all();

    return c.json({
      sessions: rows.map((s) => ({
        id: s.id.slice(0, 12),
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        current: s.id === currentSessionId,
      })),
    });
  });

  /**
   * Revoke every session for the caller except the current one. Used
   * by "sign out everywhere else" in the profile UI. Explicit opt-out
   * of current session so the user doesn't accidentally log themselves
   * out in the same click.
   */
  app.post("/sessions/revoke-others", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }

    const currentSessionId = getSessionFromCookie(c);
    const removed = await db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, authUser.id),
          currentSessionId ? ne(sessions.id, currentSessionId) : sql`1 = 1`,
        ),
      )
      .run();

    emitAudit(db, {
      tenantId: authUser.tenantId,
      actorUserId: authUser.id,
      action: AUDIT_USER_SESSIONS_REVOKED_ALL,
      resourceType: "user",
      resourceId: authUser.id,
      metadata: { preserved_session_prefix: currentSessionId?.slice(0, 8) ?? null },
    });

    return c.json({ revoked: removed.rowsAffected ?? 0 });
  });

  /**
   * Account deletion. Behavior branches on whether the caller is the
   * sole owner of their tenant:
   *   - Non-sole-owner: remove just the user (mirrors DELETE /admin/team/:id
   *     cleanup of oauth, invites, sessions). Tenant and sub stay put.
   *   - Sole owner: require `confirmTenantName` matching the tenant ID
   *     (or a friendlier display name if we add one), cancel the Stripe
   *     subscription immediately, purge every tenant-scoped table, then
   *     the user row.
   *
   * Both paths audit before the data is gone. The sole-owner path audit
   * is snapshotted into the event metadata because audit_logs itself is
   * wiped alongside the rest of the tenant data — the act of deletion is
   * recorded on the deleted tenant's own log, which is then gone. If we
   * ever need a cross-tenant "system" audit, revisit.
   */
  app.delete("/", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }

    const body: { confirmTenantName?: string } = await c.req
      .json<{ confirmTenantName?: string }>()
      .catch(() => ({}));

    const ownerCountRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.tenantId, authUser.tenantId), eq(users.role, "owner")))
      .get();
    const ownerCount = ownerCountRow?.count ?? 0;
    const isSoleOwner = authUser.role === "owner" && ownerCount <= 1;

    if (isSoleOwner) {
      if (!body.confirmTenantName || body.confirmTenantName !== authUser.tenantId) {
        return c.json(
          {
            error: {
              message:
                "Deleting your account as the sole owner will delete the entire tenant and cancel the subscription. Send `confirmTenantName` matching your tenant ID to proceed.",
              type: "confirmation_required",
            },
            tenantId: authUser.tenantId,
          },
          400,
        );
      }

      const actorRow = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, authUser.id))
        .get();
      await deleteTenantCompletely(db, authUser.tenantId, authUser.id, actorRow?.email ?? null);
      return c.json({ deleted: true, tenantDeleted: true });
    }

    // Non-sole-owner: leave the tenant.
    await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, authUser.id)).run();
    await db.delete(teamInvites).where(eq(teamInvites.invitedByUserId, authUser.id)).run();
    await db
      .update(teamInvites)
      .set({ consumedByUserId: null })
      .where(eq(teamInvites.consumedByUserId, authUser.id))
      .run();
    await db.delete(sessions).where(eq(sessions.userId, authUser.id)).run();

    const selfRow = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, authUser.id))
      .get();
    emitAudit(db, {
      tenantId: authUser.tenantId,
      actorUserId: authUser.id,
      action: AUDIT_USER_SELF_REMOVED,
      resourceType: "user",
      resourceId: authUser.id,
      metadata: { email: selfRow?.email ?? null },
    });

    await db.delete(users).where(eq(users.id, authUser.id)).run();
    return c.json({ deleted: true, tenantDeleted: false });
  });

  return app;
}

/**
 * Full tenant wipe for the sole-owner delete path. Order matters only
 * where we have foreign keys; SQLite lets us delete in any order for
 * unrelated tables. We audit-log first (on the doomed tenant) and
 * console-log a summary because the DB trail is going with it.
 */
async function deleteTenantCompletely(
  db: Db,
  tenantId: string,
  actorUserId: string,
  actorEmail: string | null,
): Promise<void> {
  // Snapshot + audit first — that row gets wiped along with the rest
  // but also appears in the console log for forensic purposes.
  const userCountRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .get();

  emitAudit(db, {
    tenantId,
    actorUserId,
    action: AUDIT_TENANT_DELETED,
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {
      actor_email: actorEmail,
      users_at_delete: userCountRow?.count ?? 0,
    },
  });

  console.warn(
    `[tenant-delete] tenant=${tenantId} actor=${actorUserId}<${actorEmail}> users=${userCountRow?.count ?? 0}`,
  );

  // Cancel Stripe sub if present. Failure here should NOT block the
  // local purge — leaving the user unable to delete because Stripe is
  // down is the worse outcome. We log the error and continue; ops can
  // reconcile orphan Stripe subs from the dashboard.
  const existingSub = await getSubscriptionForTenant(db, tenantId);
  const stripe = getStripe();
  if (existingSub?.stripeSubscriptionId && stripe) {
    try {
      await stripe.subscriptions.cancel(existingSub.stripeSubscriptionId);
    } catch (err) {
      console.error(
        `[tenant-delete] Stripe cancel failed for sub=${existingSub.stripeSubscriptionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Delete child rows first for tables that FK back to users or to
  // tenant-scoped parents, then the parents.
  const userRows = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId)).all();
  const userIds = userRows.map((u) => u.id);

  for (const uid of userIds) {
    await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, uid)).run();
    await db.delete(sessions).where(eq(sessions.userId, uid)).run();
  }

  // Tenant-scoped content tables.
  await db.delete(teamInvites).where(eq(teamInvites.tenantId, tenantId)).run();
  await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId)).run();
  await db.delete(apiTokens).where(eq(apiTokens.tenant, tenantId)).run();
  await db.delete(subscriptions).where(eq(subscriptions.tenantId, tenantId)).run();
  await db.delete(requests).where(eq(requests.tenantId, tenantId)).run();
  await db.delete(costLogs).where(eq(costLogs.tenantId, tenantId)).run();
  await db.delete(feedback).where(eq(feedback.tenantId, tenantId)).run();
  await db.delete(modelScores).where(eq(modelScores.tenantId, tenantId)).run();
  // promptVersions joins prompts via templateId; purge by parent.
  const tenantPromptRows = await db
    .select({ id: promptTemplates.id })
    .from(promptTemplates)
    .where(eq(promptTemplates.tenantId, tenantId))
    .all();
  for (const p of tenantPromptRows) {
    await db.delete(promptVersions).where(eq(promptVersions.templateId, p.id)).run();
  }
  await db.delete(promptTemplates).where(eq(promptTemplates.tenantId, tenantId)).run();
  // alertLogs joins via ruleId; purge by parent.
  const tenantAlertRows = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(eq(alertRules.tenantId, tenantId))
    .all();
  for (const a of tenantAlertRows) {
    await db.delete(alertLogs).where(eq(alertLogs.ruleId, a.id)).run();
  }
  await db.delete(alertRules).where(eq(alertRules.tenantId, tenantId)).run();
  await db.delete(guardrailLogs).where(eq(guardrailLogs.tenantId, tenantId)).run();
  await db.delete(guardrailRules).where(eq(guardrailRules.tenantId, tenantId)).run();
  await db.delete(spendBudgets).where(eq(spendBudgets.tenantId, tenantId)).run();
  // abTestVariants has no tenantId column — join through abTests.
  const tenantAbTestRows = await db
    .select({ id: abTests.id })
    .from(abTests)
    .where(eq(abTests.tenantId, tenantId))
    .all();
  for (const t of tenantAbTestRows) {
    await db.delete(abTestVariants).where(eq(abTestVariants.abTestId, t.id)).run();
  }
  await db.delete(abTests).where(eq(abTests.tenantId, tenantId)).run();
  await db.delete(conversations).where(eq(conversations.tenantId, tenantId)).run();
  await db.delete(semanticCache).where(eq(semanticCache.tenantId, tenantId)).run();
  await db.delete(customProviders).where(eq(customProviders.tenantId, tenantId)).run();
  await db.delete(usageReports).where(eq(usageReports.tenantId, tenantId)).run();
  await db.delete(tenantAdaptiveIsolation).where(eq(tenantAdaptiveIsolation.tenantId, tenantId)).run();
  await db.delete(routingWeightSnapshots).where(eq(routingWeightSnapshots.tenantId, tenantId)).run();
  await db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId)).run();

  // Finally, the users themselves.
  await db.delete(users).where(eq(users.tenantId, tenantId)).run();
}
