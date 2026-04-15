import { Hono } from "hono";
import type { Db } from "@provara/db";
import { guardrailRules, guardrailLogs } from "@provara/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId } from "../auth/tenant.js";
import { ensureBuiltInRules } from "../guardrails/engine.js";

export function createGuardrailRoutes(db: Db) {
  const app = new Hono();

  // List all rules (ensures built-in rules exist)
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    await ensureBuiltInRules(db, tenantId);

    const rules = await db
      .select()
      .from(guardrailRules)
      .where(tenantId ? eq(guardrailRules.tenantId, tenantId) : undefined)
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

  // Toggle a rule on/off
  app.patch("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{ enabled?: boolean; action?: string }>();

    const rule = await db.select().from(guardrailRules).where(
      tenantId ? and(eq(guardrailRules.id, id), eq(guardrailRules.tenantId, tenantId)) : eq(guardrailRules.id, id)
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

    const rule = await db.select().from(guardrailRules).where(
      tenantId ? and(eq(guardrailRules.id, id), eq(guardrailRules.tenantId, tenantId)) : eq(guardrailRules.id, id)
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
      .where(tenantId ? eq(guardrailLogs.tenantId, tenantId) : undefined)
      .orderBy(desc(guardrailLogs.createdAt))
      .limit(limit)
      .all();

    return c.json({ logs });
  });

  return app;
}
