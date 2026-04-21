import { Hono } from "hono";
import type { Db } from "@provara/db";
import { evalDatasets, evalRuns, evalResults } from "@provara/db";
import { eq, desc, and, sql, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId, tenantFilter } from "../auth/tenant.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { ChatMessage } from "../providers/types.js";
import { logCost } from "../cost/index.js";
import { classifyRequest } from "../classifier/index.js";
import { resolveJudgeTarget } from "../routing/judge.js";

/** Special sentinel target: runs the Provara classifier instead of a model.
 *  Output shape is "taskType/complexity" (e.g. "coding/medium") for
 *  exact-match scoring against a labeled golden set. */
const CLASSIFIER_PROVIDER = "provara";
const CLASSIFIER_MODEL = "classifier";
const isClassifierTarget = (provider: string, model: string) =>
  provider === CLASSIFIER_PROVIDER && model === CLASSIFIER_MODEL;

type Scorer = "llm-judge" | "exact-match" | "regex-match";

const SCORERS: ReadonlySet<Scorer> = new Set(["llm-judge", "exact-match", "regex-match"] as const);

/**
 * Evals (#262). Upload a JSONL dataset, run it against a (provider, model)
 * pair, grade outputs with the existing judge prompt, persist results.
 *
 * MVP scope:
 *   - Dataset CRUD (JSONL upload, list, detail, delete)
 *   - Run executor (bounded concurrency, judge-graded)
 *   - Run list + detail
 *
 * Out of scope for MVP (follow-ups):
 *   - Prompt-version variants
 *   - Expected-output matching / pass-fail
 *   - CLI + GitHub Action
 *   - Side-by-side run comparisons
 */

interface DatasetCase {
  input: ChatMessage[];
  expected?: string;
  metadata?: Record<string, unknown>;
}

function parseJsonl(text: string): DatasetCase[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cases: DatasetCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw new Error(`Line ${i + 1}: invalid JSON`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Line ${i + 1}: must be a JSON object`);
    }
    const row = parsed as Record<string, unknown>;
    const input = row.input;
    if (!Array.isArray(input) || input.length === 0) {
      throw new Error(`Line ${i + 1}: "input" must be a non-empty array of chat messages`);
    }
    cases.push({
      input: input as ChatMessage[],
      expected: typeof row.expected === "string" ? row.expected : undefined,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : undefined,
    });
  }
  return cases;
}

const JUDGE_PROMPT = `You are a strict, impartial evaluator. Rate the response's quality on a 1–5 scale (1=terrible, 5=excellent). Consider accuracy, relevance, clarity, and completeness. Return ONLY JSON like {"score": N}, no other text.`;

function parseJudgeResponse(raw: string): number | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown };
    if (typeof parsed.score === "number" && parsed.score >= 1 && parsed.score <= 5) {
      return Math.round(parsed.score);
    }
  } catch {}
  return null;
}

// Judge target is resolved via the shared resolveJudgeTarget helper so Evals
// respects the dashboard-pinned judge config (routing/judge.ts). Previously
// we hardcoded an openai/anthropic preference list here and ignored the pin.

/** Produce the target's output for a case. For normal targets this is a
 *  chat completion; for the classifier sentinel it's the predicted labels
 *  formatted as "taskType/complexity". Returns output + token usage for
 *  cost logging. */
async function runTarget(
  registry: ProviderRegistry,
  target: { provider: string; model: string },
  messages: ChatMessage[],
): Promise<{ output: string; inputTokens: number; outputTokens: number }> {
  if (isClassifierTarget(target.provider, target.model)) {
    const result = await classifyRequest(messages, registry);
    // Confidence is folded into the output as a suffix so the raw label is
    // the first token (clean for exact-match), while operators eyeballing
    // results can still see how confident the classifier was.
    const conf = `${result.taskConfidence.toFixed(2)}/${result.complexityConfidence.toFixed(2)}`;
    const fallback = result.usedLlmFallback ? " [llm-fallback]" : "";
    return {
      output: `${result.taskType}/${result.complexity} (conf=${conf})${fallback}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const provider = registry.get(target.provider);
  if (!provider) throw new Error(`Provider "${target.provider}" not registered`);
  const resp = await provider.complete({
    model: target.model,
    messages,
    temperature: 0,
  });
  return {
    output: resp.content,
    inputTokens: resp.usage.inputTokens,
    outputTokens: resp.usage.outputTokens,
  };
}

/** Extract just the first token of classifier output for matching, so
 *  "coding/medium (conf=0.84/0.71)" compares equal to expected "coding/medium". */
function normalizeForMatch(output: string): string {
  return output.split(/\s+/)[0].trim();
}

async function executeRun(
  db: Db,
  registry: ProviderRegistry,
  runId: string,
  datasetCases: DatasetCase[],
  target: { provider: string; model: string },
  scorer: Scorer,
  tenantId: string | null,
): Promise<void> {
  await db
    .update(evalRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(evalRuns.id, runId))
    .run();

  // Validate target availability upfront. Classifier target always OK
  // (classifier is in-process); model targets need a registered provider.
  if (!isClassifierTarget(target.provider, target.model) && !registry.get(target.provider)) {
    await db
      .update(evalRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(evalRuns.id, runId))
      .run();
    return;
  }

  const judgeTarget = scorer === "llm-judge" ? resolveJudgeTarget(registry) : null;
  const CONCURRENCY = 4;
  let totalScoreSum = 0;
  let totalScoreCount = 0;
  let totalCost = 0;

  async function runCase(caseIndex: number, c: DatasetCase) {
    const start = performance.now();
    let output: string | null = null;
    let score: number | null = null;
    let judgeSource: string | null = null;
    let errorStr: string | null = null;
    let caseCost = 0;
    try {
      const { output: targetOutput, inputTokens, outputTokens } = await runTarget(
        registry,
        target,
        c.input,
      );
      output = targetOutput;
      if (inputTokens > 0 || outputTokens > 0) {
        caseCost = await logCost(db, {
          requestId: `eval-${runId}-${caseIndex}`,
          provider: target.provider,
          model: target.model,
          inputTokens,
          outputTokens,
          tenantId,
        });
      }

      // Scorer dispatch. Each produces a 1-5 score + judgeSource label that
      // tells the UI how the score was derived (for non-judge scorers, this
      // records the strategy name — `exact-match` or `regex-match:<pattern>`).
      if (scorer === "exact-match") {
        const expected = (c.expected ?? "").trim();
        if (!expected) {
          judgeSource = "exact-match:no-expected";
        } else {
          const actual = normalizeForMatch(output);
          score = actual === expected ? 5 : 1;
          judgeSource = "exact-match";
        }
      } else if (scorer === "regex-match") {
        const pattern = (c.expected ?? "").trim();
        if (!pattern) {
          judgeSource = "regex-match:no-expected";
        } else {
          try {
            const re = new RegExp(pattern);
            score = re.test(output) ? 5 : 1;
            judgeSource = `regex-match:${pattern}`;
          } catch {
            judgeSource = "regex-match:invalid-pattern";
          }
        }
      } else if (judgeTarget) {
        try {
          const judgeProvider = registry.get(judgeTarget.provider);
          if (judgeProvider) {
            const lastUser = [...c.input].reverse().find((m) => m.role === "user");
            const userText =
              typeof lastUser?.content === "string"
                ? lastUser.content
                : Array.isArray(lastUser?.content)
                  ? lastUser.content
                      .map((p) => (p.type === "text" ? p.text : "[image]"))
                      .join(" ")
                  : "";
            const judgeResp = await judgeProvider.complete({
              model: judgeTarget.model,
              messages: [
                { role: "system", content: JUDGE_PROMPT },
                {
                  role: "user",
                  content: `**User prompt:**\n${userText}\n\n**Response:**\n${output}`,
                },
              ],
              temperature: 0,
              max_tokens: 40,
            });
            score = parseJudgeResponse(judgeResp.content);
            judgeSource = `${judgeTarget.provider}/${judgeTarget.model}`;
          }
        } catch (err) {
          console.warn(
            `[evals] judge failed for run ${runId} case ${caseIndex}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      errorStr = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Math.round(performance.now() - start);
    await db
      .insert(evalResults)
      .values({
        id: nanoid(),
        runId,
        caseIndex,
        input: JSON.stringify(c.input),
        output,
        score,
        judgeSource,
        error: errorStr,
        latencyMs,
        cost: caseCost,
      })
      .run();

    if (score !== null) {
      totalScoreSum += score;
      totalScoreCount++;
    }
    totalCost += caseCost;

    // Incremental aggregate update so the UI's poll shows live progress.
    await db
      .update(evalRuns)
      .set({
        avgScore: totalScoreCount > 0 ? totalScoreSum / totalScoreCount : null,
        totalCost,
      })
      .where(eq(evalRuns.id, runId))
      .run();
  }

  // Execute cases in bounded concurrency batches.
  for (let i = 0; i < datasetCases.length; i += CONCURRENCY) {
    const batch = datasetCases.slice(i, i + CONCURRENCY).map((c, j) => runCase(i + j, c));
    await Promise.all(batch);
  }

  await db
    .update(evalRuns)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(evalRuns.id, runId))
    .run();
}

export function createEvalRoutes(db: Db, registry: ProviderRegistry) {
  const app = new Hono();

  // --- Datasets ---

  app.post("/datasets", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{ name?: string; description?: string; jsonl?: string }>();
    if (!body.name || typeof body.name !== "string") {
      return c.json({ error: { message: "`name` is required", type: "validation_error" } }, 400);
    }
    if (!body.jsonl || typeof body.jsonl !== "string") {
      return c.json(
        { error: { message: "`jsonl` is required (line-delimited JSON of cases)", type: "validation_error" } },
        400,
      );
    }
    let cases: DatasetCase[];
    try {
      cases = parseJsonl(body.jsonl);
    } catch (err) {
      return c.json(
        {
          error: {
            message: `Dataset parse error: ${err instanceof Error ? err.message : String(err)}`,
            type: "validation_error",
          },
        },
        400,
      );
    }
    if (cases.length === 0) {
      return c.json({ error: { message: "Dataset has no cases", type: "validation_error" } }, 400);
    }

    const id = nanoid();
    await db
      .insert(evalDatasets)
      .values({
        id,
        tenantId,
        name: body.name,
        description: body.description || null,
        casesJsonl: body.jsonl,
        caseCount: cases.length,
      })
      .run();
    return c.json({ id, name: body.name, caseCount: cases.length }, 201);
  });

  app.get("/datasets", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rows = await db
      .select({
        id: evalDatasets.id,
        name: evalDatasets.name,
        description: evalDatasets.description,
        caseCount: evalDatasets.caseCount,
        createdAt: evalDatasets.createdAt,
      })
      .from(evalDatasets)
      .where(tenantFilter(evalDatasets.tenantId, tenantId))
      .orderBy(desc(evalDatasets.createdAt))
      .all();
    return c.json({ datasets: rows });
  });

  app.get("/datasets/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const tc = tenantFilter(evalDatasets.tenantId, tenantId);
    const row = await db
      .select()
      .from(evalDatasets)
      .where(tc ? and(eq(evalDatasets.id, id), tc) : eq(evalDatasets.id, id))
      .get();
    if (!row) {
      return c.json({ error: { message: "Dataset not found", type: "not_found" } }, 404);
    }
    // Return a preview of the first 5 cases so the UI can show what's inside
    // without downloading the full JSONL (datasets can be large).
    let preview: DatasetCase[] = [];
    try {
      preview = parseJsonl(row.casesJsonl).slice(0, 5);
    } catch {}
    return c.json({
      id: row.id,
      name: row.name,
      description: row.description,
      caseCount: row.caseCount,
      createdAt: row.createdAt,
      preview,
    });
  });

  // Append a single case to an existing dataset. Used by the playground's
  // "Save as eval case" button (#266) — lets users turn a forked-and-edited
  // prod request into a regression test with one click.
  app.post("/datasets/:id/cases", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{
      input?: ChatMessage[];
      expected?: string;
      metadata?: Record<string, unknown>;
    }>();
    if (!Array.isArray(body.input) || body.input.length === 0) {
      return c.json(
        { error: { message: "`input` must be a non-empty ChatMessage[]", type: "validation_error" } },
        400,
      );
    }
    const tc = tenantFilter(evalDatasets.tenantId, tenantId);
    const existing = await db
      .select()
      .from(evalDatasets)
      .where(tc ? and(eq(evalDatasets.id, id), tc) : eq(evalDatasets.id, id))
      .get();
    if (!existing) {
      return c.json({ error: { message: "Dataset not found", type: "not_found" } }, 404);
    }
    const newCase: DatasetCase = {
      input: body.input,
      ...(body.expected ? { expected: body.expected } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    };
    const updatedJsonl =
      (existing.casesJsonl.endsWith("\n") ? existing.casesJsonl : existing.casesJsonl + "\n") +
      JSON.stringify(newCase);
    await db
      .update(evalDatasets)
      .set({
        casesJsonl: updatedJsonl,
        caseCount: existing.caseCount + 1,
      })
      .where(eq(evalDatasets.id, id))
      .run();
    return c.json({ ok: true, caseCount: existing.caseCount + 1 }, 201);
  });

  app.delete("/datasets/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const tc = tenantFilter(evalDatasets.tenantId, tenantId);
    const where = tc ? and(eq(evalDatasets.id, id), tc) : eq(evalDatasets.id, id);
    const existing = await db.select().from(evalDatasets).where(where).get();
    if (!existing) {
      return c.json({ error: { message: "Dataset not found", type: "not_found" } }, 404);
    }
    // Cascade: delete dependent runs + their results. SQLite FK is non-cascading
    // in our config, so explicit cleanup keeps the tables consistent.
    const runs = await db.select({ id: evalRuns.id }).from(evalRuns).where(eq(evalRuns.datasetId, id)).all();
    for (const r of runs) {
      await db.delete(evalResults).where(eq(evalResults.runId, r.id)).run();
    }
    await db.delete(evalRuns).where(eq(evalRuns.datasetId, id)).run();
    await db.delete(evalDatasets).where(where).run();
    return c.json({ ok: true });
  });

  // --- Runs ---

  app.post("/runs", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{ datasetId?: string; provider?: string; model?: string; scorer?: string }>();
    if (!body.datasetId || !body.provider || !body.model) {
      return c.json(
        { error: { message: "`datasetId`, `provider`, `model` are required", type: "validation_error" } },
        400,
      );
    }
    const scorer: Scorer = body.scorer && SCORERS.has(body.scorer as Scorer)
      ? (body.scorer as Scorer)
      : "llm-judge";
    const tc = tenantFilter(evalDatasets.tenantId, tenantId);
    const dataset = await db
      .select()
      .from(evalDatasets)
      .where(tc ? and(eq(evalDatasets.id, body.datasetId), tc) : eq(evalDatasets.id, body.datasetId))
      .get();
    if (!dataset) {
      return c.json({ error: { message: "Dataset not found", type: "not_found" } }, 404);
    }
    // Classifier target is always runnable (in-process). Model targets need
    // the provider registered.
    if (!isClassifierTarget(body.provider, body.model) && !registry.get(body.provider)) {
      return c.json(
        {
          error: {
            message: `Provider \`${body.provider}\` is not registered. Configure its API key first.`,
            type: "validation_error",
          },
        },
        400,
      );
    }

    const runId = nanoid();
    await db
      .insert(evalRuns)
      .values({
        id: runId,
        tenantId,
        datasetId: body.datasetId,
        provider: body.provider,
        model: body.model,
        scorer,
      })
      .run();

    // Fire-and-forget — the executor writes results + status as it goes. The UI
    // polls `/runs/:id` to track progress.
    let cases: DatasetCase[];
    try {
      cases = parseJsonl(dataset.casesJsonl);
    } catch (err) {
      await db
        .update(evalRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(evalRuns.id, runId))
        .run();
      return c.json(
        {
          error: {
            message: `Failed to parse dataset cases: ${err instanceof Error ? err.message : String(err)}`,
            type: "internal_error",
          },
        },
        500,
      );
    }
    void executeRun(db, registry, runId, cases, { provider: body.provider, model: body.model }, scorer, tenantId).catch(
      async (err) => {
        console.error(`[evals] run ${runId} crashed:`, err instanceof Error ? err.message : err);
        await db
          .update(evalRuns)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(evalRuns.id, runId))
          .run();
      },
    );

    return c.json({ runId, status: "queued" }, 202);
  });

  app.get("/runs", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const rows = await db
      .select({
        id: evalRuns.id,
        datasetId: evalRuns.datasetId,
        datasetName: evalDatasets.name,
        provider: evalRuns.provider,
        model: evalRuns.model,
        status: evalRuns.status,
        avgScore: evalRuns.avgScore,
        totalCost: evalRuns.totalCost,
        startedAt: evalRuns.startedAt,
        completedAt: evalRuns.completedAt,
        createdAt: evalRuns.createdAt,
      })
      .from(evalRuns)
      .innerJoin(evalDatasets, eq(evalRuns.datasetId, evalDatasets.id))
      .where(tenantFilter(evalRuns.tenantId, tenantId))
      .orderBy(desc(evalRuns.createdAt))
      .limit(50)
      .all();
    return c.json({ runs: rows });
  });

  app.get("/runs/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const tc = tenantFilter(evalRuns.tenantId, tenantId);
    const run = await db
      .select()
      .from(evalRuns)
      .where(tc ? and(eq(evalRuns.id, id), tc) : eq(evalRuns.id, id))
      .get();
    if (!run) {
      return c.json({ error: { message: "Run not found", type: "not_found" } }, 404);
    }
    const results = await db
      .select()
      .from(evalResults)
      .where(eq(evalResults.runId, id))
      .orderBy(evalResults.caseIndex)
      .all();
    const totals = await db
      .select({ count: sql<number>`count(*)` })
      .from(evalResults)
      .where(eq(evalResults.runId, id))
      .get();
    return c.json({ run, results, completedCases: totals?.count || 0 });
  });

  return app;
}
