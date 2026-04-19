import { Hono } from "hono";
import type { Db } from "@provara/db";
import { promptRollouts, promptTemplates, promptVersions } from "@provara/db";
import { and, eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId, tenantFilter } from "../auth/tenant.js";
import {
  resolveVersion,
  evaluateRollout,
  applyDecision,
  type RolloutCriteria,
} from "../prompts/rollouts.js";

/**
 * Prompt canary rollout routes (#264). Mounted at /v1/rollouts. The
 * weighted-pick resolve endpoint lives here (not /v1/prompts/:id) to avoid
 * colliding with the existing prompts sub-app route shape.
 */
export function createRolloutRoutes(db: Db) {
  const app = new Hono();

  // Start a canary rollout. Body: { templateId, canaryVersionId, rolloutPct, criteria }.
  // Rejects if an active rollout already exists for the template.
  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      templateId?: string;
      canaryVersionId?: string;
      rolloutPct?: number;
      criteria?: Partial<RolloutCriteria>;
    }>();

    if (!body.templateId || !body.canaryVersionId) {
      return c.json(
        { error: { message: "`templateId` and `canaryVersionId` are required", type: "validation_error" } },
        400,
      );
    }

    const tc = tenantFilter(promptTemplates.tenantId, tenantId);
    const template = await db
      .select()
      .from(promptTemplates)
      .where(tc ? and(eq(promptTemplates.id, body.templateId), tc) : eq(promptTemplates.id, body.templateId))
      .get();
    if (!template) {
      return c.json({ error: { message: "Template not found", type: "not_found" } }, 404);
    }
    if (!template.publishedVersionId) {
      return c.json(
        {
          error: {
            message: "Template has no published version to use as the stable baseline",
            type: "validation_error",
          },
        },
        400,
      );
    }

    const canary = await db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.id, body.canaryVersionId), eq(promptVersions.templateId, body.templateId)))
      .get();
    if (!canary) {
      return c.json(
        { error: { message: "Canary version not found for this template", type: "not_found" } },
        404,
      );
    }
    if (canary.id === template.publishedVersionId) {
      return c.json(
        { error: { message: "Canary must differ from the currently published version", type: "validation_error" } },
        400,
      );
    }

    const pct = body.rolloutPct;
    if (typeof pct !== "number" || pct <= 0 || pct >= 100 || !Number.isFinite(pct)) {
      return c.json(
        { error: { message: "`rolloutPct` must be between 1 and 99", type: "validation_error" } },
        400,
      );
    }
    const c0 = body.criteria || {};
    const criteria: RolloutCriteria = {
      min_samples:
        Number.isFinite(c0.min_samples) && (c0.min_samples as number) >= 1
          ? (c0.min_samples as number)
          : 20,
      max_avg_score_delta:
        Number.isFinite(c0.max_avg_score_delta) && (c0.max_avg_score_delta as number) >= 0
          ? (c0.max_avg_score_delta as number)
          : 0.3,
      window_hours:
        Number.isFinite(c0.window_hours) && (c0.window_hours as number) >= 1
          ? (c0.window_hours as number)
          : 24,
    };

    const existing = await db
      .select()
      .from(promptRollouts)
      .where(
        and(eq(promptRollouts.templateId, body.templateId), eq(promptRollouts.status, "active")),
      )
      .get();
    if (existing) {
      return c.json(
        {
          error: {
            message: "An active rollout already exists for this template. Promote or revert it first.",
            type: "conflict",
            rolloutId: existing.id,
          },
        },
        409,
      );
    }

    const id = nanoid();
    await db
      .insert(promptRollouts)
      .values({
        id,
        tenantId,
        templateId: body.templateId,
        canaryVersionId: body.canaryVersionId,
        stableVersionId: template.publishedVersionId,
        rolloutPct: Math.round(pct),
        criteria,
      })
      .run();

    return c.json({ id, status: "active", rolloutPct: Math.round(pct), criteria }, 201);
  });

  // List rollouts; optional ?templateId= filter.
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const templateId = c.req.query("templateId");
    const tc = tenantFilter(promptRollouts.tenantId, tenantId);
    const conditions = [
      tc,
      templateId ? eq(promptRollouts.templateId, templateId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await db
      .select()
      .from(promptRollouts)
      .where(where)
      .orderBy(desc(promptRollouts.startedAt))
      .all();
    return c.json({ rollouts: rows });
  });

  // Client-facing: resolve a template to its current serving version.
  // Returns { versionId, messages, rolloutId?, variant? }. Callers then pass
  // `versionId` as `prompt_version_id` when POSTing /v1/chat/completions
  // so the rollout eval loop sees per-version feedback.
  app.post("/resolve/:templateId", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { templateId } = c.req.param();
    const resolved = await resolveVersion(db, templateId, tenantId);
    if (!resolved) {
      return c.json(
        {
          error: {
            message: "Template has no resolvable version (no rollout, no published version, or not found)",
            type: "not_found",
          },
        },
        404,
      );
    }
    return c.json(resolved);
  });

  // Manual promote / revert — bypasses criteria evaluation when operators
  // have seen enough qualitative signal and want to ship or pull the canary
  // without waiting for the scheduler.
  app.post("/:id/promote", async (c) => {
    const { id } = c.req.param();
    const rollout = await db.select().from(promptRollouts).where(eq(promptRollouts.id, id)).get();
    if (!rollout || rollout.status !== "active") {
      return c.json({ error: { message: "Rollout not active", type: "not_found" } }, 404);
    }
    await applyDecision(db, id, {
      outcome: "promote",
      reason: "manual-promote",
      stats: {
        canarySamples: 0,
        stableSamples: 0,
        canaryAvgScore: null,
        stableAvgScore: null,
      },
    });
    return c.json({ ok: true });
  });

  app.post("/:id/revert", async (c) => {
    const { id } = c.req.param();
    const rollout = await db.select().from(promptRollouts).where(eq(promptRollouts.id, id)).get();
    if (!rollout || rollout.status !== "active") {
      return c.json({ error: { message: "Rollout not active", type: "not_found" } }, 404);
    }
    await applyDecision(db, id, {
      outcome: "revert",
      reason: "manual-revert",
      stats: {
        canarySamples: 0,
        stableSamples: 0,
        canaryAvgScore: null,
        stableAvgScore: null,
      },
    });
    return c.json({ ok: true });
  });

  // Preview: what would the scheduler decide right now? Used by the UI
  // "Current signal" panel.
  app.get("/:id/evaluation", async (c) => {
    const { id } = c.req.param();
    const rollout = await db.select().from(promptRollouts).where(eq(promptRollouts.id, id)).get();
    if (!rollout) {
      return c.json({ error: { message: "Rollout not found", type: "not_found" } }, 404);
    }
    if (rollout.status !== "active") {
      return c.json({
        outcome: "continue",
        reason: `rollout is ${rollout.status}`,
        stats: {
          canarySamples: 0,
          stableSamples: 0,
          canaryAvgScore: null,
          stableAvgScore: null,
        },
      });
    }
    const decision = await evaluateRollout(db, id);
    return c.json(decision);
  });

  return app;
}
