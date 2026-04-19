import type { ChatMessage } from "../providers/types.js";
import { messageText } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { Db } from "@provara/db";
import { appConfig, feedback } from "@provara/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getPricing } from "../cost/index.js";
import type { AdaptiveRouter } from "./adaptive/index.js";

const JUDGE_CONFIG_KEY = "judge_config";

let judgeSampleRate = parseFloat(process.env.PROVARA_JUDGE_SAMPLE_RATE || "0.1");
let judgeEnabled = true;
let judgeProvider: string | null = null;
let judgeModel: string | null = null;

export function getJudgeConfig() {
  return {
    sampleRate: judgeSampleRate,
    enabled: judgeEnabled,
    provider: judgeProvider,
    model: judgeModel,
  };
}

export async function hydrateJudgeConfig(db: Db) {
  const row = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, JUDGE_CONFIG_KEY))
    .get();
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value) as {
      sampleRate?: number;
      enabled?: boolean;
      provider?: string | null;
      model?: string | null;
    };
    if (typeof parsed.sampleRate === "number") {
      judgeSampleRate = Math.max(0, Math.min(1, parsed.sampleRate));
    }
    if (typeof parsed.enabled === "boolean") {
      judgeEnabled = parsed.enabled;
    }
    if (parsed.provider !== undefined) judgeProvider = parsed.provider || null;
    if (parsed.model !== undefined) judgeModel = parsed.model || null;
  } catch {
    // Malformed row — leave defaults in place
  }
}

export async function setJudgeConfig(
  db: Db,
  config: {
    sampleRate?: number;
    enabled?: boolean;
    provider?: string | null;
    model?: string | null;
  }
) {
  if (config.sampleRate !== undefined) {
    judgeSampleRate = Math.max(0, Math.min(1, config.sampleRate));
  }
  if (config.enabled !== undefined) {
    judgeEnabled = config.enabled;
  }
  if (config.provider !== undefined) judgeProvider = config.provider || null;
  if (config.model !== undefined) judgeModel = config.model || null;

  const value = JSON.stringify({
    sampleRate: judgeSampleRate,
    enabled: judgeEnabled,
    provider: judgeProvider,
    model: judgeModel,
  });
  const now = new Date();
  await db
    .insert(appConfig)
    .values({ key: JUDGE_CONFIG_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: now },
    })
    .run();
}

const JUDGE_PROMPT = `You are a strict, impartial quality judge. Rate the AI assistant's response on three dimensions.

Use the full 1-5 range. A 5 should be rare — reserve it for responses that a careful reviewer could not meaningfully improve. Most adequate responses are a 3 or 4. If a dimension has any noticeable weakness, it cannot be a 5.

Score anchors (apply to each dimension independently):
- **1** — Wrong, off-topic, or hallucinated. Would mislead a user.
- **2** — Partially on-topic but substantively flawed: missing key information, significant inaccuracy, or poorly structured.
- **3** — Acceptable and mostly correct, but has clear room for improvement: generic, shallow, minor omissions, awkward phrasing, or one small error.
- **4** — Solid response: accurate, complete enough, and well-organized, with only minor polish left on the table.
- **5** — Genuinely excellent: correct, precise, appropriately scoped, and well-written. Nothing substantive to add or remove.

Dimensions:
- **relevance** — does the response address what was asked?
- **accuracy** — is every factual claim correct and well-reasoned? (Hallucinations, fabricated citations, or wrong details cap this at 2.)
- **coherence** — is the response clear, well-structured, and complete for the ask?

If you catch yourself about to give all three a 5, stop and check whether any dimension has even a small weakness. It almost always does.

Respond with ONLY valid JSON, no other text:
{"relevance": N, "accuracy": N, "coherence": N}`;

interface JudgeResult {
  relevance: number;
  accuracy: number;
  coherence: number;
  average: number;
}

function shouldJudge(): boolean {
  if (!judgeEnabled) return false;
  return Math.random() < judgeSampleRate;
}

function findCheapestModel(registry: ProviderRegistry): { provider: string; model: string } | null {
  let cheapest: { provider: string; model: string; cost: number } | null = null;

  for (const provider of registry.list()) {
    for (const model of provider.models) {
      const pricing = getPricing(model);
      if (!pricing) continue;
      const totalCost = pricing[0] + pricing[1];
      if (!cheapest || totalCost < cheapest.cost) {
        cheapest = { provider: provider.name, model, cost: totalCost };
      }
    }
  }

  return cheapest ? { provider: cheapest.provider, model: cheapest.model } : null;
}

function parseJudgeResponse(raw: string): JudgeResult | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const relevance = Number(parsed.relevance);
    const accuracy = Number(parsed.accuracy);
    const coherence = Number(parsed.coherence);

    if ([relevance, accuracy, coherence].every((n) => n >= 1 && n <= 5)) {
      const average = Math.round((relevance + accuracy + coherence) / 3);
      return { relevance, accuracy, coherence, average };
    }
    return null;
  } catch {
    return null;
  }
}

export interface JudgeContext {
  requestId: string;
  tenantId: string | null;
  messages: ChatMessage[];
  responseContent: string;
  taskType: string | null;
  complexity: string | null;
  provider: string;
  model: string;
}

function resolveJudgeTarget(registry: ProviderRegistry): { provider: string; model: string } | null {
  if (judgeProvider && judgeModel) {
    const pinned = registry.get(judgeProvider);
    if (pinned && pinned.models.includes(judgeModel)) {
      return { provider: judgeProvider, model: judgeModel };
    }
    console.warn(
      `[judge] pinned model ${judgeProvider}/${judgeModel} not in registry; falling back to cheapest`
    );
  }
  return findCheapestModel(registry);
}

export function createJudge(registry: ProviderRegistry, db: Db, adaptive: AdaptiveRouter) {
  async function maybeJudge(ctx: JudgeContext): Promise<void> {
    if (!shouldJudge()) return;

    const target = resolveJudgeTarget(registry);
    if (!target) return;

    const provider = registry.get(target.provider);
    if (!provider) return;

    // Build the judge prompt with the original exchange
    const lastUserMessage = [...ctx.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMessage) return;

    const judgeMessages: ChatMessage[] = [
      { role: "system", content: JUDGE_PROMPT },
      {
        role: "user",
        content: `**User's prompt:**\n${messageText(lastUserMessage)}\n\n**Assistant's response:**\n${ctx.responseContent}`,
      },
    ];

    try {
      const response = await provider.complete({
        model: target.model,
        messages: judgeMessages,
        temperature: 0,
        max_tokens: 100,
      });

      const result = parseJudgeResponse(response.content);
      if (!result) {
        console.warn(
          `[judge] parse failed — ${target.provider}/${target.model} returned unparseable response:`,
          response.content.slice(0, 200)
        );
        return;
      }

      // Store as feedback with source "judge"
      await db.insert(feedback)
        .values({
          id: nanoid(),
          requestId: ctx.requestId,
          tenantId: ctx.tenantId,
          score: result.average,
          comment: `Judge scores — relevance: ${result.relevance}, accuracy: ${result.accuracy}, coherence: ${result.coherence}`,
          source: "judge",
        })
        .run();

      if (ctx.taskType && ctx.complexity) {
        await adaptive.updateScore(
          ctx.taskType,
          ctx.complexity,
          ctx.provider,
          ctx.model,
          result.average,
          "judge",
          ctx.tenantId,
        );
      }
    } catch (err) {
      console.warn(
        `[judge] ${target.provider}/${target.model} scoring failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { maybeJudge };
}
