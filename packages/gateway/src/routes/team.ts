import { Hono } from "hono";
import type { Db } from "@provara/db";
import { users, sessions, teamInvites, oauthAccounts } from "@provara/db";
import { eq, and, isNull, gte, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getAuthUser } from "../auth/admin.js";
import { getSeatStatus } from "../billing/seats.js";
import { sendEmail } from "../email/index.js";
import { inviteEmail } from "../email/templates.js";
import { emitAudit } from "../audit/emit.js";
import {
  AUDIT_USER_INVITED,
  AUDIT_USER_REMOVED,
  AUDIT_USER_ROLE_CHANGED,
} from "../audit/actions.js";

// Default invite lifetime — 7 days. Long enough to survive weekends,
// short enough that forgotten invites don't pollute the seat count
// indefinitely.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function dashboardOrigin(c: import("hono").Context): string {
  return c.req.header("origin") || "https://www.provara.xyz";
}

export function createTeamRoutes(db: Db) {
  const app = new Hono();

  // List team members + seat status. The seat block powers the
  // dashboard header counter ("3 / 10 seats").
  app.get("/", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) return c.json({ members: [], seats: null });

    const members = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.tenantId, authUser.tenantId))
      .all();

    const seats = await getSeatStatus(db, authUser.tenantId);
    return c.json({ members, seats });
  });

  // Update a member's role. Admin+ required at the router level;
  // in-handler guards enforce the "owner is pinned" policy:
  //   - nobody can change their own role (prevents self-demotion or
  //     self-promotion, and removes the only foot-gun that could leave
  //     a tenant ownerless)
  //   - admins cannot touch owner rows (can't demote an owner, can't
  //     promote anyone to owner — prevents tenant hijacking)
  //   - the last remaining owner cannot be demoted (sharper,
  //     explicit invariant; today it's already guaranteed by the
  //     self-change block, but hard-coding it here means future path
  //     additions can't accidentally strand a tenant ownerless)
  app.patch("/:id", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }
    if (authUser.role !== "owner" && authUser.role !== "admin") {
      return c.json({ error: { message: "Admin role or higher required.", type: "auth_error" } }, 403);
    }

    const targetId = c.req.param("id");
    if (targetId === authUser.id) {
      return c.json({ error: { message: "Cannot change your own role", type: "validation_error" } }, 400);
    }

    const body = await c.req.json<{ role: string }>();
    const VALID_ROLES = ["owner", "admin", "developer", "viewer"] as const;
    type ValidRole = typeof VALID_ROLES[number];
    if (!VALID_ROLES.includes(body.role as ValidRole)) {
      return c.json({ error: { message: `Role must be one of: ${VALID_ROLES.join(", ")}`, type: "validation_error" } }, 400);
    }

    const target = await db.select().from(users).where(
      and(eq(users.id, targetId), eq(users.tenantId, authUser.tenantId))
    ).get();

    if (!target) {
      return c.json({ error: { message: "Member not found", type: "not_found" } }, 404);
    }

    // Admins cannot demote an owner or create a new owner — keeps
    // ownership decisions (including the right to transfer or delete
    // the tenant) in the hands of existing owners.
    if (authUser.role !== "owner") {
      if (target.role === "owner") {
        return c.json({ error: { message: "Only an owner can change an owner's role.", type: "auth_error" } }, 403);
      }
      if (body.role === "owner") {
        return c.json({ error: { message: "Only an owner can promote someone to owner.", type: "auth_error" } }, 403);
      }
    }

    // Last-owner invariant: refuse to demote the only remaining owner,
    // even if the caller is that owner. Keeps the tenant recoverable.
    if (target.role === "owner" && body.role !== "owner") {
      const ownerCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.tenantId, authUser.tenantId), eq(users.role, "owner")))
        .get();
      if ((ownerCount?.count ?? 0) <= 1) {
        return c.json(
          { error: { message: "Cannot demote the last owner. Promote another member to owner first.", type: "validation_error" } },
          400,
        );
      }
    }

    await db.update(users).set({ role: body.role as ValidRole }).where(eq(users.id, targetId)).run();

    const updated = await db.select().from(users).where(eq(users.id, targetId)).get();
    emitAudit(db, {
      tenantId: authUser.tenantId,
      actorUserId: authUser.id,
      action: AUDIT_USER_ROLE_CHANGED,
      resourceType: "user",
      resourceId: targetId,
      metadata: {
        target_email: target.email,
        from: target.role,
        to: body.role,
      },
    });
    return c.json({ member: updated });
  });

  // Remove a member. Same policy as role-change: admin+ at router
  // level, with in-handler guards for owner-pinning and last-owner
  // invariant.
  app.delete("/:id", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }
    if (authUser.role !== "owner" && authUser.role !== "admin") {
      return c.json({ error: { message: "Admin role or higher required.", type: "auth_error" } }, 403);
    }

    const targetId = c.req.param("id");
    if (targetId === authUser.id) {
      return c.json({ error: { message: "Cannot remove yourself", type: "validation_error" } }, 400);
    }

    const target = await db.select().from(users).where(
      and(eq(users.id, targetId), eq(users.tenantId, authUser.tenantId))
    ).get();

    if (!target) {
      return c.json({ error: { message: "Member not found", type: "not_found" } }, 404);
    }

    // Admins can't remove owners.
    if (authUser.role !== "owner" && target.role === "owner") {
      return c.json({ error: { message: "Only an owner can remove an owner.", type: "auth_error" } }, 403);
    }

    // Last-owner invariant on removal.
    if (target.role === "owner") {
      const ownerCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.tenantId, authUser.tenantId), eq(users.role, "owner")))
        .get();
      if ((ownerCount?.count ?? 0) <= 1) {
        return c.json(
          { error: { message: "Cannot remove the last owner. Promote another member to owner first.", type: "validation_error" } },
          400,
        );
      }
    }

    // Clean up rows that hold a FK into users so the final user delete
    // doesn't trip SQLITE_CONSTRAINT. Surfaced during #209 SSO UAT: a
    // member who previously signed in via Google OAuth had an
    // oauth_accounts row, and the original delete path only removed
    // sessions + users → FK violation → 500 → dashboard shows "unknown
    // error."
    //
    // Handled here, keyed by kind of relationship:
    //   - oauth_accounts: linked logins (1-to-many by provider). Delete.
    //   - team_invites.invited_by_user_id: NOT NULL FK; row can't
    //     survive without the inviter, so delete their invites.
    //   - team_invites.consumed_by_user_id: nullable FK; null it out
    //     rather than delete so the audit trail ("this invite was
    //     accepted, at what time") survives the user leaving.
    //   - sessions: existing behavior, kept.
    await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, targetId)).run();
    await db.delete(teamInvites).where(eq(teamInvites.invitedByUserId, targetId)).run();
    await db
      .update(teamInvites)
      .set({ consumedByUserId: null })
      .where(eq(teamInvites.consumedByUserId, targetId))
      .run();
    await db.delete(sessions).where(eq(sessions.userId, targetId)).run();
    await db.delete(users).where(eq(users.id, targetId)).run();

    emitAudit(db, {
      tenantId: authUser.tenantId,
      actorUserId: authUser.id,
      action: AUDIT_USER_REMOVED,
      resourceType: "user",
      resourceId: targetId,
      metadata: { target_email: target.email },
    });
    return c.json({ deleted: true });
  });

  // --- Invites (#177) ---

  // List pending invites for the current tenant. "Pending" means
  // unconsumed AND unexpired — expired rows hang around for audit
  // but aren't shown as actionable.
  app.get("/invites", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) return c.json({ invites: [] });
    const now = new Date();
    const rows = await db
      .select({
        token: teamInvites.token,
        invitedEmail: teamInvites.invitedEmail,
        invitedRole: teamInvites.invitedRole,
        invitedByUserId: teamInvites.invitedByUserId,
        expiresAt: teamInvites.expiresAt,
        createdAt: teamInvites.createdAt,
      })
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.tenantId, authUser.tenantId),
          isNull(teamInvites.consumedAt),
          gte(teamInvites.expiresAt, now),
        ),
      )
      .orderBy(desc(teamInvites.createdAt))
      .all();
    return c.json({ invites: rows });
  });

  // Create an invite. Owner-only, seat-limit enforced against the
  // tier's SEAT_QUOTAS. Returns both the invite URL (for copy-paste
  // fallback) and whether the transactional email was sent.
  app.post("/invites", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required", type: "auth_error" } }, 401);
    }
    // Defense-in-depth: the router mounts this under `requireRole("admin")`
    // so developers/viewers never reach here in prod, but the handler
    // check keeps the invariant independent of router wiring.
    if (authUser.role !== "owner" && authUser.role !== "admin") {
      return c.json({ error: { message: "Admin role or higher required to invite members.", type: "auth_error" } }, 403);
    }

    const VALID_INVITE_ROLES = ["owner", "admin", "developer", "viewer"] as const;
    type InviteRole = typeof VALID_INVITE_ROLES[number];
    const body = await c.req
      .json<{ email?: string; role?: InviteRole }>()
      .catch(() => ({} as { email?: string; role?: InviteRole }));
    const email = (body.email ?? "").trim().toLowerCase();
    const role: InviteRole = VALID_INVITE_ROLES.includes(body.role as InviteRole)
      ? (body.role as InviteRole)
      : "developer";

    // Admins can't invite as owner — matches the PATCH policy.
    if (authUser.role !== "owner" && role === "owner") {
      return c.json({ error: { message: "Only an owner can invite someone as owner.", type: "auth_error" } }, 403);
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: { message: "Valid email address required.", type: "validation_error" } }, 400);
    }

    // Refuse if the invited email already belongs to a user on this
    // tenant — not a bug, just nothing to invite them to.
    const existingMember = await db
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.tenantId, authUser.tenantId),
        sql`LOWER(${users.email}) = ${email}`,
      ))
      .get();
    if (existingMember) {
      return c.json(
        { error: { message: "That email is already a member of this team.", type: "validation_error" } },
        409,
      );
    }

    // Seat limit check — counts active members + pending invites.
    const seats = await getSeatStatus(db, authUser.tenantId);
    if (!seats.canInvite) {
      return c.json(
        {
          error: {
            message: `Seat limit reached (${seats.used} / ${seats.limit}). Remove a member or upgrade your plan before inviting more.`,
            type: "seat_limit",
          },
          gate: {
            reason: "seat_limit",
            currentTier: seats.tier,
            used: seats.used,
            limit: seats.limit,
            upgradeUrl: "/dashboard/billing",
          },
        },
        402,
      );
    }

    // Refuse if the same email already has an unconsumed invite on
    // this tenant — avoid duplicate tokens in the UI.
    const existingInvite = await db
      .select({ token: teamInvites.token })
      .from(teamInvites)
      .where(and(
        eq(teamInvites.tenantId, authUser.tenantId),
        sql`LOWER(${teamInvites.invitedEmail}) = ${email}`,
        isNull(teamInvites.consumedAt),
        gte(teamInvites.expiresAt, new Date()),
      ))
      .get();
    if (existingInvite) {
      return c.json(
        { error: { message: "An active invite for that email already exists.", type: "duplicate_invite" } },
        409,
      );
    }

    const token = nanoid(32);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await db
      .insert(teamInvites)
      .values({
        token,
        tenantId: authUser.tenantId,
        invitedEmail: email,
        invitedRole: role,
        invitedByUserId: authUser.id,
        expiresAt,
      })
      .run();

    emitAudit(db, {
      tenantId: authUser.tenantId,
      actorUserId: authUser.id,
      action: AUDIT_USER_INVITED,
      resourceType: "team_invite",
      resourceId: token,
      metadata: { invited_email: email, invited_role: role },
    });

    const inviteUrl = `${dashboardOrigin(c)}/invite/${token}`;

    // Send the transactional email. Non-blocking on failure — the
    // invite row is already persisted and the owner can copy the
    // link from the dashboard.
    const inviterRow = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, authUser.id))
      .get();
    const inviterName = inviterRow?.name || inviterRow?.email || "Someone";

    const tmpl = inviteEmail({
      inviteUrl,
      inviterName,
      inviterEmail: inviterRow?.email || "",
      invitedEmail: email,
      role,
      expiresAt,
    });
    const emailResult = await sendEmail({
      to: email,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    });

    return c.json({
      token,
      invitedEmail: email,
      invitedRole: role,
      inviteUrl,
      expiresAt,
      emailSent: emailResult.sent,
    }, 201);
  });

  // Revoke a pending invite. Owner-only. Already-consumed invites
  // can't be revoked (the member is already on the team — use the
  // member delete flow instead).
  app.delete("/invites/:token", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser || authUser.role !== "owner") {
      return c.json({ error: { message: "Owner access required", type: "auth_error" } }, 403);
    }
    const token = c.req.param("token");
    const invite = await db
      .select()
      .from(teamInvites)
      .where(and(
        eq(teamInvites.token, token),
        eq(teamInvites.tenantId, authUser.tenantId),
      ))
      .get();
    if (!invite) {
      return c.json({ error: { message: "Invite not found.", type: "not_found" } }, 404);
    }
    if (invite.consumedAt) {
      return c.json(
        { error: { message: "This invite has already been accepted. Remove the member instead.", type: "already_consumed" } },
        409,
      );
    }
    await db.delete(teamInvites).where(eq(teamInvites.token, token)).run();
    return c.json({ revoked: true });
  });

  return app;
}
