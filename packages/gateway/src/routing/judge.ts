import type { ChatMessage } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/index.js";
import type { Db } from "@provara/db";
import { appConfig, feedback } from "@provara/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getPricing } from "../cost/index.js";
import type { AdaptiveRouter } from "./adaptive.js";

const JUDGE_CONFIG_KEY = "judge_config";

let judgeSampleRate = parseFloat(process.env.PROVARA_JUDGE_SAMPLE_RATE || "0.1");
let judgeEnabled = true;

export function getJudgeConfig() {
  return { sampleRate: judgeSampleRate, enabled: judgeEnabled };
}

export async function hydrateJudgeConfig(db: Db) {
  const row = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, JUDGE_CONFIG_KEY))
    .get();
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value) as { sampleRate?: number; enabled?: boolean };
    if (typeof parsed.sampleRate === "number") {
      judgeSampleRate = Math.max(0, Math.min(1, parsed.sampleRate));
    }
    if (typeof parsed.enabled === "boolean") {
      judgeEnabled = parsed.enabled;
    }
  } catch {
    // Malformed row — leave defaults in place
  }
}

export async function setJudgeConfig(
  db: Db,
  config: { sampleRate?: number; enabled?: boolean }
) {
  if (config.sampleRate !== undefined) {
    judgeSampleRate = Math.max(0, Math.min(1, config.sampleRate));
  }
  if (config.enabled !== undefined) {
    judgeEnabled = config.enabled;
  }
  const value = JSON.stringify({ sampleRate: judgeSampleRate, enabled: judgeEnabled });
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

const JUDGE_PROMPT = `You are an impartial quality judge. Rate the AI assistant's response on three dimensions.

Score each dimension from 1 (poor) to 5 (excellent):
- **Relevance**: Does the response address what was asked?
- **Accuracy**: Is the information correct and well-reasoned?
- **Coherence**: Is the response clear, well-structured, and complete?

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

export function createJudge(registry: ProviderRegistry, db: Db, adaptive: AdaptiveRouter) {
  async function maybeJudge(ctx: JudgeContext): Promise<void> {
    if (!shouldJudge()) return;

    const target = findCheapestModel(registry);
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
        content: `**User's prompt:**\n${lastUserMessage.content}\n\n**Assistant's response:**\n${ctx.responseContent}`,
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
          "judge"
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
