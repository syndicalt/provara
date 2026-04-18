import { Hono } from "hono";
import type { Db } from "@provara/db";
import { conversations } from "@provara/db";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId, tenantFilter } from "../auth/tenant.js";

const DEFAULT_LIMIT = 50;
const MAX_TITLE_LENGTH = 60;

function defaultTitle(messages: unknown): string {
  if (!Array.isArray(messages)) return "Untitled";
  const firstUser = messages.find(
    (m: { role?: string; content?: string }) => m.role === "user" && typeof m.content === "string" && m.content.trim(),
  );
  const raw = (firstUser as { content?: string } | undefined)?.content?.trim();
  if (!raw) return "Untitled";
  const collapsed = raw.replace(/\s+/g, " ");
  return collapsed.length > MAX_TITLE_LENGTH
    ? `${collapsed.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : collapsed;
}

export function createConversationRoutes(db: Db) {
  const app = new Hono();

  // List conversations for the current tenant. Newest first; title + updatedAt
  // are enough for a sidebar — messages aren't serialized in the list
  // response to keep it cheap.
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const limit = Math.min(parseInt(c.req.query("limit") || String(DEFAULT_LIMIT)), 200);
    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(tenantFilter(conversations.tenantId, tenantId))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit)
      .all();
    return c.json({ conversations: rows });
  });

  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw) || null;
    const body = await c.req.json<{ title?: string; messages: unknown }>();
    const id = nanoid();
    const title = body.title?.trim() || defaultTitle(body.messages);
    const now = new Date();
    await db
      .insert(conversations)
      .values({
        id,
        tenantId,
        title,
        messages: JSON.stringify(body.messages ?? []),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return c.json({ id, title, createdAt: now, updatedAt: now }, 201);
  });

  app.get("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const id = c.req.param("id");
    const tenantClause = tenantFilter(conversations.tenantId, tenantId);
    const where = tenantClause ? and(eq(conversations.id, id), tenantClause) : eq(conversations.id, id);
    const row = await db.select().from(conversations).where(where).get();
    if (!row) return c.json({ error: { message: "Not found", type: "not_found" } }, 404);
    let messages: unknown = [];
    try {
      messages = JSON.parse(row.messages);
    } catch {}
    return c.json({
      id: row.id,
      title: row.title,
      messages,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  app.patch("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const id = c.req.param("id");
    const tenantClause = tenantFilter(conversations.tenantId, tenantId);
    const where = tenantClause ? and(eq(conversations.id, id), tenantClause) : eq(conversations.id, id);

    const existing = await db.select().from(conversations).where(where).get();
    if (!existing) return c.json({ error: { message: "Not found", type: "not_found" } }, 404);

    const body = await c.req.json<{ title?: string; messages?: unknown }>();
    const next: { title?: string; messages?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (typeof body.title === "string") next.title = body.title.slice(0, 200);
    if (body.messages !== undefined) next.messages = JSON.stringify(body.messages);

    await db.update(conversations).set(next).where(where).run();
    return c.json({ id, updated: true, updatedAt: next.updatedAt });
  });

  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const id = c.req.param("id");
    const tenantClause = tenantFilter(conversations.tenantId, tenantId);
    const where = tenantClause ? and(eq(conversations.id, id), tenantClause) : eq(conversations.id, id);
    await db.delete(conversations).where(where).run();
    return c.json({ deleted: true });
  });

  return app;
}
