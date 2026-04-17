import type { Context } from "hono";
import type { Db } from "@provara/db";
import { conversations, shares } from "@provara/db";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId } from "../auth/tenant.js";

/**
 * Handler set for conversation share-link endpoints. Kept as loose handlers
 * (not a pre-mounted sub-app) because they span two mount paths and two
 * auth tiers:
 *
 *   GET    /v1/shares/:token                — public, mounted BEFORE auth middleware
 *   POST   /v1/conversations/:id/share      — authed, admin middleware applies
 *   DELETE /v1/shares/:token                — authed, admin middleware applies
 *
 * Tokens are long random strings (`sh_<32>`); guessing is impractical. A
 * conversation can have at most one active (non-revoked) share at a time —
 * hitting POST again just returns the existing token rather than minting
 * orphans.
 */
export function createShareHandlers(db: Db) {
  async function getPublic(c: Context) {
    const token = c.req.param("token");
    if (!token) return c.json({ error: { message: "token required", type: "bad_request" } }, 400);
    const share = await db
      .select()
      .from(shares)
      .where(and(eq(shares.token, token), isNull(shares.revokedAt)))
      .get();
    if (!share) {
      return c.json({ error: { message: "Share not found or revoked", type: "not_found" } }, 404);
    }
    const conv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, share.conversationId))
      .get();
    if (!conv) {
      return c.json({ error: { message: "Conversation not found", type: "not_found" } }, 404);
    }
    let messages: unknown = [];
    try {
      messages = JSON.parse(conv.messages);
    } catch {}
    return c.json({
      token,
      title: conv.title,
      messages,
      createdAt: share.createdAt,
      conversationCreatedAt: conv.createdAt,
    });
  }

  async function create(c: Context) {
    const tenantId = getTenantId(c.req.raw);
    const id = c.req.param("id");
    if (!id) return c.json({ error: { message: "id required", type: "bad_request" } }, 400);
    const where = tenantId
      ? and(eq(conversations.id, id), eq(conversations.tenantId, tenantId))
      : eq(conversations.id, id);
    const conv = await db.select().from(conversations).where(where).get();
    if (!conv) {
      return c.json({ error: { message: "Conversation not found", type: "not_found" } }, 404);
    }

    const existing = await db
      .select()
      .from(shares)
      .where(and(eq(shares.conversationId, id), isNull(shares.revokedAt)))
      .get();
    if (existing) {
      return c.json({ token: existing.token, createdAt: existing.createdAt });
    }

    const token = `sh_${nanoid(32)}`;
    const createdAt = new Date();
    await db
      .insert(shares)
      .values({ token, conversationId: id, tenantId: tenantId || null, createdAt })
      .run();
    return c.json({ token, createdAt }, 201);
  }

  async function revoke(c: Context) {
    const tenantId = getTenantId(c.req.raw);
    const token = c.req.param("token");
    if (!token) return c.json({ error: { message: "token required", type: "bad_request" } }, 400);
    const where = tenantId
      ? and(eq(shares.token, token), eq(shares.tenantId, tenantId))
      : eq(shares.token, token);
    await db.update(shares).set({ revokedAt: new Date() }).where(where).run();
    return c.json({ revoked: true });
  }

  return { getPublic, create, revoke };
}
