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
  /** Pre-compiled regex from `pattern`, attached once by `loadRules` so
   *  `checkContent` avoids recompiling per request. Null when the pattern
   *  is missing or invalid. */
  compiledPattern?: RegExp | null;
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

export type GuardrailScanSource =
  | "user_input"
  | "retrieved_context"
  | "tool_output"
  | "model_output";

export type GuardrailScanDecision =
  | "allow"
  | "flag"
  | "redact"
  | "block"
  | "quarantine";

export interface GuardrailScanResult {
  source: GuardrailScanSource;
  target: "input" | "output";
  decision: GuardrailScanDecision;
  passed: boolean;
  content: string;
  violations: GuardrailResult["violations"];
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

// Load active rules for a tenant. Regex patterns are compiled here rather
// than inside checkContent's hot loop — one compilation per rule per load
// instead of once per rule per request. Invalid patterns are logged
// loudly (not silent skip) so operators can find and fix them.
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

  const rules: GuardrailRule[] = [];
  for (const row of rows) {
    const rule = row as GuardrailRule;
    if (rule.pattern) {
      try {
        rule.compiledPattern = new RegExp(rule.pattern, "gi");
      } catch (err) {
        console.warn(
          `[guardrails] rule "${rule.name}" (id=${rule.id}) has an invalid regex and was skipped: ${err instanceof Error ? err.message : err}`,
        );
        rule.compiledPattern = null;
      }
    } else {
      rule.compiledPattern = null;
    }
    rules.push(rule);
  }
  return rules;
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
    const regex = rule.compiledPattern;
    if (!regex) continue;

    // Reset lastIndex: global regexes retain state across .match / .replace
    // calls, which can cause spurious misses on reuse.
    regex.lastIndex = 0;
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
        regex.lastIndex = 0;
        processedContent = processedContent.replace(regex, "[REDACTED]");
      }
      // "flag" action: just log, don't modify content
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

export function targetForScanSource(source: GuardrailScanSource): "input" | "output" {
  return source === "model_output" ? "output" : "input";
}

export function decisionForScan(
  result: GuardrailResult,
  source: GuardrailScanSource,
): GuardrailScanDecision {
  if (result.action === "pass") return "allow";
  if (result.action === "block" && (source === "retrieved_context" || source === "tool_output")) {
    return "quarantine";
  }
  return result.action;
}

export function scanContent(
  content: string,
  rules: GuardrailRule[],
  source: GuardrailScanSource,
): GuardrailScanResult {
  const target = targetForScanSource(source);
  const result = checkContent(content, rules, target);
  const decision = decisionForScan(result, source);
  return {
    source,
    target,
    decision,
    passed: decision !== "block" && decision !== "quarantine",
    content: source === "retrieved_context" || source === "tool_output"
      ? content
      : result.content,
    violations: result.violations,
  };
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
