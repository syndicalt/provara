import type { Db } from "@provara/db";
import { guardrailRules, guardrailLogs } from "@provara/db";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { BUILTIN_RULES } from "./patterns.js";

export interface GuardrailRule {
  id: string;
  name: string;
  type: string;
  target: "input" | "output" | "both";
  action: "block" | "redact" | "flag";
  pattern: string | null;
  enabled: boolean;
  builtIn: boolean;
}

export interface GuardrailResult {
  passed: boolean;
  action: "block" | "redact" | "flag" | "pass";
  content: string; // original or redacted content
  violations: {
    ruleId: string;
    ruleName: string;
    action: string;
    matchedSnippet: string;
  }[];
}

// Initialize built-in rules if they don't exist
export async function ensureBuiltInRules(db: Db, tenantId: string | null) {
  for (const rule of BUILTIN_RULES) {
    const existing = await db
      .select()
      .from(guardrailRules)
      .where(
        and(
          eq(guardrailRules.name, rule.name),
          eq(guardrailRules.builtIn, true),
          tenantId ? eq(guardrailRules.tenantId, tenantId) : undefined
        )
      )
      .get();

    if (!existing) {
      await db.insert(guardrailRules).values({
        id: nanoid(),
        tenantId,
        name: rule.name,
        type: rule.type,
        target: rule.target,
        action: rule.action,
        pattern: rule.pattern,
        enabled: false, // Disabled by default — user opts in
        builtIn: true,
      }).run();
    }
  }
}

// Load active rules for a tenant
export async function loadRules(db: Db, tenantId: string | null): Promise<GuardrailRule[]> {
  const rows = await db
    .select()
    .from(guardrailRules)
    .where(
      and(
        eq(guardrailRules.enabled, true),
        tenantId ? eq(guardrailRules.tenantId, tenantId) : undefined
      )
    )
    .all();

  return rows as GuardrailRule[];
}

// Check content against rules
export function checkContent(
  content: string,
  rules: GuardrailRule[],
  target: "input" | "output"
): GuardrailResult {
  const violations: GuardrailResult["violations"] = [];
  let processedContent = content;
  let shouldBlock = false;

  for (const rule of rules) {
    // Skip rules that don't apply to this target
    if (rule.target !== "both" && rule.target !== target) continue;
    if (!rule.pattern) continue;

    try {
      const regex = new RegExp(rule.pattern, "gi");
      const matches = content.match(regex);

      if (matches && matches.length > 0) {
        const snippet = matches[0].slice(0, 50);

        violations.push({
          ruleId: rule.id,
          ruleName: rule.name,
          action: rule.action,
          matchedSnippet: snippet,
        });

        if (rule.action === "block") {
          shouldBlock = true;
        } else if (rule.action === "redact") {
          processedContent = processedContent.replace(regex, "[REDACTED]");
        }
        // "flag" action: just log, don't modify content
      }
    } catch {
      // Invalid regex — skip this rule
    }
  }

  if (shouldBlock) {
    return {
      passed: false,
      action: "block",
      content,
      violations,
    };
  }

  if (violations.length > 0) {
    const hasRedact = violations.some((v) => v.action === "redact");
    return {
      passed: true,
      action: hasRedact ? "redact" : "flag",
      content: processedContent,
      violations,
    };
  }

  return { passed: true, action: "pass", content, violations: [] };
}

// Log guardrail violations
export async function logViolations(
  db: Db,
  requestId: string | null,
  tenantId: string | null,
  target: "input" | "output",
  violations: GuardrailResult["violations"]
) {
  for (const v of violations) {
    await db.insert(guardrailLogs).values({
      id: nanoid(),
      requestId,
      tenantId,
      ruleId: v.ruleId,
      ruleName: v.ruleName,
      target,
      action: v.action as "block" | "redact" | "flag",
      matchedContent: v.matchedSnippet,
    }).run();
  }
}
