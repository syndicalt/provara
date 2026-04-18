import { Hono } from "hono";
import type { Db } from "@provara/db";
import { users, sessions, teamInvites } from "@provara/db";
import { eq, and, isNull, gte, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getAuthUser } from "../auth/admin.js";
import { getSeatStatus } from "../billing/seats.js";
import { sendEmail } from "../email/index.js";
import { inviteEmail } from "../email/templates.js";

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

  // Update a member's role (owner only)
  app.patch("/:id", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser || authUser.role !== "owner") {
      return c.json({ error: { message: "Owner access required", type: "auth_error" } }, 403);
    }

    const targetId = c.req.param("id");
    if (targetId === authUser.id) {
      return c.json({ error: { message: "Cannot change your own role", type: "validation_error" } }, 400);
    }

    const body = await c.req.json<{ role: string }>();
    if (body.role !== "owner" && body.role !== "member") {
      return c.json({ error: { message: "Role must be 'owner' or 'member'", type: "validation_error" } }, 400);
    }

    const target = await db.select().from(users).where(
      and(eq(users.id, targetId), eq(users.tenantId, authUser.tenantId))
    ).get();

    if (!target) {
      return c.json({ error: { message: "Member not found", type: "not_found" } }, 404);
    }

    await db.update(users).set({ role: body.role as "owner" | "member" }).where(eq(users.id, targetId)).run();

    const updated = await db.select().from(users).where(eq(users.id, targetId)).get();
    return c.json({ member: updated });
  });

  // Remove a member (owner only)
  app.delete("/:id", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser || authUser.role !== "owner") {
      return c.json({ error: { message: "Owner access required", type: "auth_error" } }, 403);
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

    // Delete their sessions first
    await db.delete(sessions).where(eq(sessions.userId, targetId)).run();
    await db.delete(users).where(eq(users.id, targetId)).run();

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
    if (!authUser || authUser.role !== "owner") {
      return c.json({ error: { message: "Owner access required", type: "auth_error" } }, 403);
    }

    const body = await c.req
      .json<{ email?: string; role?: "owner" | "member" }>()
      .catch(() => ({} as { email?: string; role?: "owner" | "member" }));
    const email = (body.email ?? "").trim().toLowerCase();
    const role: "owner" | "member" = body.role === "owner" ? "owner" : "member";

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
