import { Hono } from "hono";
import type { Db } from "@provara/db";
import { apiTokens, costLogs, requests } from "@provara/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateToken, hashToken, maskToken } from "../auth/tokens.js";

export function createTokenRoutes(db: Db) {
  const app = new Hono();

  // List all tokens (masked)
  app.get("/", (c) => {
    const tokens = db.select().from(apiTokens).all();
    return c.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        tenant: t.tenant,
        tokenPrefix: t.tokenPrefix,
        rateLimit: t.rateLimit,
        spendLimit: t.spendLimit,
        spendPeriod: t.spendPeriod,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
      })),
    });
  });

  // Get token detail with usage stats
  app.get("/:id", (c) => {
    const { id } = c.req.param();
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();

    if (!token) {
      return c.json({ error: { message: "Token not found", type: "not_found" } }, 404);
    }

    // Get usage stats for this tenant
    const totalCost = db
      .select({ total: sql<number>`coalesce(sum(${costLogs.cost}), 0)` })
      .from(costLogs)
      .where(eq(costLogs.tenantId, token.tenant))
      .get();

    const totalRequests = db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(eq(requests.tenantId, token.tenant))
      .get();

    const avgLatency = db
      .select({ avg: sql<number>`avg(${requests.latencyMs})` })
      .from(requests)
      .where(eq(requests.tenantId, token.tenant))
      .get();

    // Current period spend
    const periodStart = getPeriodStart(token.spendPeriod || "monthly");
    const periodCost = db
      .select({ total: sql<number>`coalesce(sum(${costLogs.cost}), 0)` })
      .from(costLogs)
      .where(
        and(
          eq(costLogs.tenantId, token.tenant),
          gte(costLogs.createdAt, periodStart)
        )
      )
      .get();

    return c.json({
      token: {
        id: token.id,
        name: token.name,
        tenant: token.tenant,
        tokenPrefix: token.tokenPrefix,
        rateLimit: token.rateLimit,
        spendLimit: token.spendLimit,
        spendPeriod: token.spendPeriod,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
      },
      usage: {
        totalCost: totalCost?.total || 0,
        totalRequests: totalRequests?.count || 0,
        avgLatency: avgLatency?.avg || 0,
        currentPeriodCost: periodCost?.total || 0,
        currentPeriod: token.spendPeriod || "monthly",
      },
    });
  });

  // Create a new token
  app.post("/", async (c) => {
    const body = await c.req.json<{
      name: string;
      tenant: string;
      rateLimit?: number;
      spendLimit?: number;
      spendPeriod?: "monthly" | "weekly" | "daily";
      expiresAt?: string;
    }>();

    if (!body.name || !body.tenant) {
      return c.json(
        { error: { message: "name and tenant are required", type: "validation_error" } },
        400
      );
    }

    const plainToken = generateToken();
    const hashed = hashToken(plainToken);
    const id = nanoid();

    db.insert(apiTokens)
      .values({
        id,
        name: body.name,
        tenant: body.tenant,
        hashedToken: hashed,
        tokenPrefix: plainToken.slice(0, 9), // "pvra_" + first 4 random chars
        rateLimit: body.rateLimit || null,
        spendLimit: body.spendLimit || null,
        spendPeriod: body.spendPeriod || "monthly",
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .run();

    // Return the full token — this is the ONLY time it's shown
    return c.json(
      {
        token: {
          id,
          name: body.name,
          tenant: body.tenant,
          tokenPrefix: plainToken.slice(0, 9),
          rateLimit: body.rateLimit || null,
          spendLimit: body.spendLimit || null,
          spendPeriod: body.spendPeriod || "monthly",
          expiresAt: body.expiresAt || null,
          createdAt: new Date().toISOString(),
        },
        // The full plaintext token — shown once, never again
        plainToken,
      },
      201
    );
  });

  // Update a token
  app.patch("/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{
      name?: string;
      rateLimit?: number | null;
      spendLimit?: number | null;
      spendPeriod?: "monthly" | "weekly" | "daily";
      expiresAt?: string | null;
    }>();

    const token = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    if (!token) {
      return c.json({ error: { message: "Token not found", type: "not_found" } }, 404);
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.rateLimit !== undefined) updates.rateLimit = body.rateLimit;
    if (body.spendLimit !== undefined) updates.spendLimit = body.spendLimit;
    if (body.spendPeriod !== undefined) updates.spendPeriod = body.spendPeriod;
    if (body.expiresAt !== undefined) {
      updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    }

    if (Object.keys(updates).length > 0) {
      db.update(apiTokens).set(updates).where(eq(apiTokens.id, id)).run();
    }

    const updated = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    return c.json({ token: updated });
  });

  // Delete (revoke) a token
  app.delete("/:id", (c) => {
    const { id } = c.req.param();
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();

    if (!token) {
      return c.json({ error: { message: "Token not found", type: "not_found" } }, 404);
    }

    db.delete(apiTokens).where(eq(apiTokens.id, id)).run();
    return c.json({ deleted: true });
  });

  // Per-tenant usage summary
  app.get("/usage/by-tenant", (c) => {
    const rows = db
      .select({
        tenant: costLogs.tenantId,
        totalCost: sql<number>`coalesce(sum(${costLogs.cost}), 0)`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costLogs)
      .groupBy(costLogs.tenantId)
      .all();

    return c.json({ tenants: rows });
  });

  return app;
}

function getPeriodStart(period: string): Date {
  const now = new Date();
  switch (period) {
    case "daily":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "weekly": {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      return new Date(now.getFullYear(), now.getMonth(), diff);
    }
    case "monthly":
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1);
  }
}
