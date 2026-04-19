import { Hono } from "hono";
import type { Db } from "@provara/db";
import { apiTokens, costLogs, requests } from "@provara/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateToken, hashToken, maskToken } from "../auth/tokens.js";
import { getTenantId, tenantFilter } from "../auth/tenant.js";
import { getAuthUser, getAuthRole } from "../auth/admin.js";
import { invalidateAuthCache } from "./../auth/middleware.js";

export function createTokenRoutes(db: Db) {
  const app = new Hono();

  /**
   * Token-ownership scope (#247). Owners and Admins see every token on
   * the tenant. Developers only see and mutate tokens they created; the
   * filter combines with the tenant filter via AND in the caller.
   * Historical tokens with `createdByUserId = NULL` are treated as
   * unowned — invisible to Developers, visible to Owners/Admins so they
   * can reassign or revoke.
   */
  function ownershipFilter(req: Request) {
    const role = getAuthRole(req);
    const user = getAuthUser(req);
    if (role === "developer" && user) {
      return eq(apiTokens.createdByUserId, user.id);
    }
    return undefined;
  }

  function combine(...clauses: Array<ReturnType<typeof eq> | undefined>) {
    const filtered = clauses.filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (filtered.length === 0) return undefined;
    if (filtered.length === 1) return filtered[0];
    return and(...filtered);
  }

  // List all tokens (masked)
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const where = combine(tenantFilter(apiTokens.tenant, tenantId), ownershipFilter(c.req.raw));
    const tokens = await db.select().from(apiTokens).where(where).all();
    return c.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        tenant: t.tenant,
        tokenPrefix: t.tokenPrefix,
        rateLimit: t.rateLimit,
        spendLimit: t.spendLimit,
        spendPeriod: t.spendPeriod,
        routingProfile: t.routingProfile,
        enabled: t.enabled,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt,
      })),
    });
  });

  // Get token detail with usage stats
  app.get("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const tokenWhere = combine(
      eq(apiTokens.id, id),
      tenantFilter(apiTokens.tenant, tenantId),
      ownershipFilter(c.req.raw),
    );
    const token = await db.select().from(apiTokens).where(tokenWhere).get();

    if (!token) {
      return c.json({ error: { message: "Token not found", type: "not_found" } }, 404);
    }

    // Get usage stats for this tenant
    const totalCost = await db
      .select({ total: sql<number>`coalesce(sum(${costLogs.cost}), 0)` })
      .from(costLogs)
      .where(eq(costLogs.tenantId, token.tenant))
      .get();

    const totalRequests = await db
      .select({ count: sql<number>`count(*)` })
      .from(requests)
      .where(eq(requests.tenantId, token.tenant))
      .get();

    const avgLatency = await db
      .select({ avg: sql<number>`avg(${requests.latencyMs})` })
      .from(requests)
      .where(eq(requests.tenantId, token.tenant))
      .get();

    // Current period spend
    const periodStart = getPeriodStart(token.spendPeriod || "monthly");
    const periodCost = await db
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
        routingProfile: token.routingProfile,
        enabled: token.enabled,
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
      rateLimit?: number;
      spendLimit?: number;
      spendPeriod?: "monthly" | "weekly" | "daily";
      routingProfile?: "cost" | "balanced" | "quality" | "custom";
      routingWeights?: { quality: number; cost: number; latency: number };
      expiresAt?: string;
    }>();

    if (!body.name) {
      return c.json(
        { error: { message: "name is required", type: "validation_error" } },
        400
      );
    }

    // Use the authenticated user's tenant ID, fall back to body.tenant for self_hosted mode
    const authUser = getAuthUser(c.req.raw);
    const tenant = authUser?.tenantId || getTenantId(c.req.raw) || "default";

    const plainToken = generateToken();
    const hashed = hashToken(plainToken);
    const id = nanoid();

    await db.insert(apiTokens)
      .values({
        id,
        name: body.name,
        tenant,
        hashedToken: hashed,
        tokenPrefix: plainToken.slice(0, 9),
        rateLimit: body.rateLimit || null,
        spendLimit: body.spendLimit || null,
        spendPeriod: body.spendPeriod || "monthly",
        routingProfile: body.routingProfile || "balanced",
        routingWeights: body.routingWeights ? JSON.stringify(body.routingWeights) : null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        createdByUserId: authUser?.id || null,
      })
      .run();
    invalidateAuthCache();

    // Return the full token — this is the ONLY time it's shown
    return c.json(
      {
        token: {
          id,
          name: body.name,
          tenant,
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
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{
      name?: string;
      rateLimit?: number | null;
      spendLimit?: number | null;
      spendPeriod?: "monthly" | "weekly" | "daily";
      enabled?: boolean;
      expiresAt?: string | null;
    }>();

    const tokenWhere = combine(
      eq(apiTokens.id, id),
      tenantFilter(apiTokens.tenant, tenantId),
      ownershipFilter(c.req.raw),
    );
    const token = await db.select().from(apiTokens).where(tokenWhere).get();
    if (!token) {
      return c.json({ error: { message: "Token not found", type: "not_found" } }, 404);
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.rateLimit !== undefined) updates.rateLimit = body.rateLimit;
    if (body.spendLimit !== undefined) updates.spendLimit = body.spendLimit;
    if (body.spendPeriod !== undefined) updates.spendPeriod = body.spendPeriod;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.expiresAt !== undefined) {
      updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    }

    if (Object.keys(updates).length > 0) {
      await db.update(apiTokens).set(updates).where(tokenWhere).run();
      // Toggling `enabled` changes what the auth cache should answer;
      // any other update is benign but invalidating across the board
      // is cheap and avoids a stale-state bug if we add new mutable
      // fields later.
      invalidateAuthCache();
    }

    const updated = await db.select().from(apiTokens).where(tokenWhere).get();
    return c.json({ token: updated });
  });

  // Delete (revoke) a token
  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const tokenWhere = combine(
      eq(apiTokens.id, id),
      tenantFilter(apiTokens.tenant, tenantId),
      ownershipFilter(c.req.raw),
    );
    const token = await db.select().from(apiTokens).where(tokenWhere).get();

    if (!token) {
      return c.json({ error: { message: "Token not found", type: "not_found" } }, 404);
    }

    await db.delete(apiTokens).where(tokenWhere).run();
    invalidateAuthCache();
    return c.json({ deleted: true });
  });

  // Per-tenant usage summary
  app.get("/usage/by-tenant", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rows = await db
      .select({
        tenant: costLogs.tenantId,
        totalCost: sql<number>`coalesce(sum(${costLogs.cost}), 0)`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costLogs)
      .where(tenantFilter(costLogs.tenantId, tenantId))
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
