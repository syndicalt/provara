import { Hono } from "hono";
import type { Db } from "@provara/db";
import { getAuthUser } from "../auth/admin.js";
import { getTenantId } from "../auth/tenant.js";
import { getTenantIsolationPolicy } from "../routing/adaptive/isolation-policy.js";
import {
  getIsolationPreferences,
  updateIsolationPreferences,
} from "../routing/adaptive/isolation-preferences.js";

/**
 * Routes for per-tenant adaptive isolation toggles (#197, C4 of #176).
 *
 * GET returns the live policy + raw toggle state + tier-derived capability
 * so the dashboard can render the right combination of controls without
 * re-implementing tier rules client-side.
 *
 * PATCH is gated on tier: only Team and Enterprise can change toggles
 * (Free/Pro have no tenant row; toggles would be meaningless). The
 * underlying `updateIsolationPreferences` also refuses — double gate.
 */
export function createRoutingIsolationRoutes(db: Db) {
  const app = new Hono();

  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json(
        { error: { message: "Authentication required.", type: "auth_error" } },
        401,
      );
    }

    const policy = await getTenantIsolationPolicy(db, tenantId);
    const prefs = await getIsolationPreferences(db, tenantId);
    const canToggle = policy.tier === "team" || policy.tier === "enterprise";

    return c.json({
      tier: policy.tier,
      canToggle,
      policy: {
        readsPool: policy.readsPool,
        writesPool: policy.writesPool,
        readsTenantRow: policy.readsTenantRow,
        writesTenantRow: policy.writesTenantRow,
      },
      preferences: prefs,
    });
  });

  app.patch("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    if (!tenantId) {
      return c.json(
        { error: { message: "Authentication required.", type: "auth_error" } },
        401,
      );
    }

    const policy = await getTenantIsolationPolicy(db, tenantId);
    if (policy.tier !== "team" && policy.tier !== "enterprise") {
      return c.json(
        {
          error: {
            message: "Adaptive isolation toggles are available on Team and Enterprise plans.",
            type: "insufficient_tier",
          },
          tier: policy.tier,
          upgradeUrl: "https://provara.xyz/pricing",
        },
        403,
      );
    }

    let body: { consumesPool?: boolean; contributesPool?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { message: "Invalid JSON body.", type: "validation_error" } },
        400,
      );
    }

    const next: { consumesPool?: boolean; contributesPool?: boolean } = {};
    if (typeof body.consumesPool === "boolean") next.consumesPool = body.consumesPool;
    if (typeof body.contributesPool === "boolean") next.contributesPool = body.contributesPool;
    if (Object.keys(next).length === 0) {
      return c.json(
        {
          error: {
            message: "At least one of consumesPool or contributesPool must be provided.",
            type: "validation_error",
          },
        },
        400,
      );
    }

    const user = getAuthUser(c.req.raw);
    const changedBy = user?.id ?? "unknown";

    const merged = await updateIsolationPreferences(db, tenantId, next, changedBy);
    return c.json({
      tier: policy.tier,
      canToggle: true,
      preferences: merged,
    });
  });

  return app;
}
