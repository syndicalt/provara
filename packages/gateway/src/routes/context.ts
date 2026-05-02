import { Hono } from "hono";
import type { Db } from "@provara/db";
import {
  optimizeContextChunks,
  type ContextChunk,
  type ContextOptimizationResult,
  type OptimizedContextChunk,
  type RiskyContextChunk,
} from "../context/optimizer.js";
import {
  listContextOptimizationEvents,
  recordContextOptimizationEvent,
  summarizeContextOptimizationEvents,
} from "../context/events.js";
import {
  evaluateContextQuality,
  listContextQualityEvents,
  summarizeContextQualityEvents,
} from "../context/quality.js";
import {
  listContextRetrievalEvents,
  recordContextRetrievalEvent,
  summarizeContextRetrievalEvents,
} from "../context/retrieval.js";
import { getTenantId } from "../auth/tenant.js";
import { ensureBuiltInRules, loadRules, scanContent } from "../guardrails/engine.js";
import type { ProviderRegistry } from "../providers/index.js";

const MAX_CHUNKS = 200;
const MAX_CHUNK_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateChunks(value: unknown): { chunks?: ContextChunk[]; error?: string } {
  if (!Array.isArray(value)) return { error: "chunks must be an array" };
  if (value.length === 0) return { error: "chunks must contain at least one item" };
  if (value.length > MAX_CHUNKS) return { error: `chunks must contain at most ${MAX_CHUNKS} items` };

  const chunks: ContextChunk[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { error: `chunks[${index}] must be an object` };
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      return { error: `chunks[${index}].id is required` };
    }
    if (typeof item.content !== "string" || item.content.length === 0) {
      return { error: `chunks[${index}].content is required` };
    }
    if (item.content.length > MAX_CHUNK_CHARS) {
      return { error: `chunks[${index}].content exceeds ${MAX_CHUNK_CHARS} characters` };
    }
    if (item.source !== undefined && typeof item.source !== "string") {
      return { error: `chunks[${index}].source must be a string` };
    }
    if (item.metadata !== undefined && !isRecord(item.metadata)) {
      return { error: `chunks[${index}].metadata must be an object` };
    }

    chunks.push({
      id: item.id,
      content: item.content,
      source: typeof item.source === "string" ? item.source : undefined,
      metadata: isRecord(item.metadata) ? item.metadata : undefined,
    });
  }

  return { chunks };
}

function validateScanRisk(value: unknown): { scanRisk?: boolean; error?: string } {
  if (value === undefined) return { scanRisk: false };
  if (typeof value !== "boolean") return { error: "scanRisk must be a boolean" };
  return { scanRisk: value };
}

function validateStringArray(value: unknown, field: string): { values?: string[]; error?: string } {
  if (value === undefined) return { values: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array` };
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { error: `${field}[${index}] must be a non-empty string` };
    }
    values.push(item);
  }
  return { values };
}

function validateQualityBody(value: unknown): {
  input?: {
    prompt: string;
    rawAnswer: string;
    optimizedAnswer: string;
    rawSourceIds: string[];
    optimizedSourceIds: string[];
    regressionThreshold?: number;
  };
  error?: string;
} {
  if (!isRecord(value)) return { error: "body must be an object" };
  const prompt = value.prompt;
  const rawAnswer = value.rawAnswer;
  const optimizedAnswer = value.optimizedAnswer;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { error: "prompt is required" };
  }
  if (typeof rawAnswer !== "string" || rawAnswer.trim().length === 0) {
    return { error: "rawAnswer is required" };
  }
  if (typeof optimizedAnswer !== "string" || optimizedAnswer.trim().length === 0) {
    return { error: "optimizedAnswer is required" };
  }
  const rawSourceIds = validateStringArray(value.rawSourceIds, "rawSourceIds");
  if (!rawSourceIds.values) return { error: rawSourceIds.error };
  const optimizedSourceIds = validateStringArray(value.optimizedSourceIds, "optimizedSourceIds");
  if (!optimizedSourceIds.values) return { error: optimizedSourceIds.error };
  if (
    value.regressionThreshold !== undefined &&
    (typeof value.regressionThreshold !== "number" || !Number.isFinite(value.regressionThreshold))
  ) {
    return { error: "regressionThreshold must be a number" };
  }

  return {
    input: {
      prompt,
      rawAnswer,
      optimizedAnswer,
      rawSourceIds: rawSourceIds.values,
      optimizedSourceIds: optimizedSourceIds.values,
      regressionThreshold: typeof value.regressionThreshold === "number" ? value.regressionThreshold : undefined,
    },
  };
}

function recalculateMetrics(result: ContextOptimizationResult): ContextOptimizationResult {
  const outputTokens = result.optimized.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const savedTokens = Math.max(0, result.metrics.inputTokens - outputTokens);
  return {
    ...result,
    metrics: {
      ...result.metrics,
      outputChunks: result.optimized.length,
      flaggedChunks: result.flagged.length,
      quarantinedChunks: result.quarantined.length,
      outputTokens,
      savedTokens,
      reductionPct: result.metrics.inputTokens === 0
        ? 0
        : Number(((savedTokens / result.metrics.inputTokens) * 100).toFixed(2)),
    },
  };
}

async function applyRiskScan(
  db: Db,
  tenantId: string | null,
  result: ContextOptimizationResult,
): Promise<ContextOptimizationResult> {
  await ensureBuiltInRules(db, tenantId);
  const rules = await loadRules(db, tenantId);
  if (rules.length === 0) return result;

  const safe: OptimizedContextChunk[] = [];
  const flagged: RiskyContextChunk[] = [];
  const quarantined: RiskyContextChunk[] = [];

  for (const chunk of result.optimized) {
    const scan = scanContent(chunk.content, rules, "retrieved_context");
    if (scan.decision === "allow") {
      safe.push(chunk);
      continue;
    }

    const risky: RiskyContextChunk = {
      ...chunk,
      decision: scan.decision === "block" ? "quarantine" : scan.decision,
      ruleName: scan.violations[0]?.ruleName ?? null,
      matchedContent: scan.violations[0]?.matchedSnippet ?? null,
    };

    if (risky.decision === "flag" || risky.decision === "redact") {
      flagged.push(risky);
    } else {
      quarantined.push(risky);
    }
  }

  return recalculateMetrics({
    ...result,
    optimized: safe,
    flagged,
    quarantined,
  });
}

export function createContextRoutes(db: Db, registry?: ProviderRegistry) {
  const app = new Hono();

  app.post("/optimize", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{ chunks?: unknown; scanRisk?: unknown }>().catch(() => null);
    if (!body) {
      return c.json(
        { error: { message: "Invalid JSON body", type: "validation_error" } },
        400,
      );
    }

    const parsed = validateChunks(body.chunks);
    if (!parsed.chunks) {
      return c.json(
        { error: { message: parsed.error || "invalid chunks", type: "validation_error" } },
        400,
      );
    }

    const scanRisk = validateScanRisk(body.scanRisk);
    if (scanRisk.error) {
      return c.json(
        { error: { message: scanRisk.error, type: "validation_error" } },
        400,
      );
    }

    const baseOptimization = optimizeContextChunks(parsed.chunks);
    const optimization = scanRisk.scanRisk
      ? await applyRiskScan(db, tenantId, baseOptimization)
      : baseOptimization;
    const event = await recordContextOptimizationEvent(db, tenantId, optimization, {
      riskScanned: scanRisk.scanRisk ?? false,
    });
    const retrieval = await recordContextRetrievalEvent(db, tenantId, optimization, {
      optimizationEventId: event.id,
    });

    return c.json({ optimization, event, retrieval });
  });

  app.get("/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
    const events = await listContextOptimizationEvents(db, tenantId, { limit });

    return c.json({ events });
  });

  app.get("/summary", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const summary = await summarizeContextOptimizationEvents(db, tenantId);

    return c.json({ summary });
  });

  app.post("/evaluate", async (c) => {
    if (!registry) {
      return c.json(
        { error: { message: "Judge registry is not configured", type: "configuration_error" } },
        503,
      );
    }
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = validateQualityBody(body);
    if (!parsed.input) {
      return c.json(
        { error: { message: parsed.error || "invalid evaluation body", type: "validation_error" } },
        400,
      );
    }

    try {
      const result = await evaluateContextQuality(db, registry, tenantId, parsed.input);
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : "Context quality evaluation failed",
            type: "judge_error",
          },
        },
        502,
      );
    }
  });

  app.get("/quality/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const regressedOnly = c.req.query("regressedOnly") === "true";
    const events = await listContextQualityEvents(db, tenantId, { limit, regressedOnly });

    return c.json({ events });
  });

  app.get("/quality/summary", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const summary = await summarizeContextQualityEvents(db, tenantId);

    return c.json({ summary });
  });

  app.get("/retrieval/events", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const events = await listContextRetrievalEvents(db, tenantId, { limit });

    return c.json({ events });
  });

  app.get("/retrieval/summary", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const summary = await summarizeContextRetrievalEvents(db, tenantId);

    return c.json({ summary });
  });

  return app;
}
