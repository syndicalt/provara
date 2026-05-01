import { Hono } from "hono";
import type { Db } from "@provara/db";
import { guardrailRules, guardrailLogs } from "@provara/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId, tenantFilter } from "../auth/tenant.js";
import {
  ensureBuiltInRules,
  loadRules,
  scanContent,
  type GuardrailScanSource,
} from "../guardrails/engine.js";
import { PROMPT_INJECTION_FIREWALL_TYPE } from "../guardrails/patterns.js";

const SCAN_SOURCES = new Set<GuardrailScanSource>([
  "user_input",
  "retrieved_context",
  "tool_output",
  "model_output",
]);

export function createGuardrailRoutes(db: Db) {
  const app = new Hono();

  // List all rules (ensures built-in rules exist)
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    await ensureBuiltInRules(db, tenantId);

    const rules = await db
      .select()
      .from(guardrailRules)
      .where(tenantFilter(guardrailRules.tenantId, tenantId))
      .all();

    return c.json({ rules });
  });

  // Create a custom rule
  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      name: string;
      type: "pii" | "content" | "regex" | "token_limit";
      target?: "input" | "output" | "both";
      action?: "block" | "redact" | "flag";
      pattern: string;
    }>();

    if (!body.name || !body.pattern) {
      return c.json({ error: { message: "name and pattern are required", type: "validation_error" } }, 400);
    }

    // Validate regex
    try {
      new RegExp(body.pattern);
    } catch {
      return c.json({ error: { message: "Invalid regex pattern", type: "validation_error" } }, 400);
    }

    const id = nanoid();
    await db.insert(guardrailRules).values({
      id,
      tenantId,
      name: body.name,
      type: body.type || "regex",
      target: body.target || "both",
      action: body.action || "block",
      pattern: body.pattern,
      enabled: true,
      builtIn: false,
    }).run();

    const rule = await db.select().from(guardrailRules).where(eq(guardrailRules.id, id)).get();
    return c.json({ rule }, 201);
  });

  // Scan arbitrary context without mutating it. This is the first API surface
  // for prompt-injection firewalling outside the chat request path: callers
  // can check RAG chunks or tool output before adding them to model context.
  app.post("/scan", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      content?: unknown;
      source?: unknown;
    }>();

    if (typeof body.content !== "string" || body.content.length === 0) {
      return c.json(
        { error: { message: "content is required", type: "validation_error" } },
        400,
      );
    }
    if (typeof body.source !== "string" || !SCAN_SOURCES.has(body.source as GuardrailScanSource)) {
      return c.json(
        {
          error: {
            message: "source must be one of: user_input, retrieved_context, tool_output, model_output",
            type: "validation_error",
          },
        },
        400,
      );
    }

    await ensureBuiltInRules(db, tenantId);
    const rules = await loadRules(db, tenantId);
    const scan = scanContent(body.content, rules, body.source as GuardrailScanSource);

    return c.json({ scan });
  });

  // Configure the built-in Prompt Injection Firewall preset in one action.
  app.patch("/presets/prompt-injection-firewall", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{ enabled?: boolean; action?: "block" | "redact" | "flag" }>();
    const validActions = new Set(["block", "redact", "flag"]);

    if (body.enabled === undefined && body.action === undefined) {
      return c.json(
        { error: { message: "enabled or action is required", type: "validation_error" } },
        400,
      );
    }
    if (body.action !== undefined && !validActions.has(body.action)) {
      return c.json(
        { error: { message: "Invalid action", type: "validation_error" } },
        400,
      );
    }

    await ensureBuiltInRules(db, tenantId);

    const updates: Record<string, unknown> = {};
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.action !== undefined) updates.action = body.action;

    const tenantClause = tenantFilter(guardrailRules.tenantId, tenantId);
    const whereClause = tenantClause
      ? and(
          eq(guardrailRules.type, PROMPT_INJECTION_FIREWALL_TYPE),
          eq(guardrailRules.builtIn, true),
          tenantClause,
        )
      : and(
          eq(guardrailRules.type, PROMPT_INJECTION_FIREWALL_TYPE),
          eq(guardrailRules.builtIn, true),
        );

    await db.update(guardrailRules).set(updates).where(whereClause).run();

    const rules = await db
      .select()
      .from(guardrailRules)
      .where(whereClause)
      .all();

    const enabledCount = rules.filter((rule) => rule.enabled).length;
    return c.json({
      preset: {
        id: "prompt-injection-firewall",
        name: "Prompt Injection Firewall",
        totalRules: rules.length,
        enabledRules: enabledCount,
        action: body.action,
      },
      rules,
    });
  });

  // Toggle a rule on/off
  app.patch("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{ enabled?: boolean; action?: string }>();

    const tenantClausePatch = tenantFilter(guardrailRules.tenantId, tenantId);
    const rule = await db.select().from(guardrailRules).where(
      tenantClausePatch ? and(eq(guardrailRules.id, id), tenantClausePatch) : eq(guardrailRules.id, id)
    ).get();

    if (!rule) {
      return c.json({ error: { message: "Rule not found", type: "not_found" } }, 404);
    }

    const updates: Record<string, unknown> = {};
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.action) updates.action = body.action;

    await db.update(guardrailRules).set(updates).where(eq(guardrailRules.id, id)).run();

    const updated = await db.select().from(guardrailRules).where(eq(guardrailRules.id, id)).get();
    return c.json({ rule: updated });
  });

  // Delete a custom rule (can't delete built-in)
  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();

    const tenantClauseDelete = tenantFilter(guardrailRules.tenantId, tenantId);
    const rule = await db.select().from(guardrailRules).where(
      tenantClauseDelete ? and(eq(guardrailRules.id, id), tenantClauseDelete) : eq(guardrailRules.id, id)
    ).get();

    if (!rule) {
      return c.json({ error: { message: "Rule not found", type: "not_found" } }, 404);
    }

    if (rule.builtIn) {
      return c.json({ error: { message: "Cannot delete built-in rules. Disable them instead.", type: "validation_error" } }, 400);
    }

    await db.delete(guardrailRules).where(eq(guardrailRules.id, id)).run();
    return c.json({ deleted: true });
  });

  // View recent guardrail logs
  app.get("/logs", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);

    const logs = await db
      .select()
      .from(guardrailLogs)
      .where(tenantFilter(guardrailLogs.tenantId, tenantId))
      .orderBy(desc(guardrailLogs.createdAt))
      .limit(limit)
      .all();

    return c.json({ logs });
  });

  return app;
}
