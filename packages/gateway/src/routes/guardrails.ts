import { Hono } from "hono";
import type { Db } from "@provara/db";
import { firewallEvents, guardrailRules, guardrailLogs } from "@provara/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId, tenantFilter } from "../auth/tenant.js";
import { tenantHasIntelligenceAccess } from "../auth/tier.js";
import type { ProviderRegistry } from "../providers/index.js";
import {
  FIREWALL_SCAN_MODES,
  TOOL_CALL_ALIGNMENT_MODES,
  getFirewallSettings,
  upsertFirewallSettings,
  type FirewallScanMode,
  type ToolCallAlignmentMode,
} from "../guardrails/firewall-settings.js";
import {
  ensureBuiltInRules,
  loadRules,
  scanContent,
  type GuardrailScanSource,
} from "../guardrails/engine.js";
import { recordFirewallEvent } from "../guardrails/firewall-events.js";
import { judgePromptInjection } from "../guardrails/prompt-injection-judge.js";
import { PROMPT_INJECTION_FIREWALL_TYPE } from "../guardrails/patterns.js";

const SCAN_SOURCES = new Set<GuardrailScanSource>([
  "user_input",
  "retrieved_context",
  "tool_output",
  "model_output",
]);

const DECISION_RANK: Record<string, number> = {
  allow: 0,
  flag: 1,
  redact: 2,
  quarantine: 3,
  block: 4,
};

function stricterDecision(a: string, b: string): "allow" | "flag" | "redact" | "quarantine" | "block" {
  return (DECISION_RANK[b] > DECISION_RANK[a] ? b : a) as "allow" | "flag" | "redact" | "quarantine" | "block";
}

function decisionPassed(decision: string): boolean {
  return decision !== "block" && decision !== "quarantine";
}

export function createGuardrailRoutes(db: Db, registry?: ProviderRegistry) {
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
    const settings = await getFirewallSettings(db, tenantId);
    const body = await c.req.json<{
      content?: unknown;
      source?: unknown;
      mode?: unknown;
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
    if (body.mode !== undefined && (typeof body.mode !== "string" || !FIREWALL_SCAN_MODES.has(body.mode as FirewallScanMode))) {
      return c.json(
        { error: { message: "mode must be one of: signature, semantic, hybrid", type: "validation_error" } },
        400,
      );
    }
    const mode = (body.mode as FirewallScanMode | undefined) ?? settings.defaultScanMode;

    await ensureBuiltInRules(db, tenantId);
    const rules = await loadRules(db, tenantId);
    const scan = scanContent(body.content, rules, body.source as GuardrailScanSource);

    const shouldRunSemantic = mode === "semantic" || (mode === "hybrid" && scan.decision !== "allow");
    if (shouldRunSemantic) {
      const hasSemanticAccess = await tenantHasIntelligenceAccess(db, tenantId);
      if (!hasSemanticAccess) {
        return c.json(
          {
            error: {
              message: "Semantic and hybrid prompt-injection scans are available on Pro and higher plans.",
              type: "insufficient_tier",
            },
            gate: {
              reason: "insufficient_tier",
              requiredTier: "pro",
            },
          },
          402,
        );
      }
      if (!registry) {
        return c.json(
          { error: { message: "semantic scan mode is not available in this route context", type: "semantic_unavailable" } },
          400,
        );
      }
      try {
        const semantic = await judgePromptInjection(registry, {
          source: body.source as GuardrailScanSource,
          content: body.content,
        });
        if (!semantic) {
          return c.json(
            { error: { message: "Prompt injection judge did not return a parseable decision", type: "semantic_judge_error" } },
            502,
          );
        }
        const decision = stricterDecision(scan.decision, semantic.recommendedAction);
        await recordFirewallEvent(db, {
          tenantId,
          surface: "scan",
          source: body.source as GuardrailScanSource,
          mode,
          decision,
          action: semantic.recommendedAction,
          passed: decisionPassed(decision),
          confidence: semantic.confidence,
          riskLevel: semantic.riskLevel,
          category: semantic.category,
          ruleName: scan.violations[0]?.ruleName ?? null,
          matchedContent: scan.violations[0]?.matchedSnippet ?? semantic.evidence,
          details: {
            semantic,
            signatureDecision: scan.decision,
            violationCount: scan.violations.length,
          },
        });
        return c.json({
          scan: {
            ...scan,
            mode,
            decision,
            passed: decisionPassed(decision),
            semantic,
          },
        });
      } catch (err) {
        return c.json(
          {
            error: {
              message: err instanceof Error ? err.message : "Prompt injection judge failed",
              type: "semantic_judge_error",
            },
          },
          502,
        );
      }
    }

    await recordFirewallEvent(db, {
      tenantId,
      surface: "scan",
      source: body.source as GuardrailScanSource,
      mode,
      decision: scan.decision,
      action: scan.decision,
      passed: scan.passed,
      ruleName: scan.violations[0]?.ruleName ?? null,
      matchedContent: scan.violations[0]?.matchedSnippet ?? null,
      details: { violationCount: scan.violations.length },
    });
    return c.json({ scan: { ...scan, mode } });
  });

  app.get("/firewall/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;

    const events = await db
      .select()
      .from(firewallEvents)
      .where(tenantFilter(firewallEvents.tenantId, tenantId))
      .orderBy(desc(firewallEvents.createdAt))
      .limit(limit)
      .all();

    return c.json({ events });
  });

  app.get("/firewall/settings", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const settings = await getFirewallSettings(db, tenantId);
    const hasIntelligenceAccess = await tenantHasIntelligenceAccess(db, tenantId);
    return c.json({
      settings,
      capabilities: {
        semanticScan: hasIntelligenceAccess,
        hybridScan: hasIntelligenceAccess,
      },
    });
  });

  app.patch("/firewall/settings", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      defaultScanMode?: unknown;
      toolCallAlignment?: unknown;
      streamingEnforcement?: unknown;
    }>();

    const patch: {
      defaultScanMode?: FirewallScanMode;
      toolCallAlignment?: ToolCallAlignmentMode;
      streamingEnforcement?: boolean;
    } = {};

    if (body.defaultScanMode !== undefined) {
      if (typeof body.defaultScanMode !== "string" || !FIREWALL_SCAN_MODES.has(body.defaultScanMode as FirewallScanMode)) {
        return c.json(
          { error: { message: "defaultScanMode must be one of: signature, semantic, hybrid", type: "validation_error" } },
          400,
        );
      }
      const nextMode = body.defaultScanMode as FirewallScanMode;
      if (nextMode !== "signature" && !(await tenantHasIntelligenceAccess(db, tenantId))) {
        return c.json(
          {
            error: {
              message: "Semantic and hybrid prompt-injection scans are available on Pro and higher plans.",
              type: "insufficient_tier",
            },
            gate: { reason: "insufficient_tier", requiredTier: "pro" },
          },
          402,
        );
      }
      patch.defaultScanMode = nextMode;
    }

    if (body.toolCallAlignment !== undefined) {
      if (typeof body.toolCallAlignment !== "string" || !TOOL_CALL_ALIGNMENT_MODES.has(body.toolCallAlignment as ToolCallAlignmentMode)) {
        return c.json(
          { error: { message: "toolCallAlignment must be one of: off, flag, block", type: "validation_error" } },
          400,
        );
      }
      patch.toolCallAlignment = body.toolCallAlignment as ToolCallAlignmentMode;
    }

    if (body.streamingEnforcement !== undefined) {
      if (typeof body.streamingEnforcement !== "boolean") {
        return c.json(
          { error: { message: "streamingEnforcement must be a boolean", type: "validation_error" } },
          400,
        );
      }
      patch.streamingEnforcement = body.streamingEnforcement;
    }

    const settings = await upsertFirewallSettings(db, tenantId, patch);
    const hasIntelligenceAccess = await tenantHasIntelligenceAccess(db, tenantId);
    return c.json({
      settings,
      capabilities: {
        semanticScan: hasIntelligenceAccess,
        hybridScan: hasIntelligenceAccess,
      },
    });
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
