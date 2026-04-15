import { Hono } from "hono";
import type { Db } from "@provara/db";
import { users, sessions } from "@provara/db";
import { eq, and } from "drizzle-orm";
import { getAuthUser } from "../auth/admin.js";

export function createTeamRoutes(db: Db) {
  const app = new Hono();

  // List team members (same tenant)
  app.get("/", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) return c.json({ members: [] });

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

    return c.json({ members });
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

  return app;
}
