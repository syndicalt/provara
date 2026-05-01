import type { Db } from "@provara/db";
import {
  abTests,
  abTestVariants,
  alertLogs,
  alertRules,
  apiKeys,
  apiTokens,
  auditLogs,
  costLogs,
  costMigrations,
  contextOptimizationEvents,
  customProviders,
  feedback,
  guardrailLogs,
  guardrailRules,
  modelScores,
  promptTemplates,
  promptVersions,
  regressionEvents,
  replayBank,
  requests,
  routingWeightSnapshots,
  sessions,
  spendBudgets,
  subscriptions,
  teamInvites,
  users,
} from "@provara/db";
import { eq } from "drizzle-orm";

/**
 * Demo-tenant seed (#229). Wipes and reseeds `t_demo` with a
 * **narrative arc** over 30 days that tells Provara's core story:
 *
 *   - Days 30 → 21: early phase. Expensive, high-quality models
 *     (Opus, GPT-4.1, Sonnet) dominate. Cost per request is high.
 *   - Days 20 → 11: transitional. Adaptive routing has learned some
 *     cells well enough to shift to mid-tier models (Sonnet, Mini).
 *   - Days 10 → 0 (today): optimized. Cheap models (Haiku, Nano,
 *     Flash) own most cells. Judge scores stay within 0.05 of the
 *     early-phase mean — quality is preserved while cost plummets.
 *
 * Looking at `/dashboard/spend/trajectory` in the demo, this shows up
 * as a clear downward curve in daily spend with a stable quality
 * envelope — the visual punchline of the product.
 *
 * Beyond the arc, this function also seeds every feature surface so
 * no dashboard page renders empty: A/B tests, prompt templates with
 * versions, alert rules + firings, guardrail rules + PII violation
 * logs, pending team invites, custom provider, cost migrations with
 * reported savings, a triggered regression event, budget at 75% with
 * threshold emails fired, and a mid-window routing weight change that
 * drives the spend-drift view.
 *
 * Subscription is seeded as Enterprise so tier-gated features
 * (drift, recommendations, user/token attribution) all unlock.
 *
 * Idempotent: wipes `t_demo`-scoped rows first, then inserts. Running
 * twice is a clean no-op. The nightly `demo-reseed` job calls this;
 * the every-5-minute `demo-tick` job layers live-looking recent rows
 * on top without touching the history.
 */

export const DEMO_TENANT_ID = "t_demo";
export const DEMO_USER_IDS = ["u_demo_visitor", "u_demo_member_alice", "u_demo_member_bob"];
export const DEMO_CELLS = [
  { taskType: "coding", complexity: "complex" },
  { taskType: "coding", complexity: "medium" },
  { taskType: "qa", complexity: "simple" },
  { taskType: "creative", complexity: "medium" },
  { taskType: "general", complexity: "simple" },
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-phase model weighting. The arc lives here: each phase has a
 * different (provider, model, costPer1M) pool, and the request
 * generator samples by cell deterministically (seeded on index) to
 * keep the story consistent across reseeds.
 */
interface PhaseModel { provider: string; model: string; costInPer1M: number; costOutPer1M: number; }
const PHASE_EXPENSIVE: PhaseModel[] = [
  { provider: "anthropic", model: "claude-opus-4-6", costInPer1M: 15, costOutPer1M: 75 },
  { provider: "openai", model: "gpt-4.1", costInPer1M: 2, costOutPer1M: 8 },
  { provider: "anthropic", model: "claude-sonnet-4-6", costInPer1M: 3, costOutPer1M: 15 },
];
const PHASE_TRANSITIONAL: PhaseModel[] = [
  { provider: "anthropic", model: "claude-sonnet-4-6", costInPer1M: 3, costOutPer1M: 15 },
  { provider: "openai", model: "gpt-4.1-mini", costInPer1M: 0.4, costOutPer1M: 1.6 },
  { provider: "google", model: "gemini-2.5-flash", costInPer1M: 0.15, costOutPer1M: 0.6 },
];
const PHASE_OPTIMIZED: PhaseModel[] = [
  { provider: "openai", model: "gpt-4.1-nano", costInPer1M: 0.1, costOutPer1M: 0.4 },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", costInPer1M: 0.8, costOutPer1M: 4 },
  { provider: "google", model: "gemini-2.0-flash", costInPer1M: 0.1, costOutPer1M: 0.4 },
];

function phaseForDaysAgo(daysAgo: number): PhaseModel[] {
  if (daysAgo > 20) return PHASE_EXPENSIVE;
  if (daysAgo > 10) return PHASE_TRANSITIONAL;
  return PHASE_OPTIMIZED;
}

function costFor(model: PhaseModel, inputTokens: number, outputTokens: number): number {
  return Number(
    ((inputTokens / 1_000_000) * model.costInPer1M +
      (outputTokens / 1_000_000) * model.costOutPer1M).toFixed(6),
  );
}

/** Fair judge score for a request — weakly correlated with model tier
 *  so quality stays in the 4.0-4.7 band throughout the arc.
 *  Produces integer 1-5 since the feedback table stores integers. */
function judgeScoreFor(model: PhaseModel, i: number, isRegressingCell: boolean): number {
  if (isRegressingCell && i % 5 === 0) return 2;
  const tier = model.costInPer1M > 2 ? 0.2 : model.costInPer1M > 0.3 ? 0.1 : 0;
  const base = 4.3 + tier + ((i * 7919) % 3) * 0.1;
  return Math.max(1, Math.min(5, Math.round(base)));
}

export async function reseedDemoTenant(db: Db, now: Date = new Date()): Promise<void> {
  const tenantId = DEMO_TENANT_ID;
  await wipe(db, tenantId);

  // 1. Users
  for (const id of DEMO_USER_IDS) {
    await db.insert(users).values({
      id,
      email: `${id.replace("u_demo_", "")}@demo.provara.xyz`,
      name: id.replace("u_demo_", "").replace("_", " "),
      firstName: id.split("_")[2] ?? "Demo",
      lastName: "Demo",
      tenantId,
      role: id === "u_demo_visitor" ? "owner" : "developer",
      createdAt: new Date(now.getTime() - 60 * DAY_MS),
    }).run();
  }

  // 2. Enterprise subscription.
  await db.insert(subscriptions).values({
    stripeSubscriptionId: "sub_demo_enterprise",
    tenantId,
    stripeCustomerId: "cus_demo_enterprise",
    stripePriceId: "price_demo_enterprise",
    stripeProductId: "prod_demo_enterprise",
    tier: "enterprise",
    includesIntelligence: true,
    status: "active",
    currentPeriodStart: new Date(now.getTime() - 14 * DAY_MS),
    currentPeriodEnd: new Date(now.getTime() + 16 * DAY_MS),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    createdAt: new Date(now.getTime() - 60 * DAY_MS),
    updatedAt: new Date(now.getTime() - 14 * DAY_MS),
  }).run();

  // 3. API tokens
  const tokenProd = "tok_demo_production";
  const tokenStaging = "tok_demo_staging";
  for (const [id, name] of [
    [tokenProd, "Production (demo)"],
    [tokenStaging, "Staging (demo)"],
  ]) {
    await db.insert(apiTokens).values({
      id,
      name,
      tenant: tenantId,
      hashedToken: `h_${id}`,
      tokenPrefix: "pvra_dem",
      enabled: true,
      createdAt: new Date(now.getTime() - 45 * DAY_MS),
    }).run();
  }

  // 4. The narrative arc — 30 days, ~8 requests/day, phase-weighted
  //    models. Each cell rotates through its phase's model pool so
  //    drift + attribution both have clear signal.
  const REQS_PER_DAY = 8;
  let reqIdx = 0;
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const phase = phaseForDaysAgo(daysAgo);
    for (let r = 0; r < REQS_PER_DAY; r++) {
      const cell = DEMO_CELLS[reqIdx % DEMO_CELLS.length];
      const model = phase[reqIdx % phase.length];
      const user = DEMO_USER_IDS[reqIdx % DEMO_USER_IDS.length];
      const apiTokenId = reqIdx % 2 === 0 ? tokenProd : tokenStaging;
      const inputTokens = 400 + (reqIdx * 37) % 800;
      const outputTokens = 200 + (reqIdx * 53) % 600;
      const cost = costFor(model, inputTokens, outputTokens);
      const hourOfDay = (reqIdx * 7) % 24;
      const minOfHour = (reqIdx * 13) % 60;
      const createdAt = new Date(
        now.getTime() - daysAgo * DAY_MS + hourOfDay * 60 * 60 * 1000 + minOfHour * 60_000,
      );
      const reqId = `req_demo_${reqIdx}`;

      await db.insert(requests).values({
        id: reqId,
        provider: model.provider,
        model: model.model,
        prompt: JSON.stringify([{ role: "user", content: `demo prompt ${reqIdx}` }]),
        response: `demo response ${reqIdx}`,
        inputTokens,
        outputTokens,
        latencyMs: 300 + (reqIdx * 11) % 1400,
        cost,
        taskType: cell.taskType,
        complexity: cell.complexity,
        routedBy: "adaptive",
        usedFallback: false,
        cached: false,
        cacheSource: null,
        tokensSavedInput: null,
        tokensSavedOutput: null,
        fallbackErrors: null,
        tenantId,
        userId: user,
        apiTokenId,
        abTestId: null,
        createdAt,
      }).run();

      await db.insert(costLogs).values({
        id: `cl_demo_${reqIdx}`,
        requestId: reqId,
        tenantId,
        provider: model.provider,
        model: model.model,
        inputTokens,
        outputTokens,
        cost,
        userId: user,
        apiTokenId,
        createdAt,
      }).run();

      // Judge feedback on ~30% of requests. One cell (coding+complex)
      // gets low scores in recent days to drive regression detection.
      if (reqIdx % 3 === 0) {
        const isRegressing =
          daysAgo <= 5 && cell.taskType === "coding" && cell.complexity === "complex";
        await db.insert(feedback).values({
          id: `fb_demo_${reqIdx}`,
          requestId: reqId,
          tenantId,
          score: judgeScoreFor(model, reqIdx, isRegressing),
          comment: null,
          source: "judge",
          createdAt,
        }).run();
      }
      reqIdx++;
    }
  }

  // 5. Model scores — tight clusters on recent-phase winners so the
  //    adaptive matrix reflects the "router has learned" end state.
  const scoreRows: Array<{
    taskType: string; complexity: string; provider: string; model: string; qualityScore: number; sampleCount: number;
  }> = [
    // coding + complex: regression cell — Sonnet winning but quality dipping
    { taskType: "coding", complexity: "complex", provider: "anthropic", model: "claude-sonnet-4-6", qualityScore: 0.76, sampleCount: 48 },
    { taskType: "coding", complexity: "complex", provider: "openai", model: "gpt-4.1", qualityScore: 0.82, sampleCount: 40 },
    // coding + medium: mini winning cleanly
    { taskType: "coding", complexity: "medium", provider: "openai", model: "gpt-4.1-mini", qualityScore: 0.84, sampleCount: 55 },
    { taskType: "coding", complexity: "medium", provider: "anthropic", model: "claude-sonnet-4-6", qualityScore: 0.83, sampleCount: 30 },
    // qa + simple: nano winning
    { taskType: "qa", complexity: "simple", provider: "openai", model: "gpt-4.1-nano", qualityScore: 0.88, sampleCount: 72 },
    { taskType: "qa", complexity: "simple", provider: "google", model: "gemini-2.0-flash", qualityScore: 0.86, sampleCount: 60 },
    // creative + medium: Sonnet
    { taskType: "creative", complexity: "medium", provider: "anthropic", model: "claude-sonnet-4-6", qualityScore: 0.91, sampleCount: 42 },
    { taskType: "creative", complexity: "medium", provider: "openai", model: "gpt-4.1-mini", qualityScore: 0.85, sampleCount: 30 },
    // general + simple: Flash winning
    { taskType: "general", complexity: "simple", provider: "google", model: "gemini-2.5-flash", qualityScore: 0.84, sampleCount: 66 },
    { taskType: "general", complexity: "simple", provider: "openai", model: "gpt-4.1-nano", qualityScore: 0.83, sampleCount: 60 },
  ];
  for (const row of scoreRows) {
    await db.insert(modelScores).values({
      tenantId,
      ...row,
      updatedAt: new Date(now.getTime() - 2 * DAY_MS),
    }).run();
  }

  // 6. Replay bank
  for (let i = 0; i < 12; i++) {
    await db.insert(replayBank).values({
      id: `rb_demo_${i}`,
      tenantId,
      taskType: "coding",
      complexity: "complex",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      prompt: JSON.stringify([{ role: "user", content: `golden prompt ${i}` }]),
      response: `golden response ${i}`,
      originalScore: 4.5,
      originalScoreSource: "judge",
      sourceRequestId: `req_demo_${i}`,
      lastReplayedAt: new Date(now.getTime() - 2 * DAY_MS),
      embedding: null,
      embeddingDim: null,
      embeddingModel: null,
      createdAt: new Date(now.getTime() - 20 * DAY_MS),
    }).run();
  }

  // 7. Regression event on the degrading cell.
  await db.insert(regressionEvents).values({
    id: "rev_demo_active",
    tenantId,
    taskType: "coding",
    complexity: "complex",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    replayCount: 8,
    originalMean: 4.5,
    replayMean: 3.1,
    delta: -1.4,
    costUsd: 0.42,
    detectedAt: new Date(now.getTime() - 3 * DAY_MS),
    resolvedAt: null,
    resolutionNote: null,
  }).run();

  // 8. Cost migrations — one from each transition boundary of the arc.
  await db.insert(costMigrations).values({
    id: "cm_demo_1",
    tenantId,
    taskType: "qa",
    complexity: "simple",
    fromProvider: "openai",
    fromModel: "gpt-4.1",
    fromCostPer1M: 10,
    fromQualityScore: 0.88,
    toProvider: "openai",
    toModel: "gpt-4.1-nano",
    toCostPer1M: 0.5,
    toQualityScore: 0.86,
    projectedMonthlySavingsUsd: 42.5,
    graceEndsAt: new Date(now.getTime() + 5 * DAY_MS),
    executedAt: new Date(now.getTime() - 9 * DAY_MS),
    rolledBackAt: null,
    rollbackReason: null,
  }).run();
  await db.insert(costMigrations).values({
    id: "cm_demo_2",
    tenantId,
    taskType: "general",
    complexity: "simple",
    fromProvider: "google",
    fromModel: "gemini-2.5-pro",
    fromCostPer1M: 11.25,
    fromQualityScore: 0.82,
    toProvider: "google",
    toModel: "gemini-2.5-flash",
    toCostPer1M: 0.75,
    toQualityScore: 0.80,
    projectedMonthlySavingsUsd: 22.7,
    graceEndsAt: new Date(now.getTime() - 4 * DAY_MS),
    executedAt: new Date(now.getTime() - 18 * DAY_MS),
    rolledBackAt: null,
    rollbackReason: null,
  }).run();

  // 9. Spend budget at 75%
  await db.insert(spendBudgets).values({
    tenantId,
    period: "monthly",
    capUsd: 500,
    alertThresholds: [50, 75, 90, 100],
    alertEmails: ["finance@demo.provara.xyz"],
    hardStop: false,
    alertedThresholds: [50, 75],
    periodStartedAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    createdAt: new Date(now.getTime() - 30 * DAY_MS),
    updatedAt: new Date(now.getTime() - 2 * DAY_MS),
  }).run();

  // 10. Audit log
  const auditEvents: Array<[string, string | null, string | null, string, Record<string, unknown>]> = [
    ["auth.login.success", "u_demo_visitor", "visitor@demo.provara.xyz", "session", { method: "magic_link" }],
    ["auth.login.success", "u_demo_member_alice", "alice@demo.provara.xyz", "session", { method: "google" }],
    ["user.invited", "u_demo_visitor", "visitor@demo.provara.xyz", "user", { invitedEmail: "bob@demo.provara.xyz" }],
    ["user.joined", "u_demo_member_bob", "bob@demo.provara.xyz", "user", { method: "invite_claim" }],
    ["api_key.created", "u_demo_visitor", "visitor@demo.provara.xyz", "api_key", { provider: "openai" }],
    ["token.created", "u_demo_visitor", "visitor@demo.provara.xyz", "api_token", { tokenName: "Production (demo)" }],
    ["billing.subscription.created", null, null, "subscription", { tier: "enterprise" }],
    ["billing.subscription.updated", null, null, "subscription", { event: "quarterly_renewal" }],
  ];
  for (let i = 0; i < auditEvents.length; i++) {
    const [action, actor, email, resourceType, metadata] = auditEvents[i];
    await db.insert(auditLogs).values({
      id: `audit_demo_${i}`,
      tenantId,
      actorUserId: actor,
      actorEmail: email,
      action,
      resourceType,
      resourceId: null,
      metadata,
      createdAt: new Date(now.getTime() - (auditEvents.length - i) * DAY_MS),
    }).run();
  }

  // 11. Routing-weight snapshots — mid-window shift toward cost.
  await db.insert(routingWeightSnapshots).values({
    id: "rws_demo_before",
    tenantId,
    taskType: "_all_",
    complexity: "_all_",
    weights: { quality: 0.4, cost: 0.4, latency: 0.2 },
    profile: "balanced",
    capturedAt: new Date(now.getTime() - 20 * DAY_MS),
  }).run();
  await db.insert(routingWeightSnapshots).values({
    id: "rws_demo_after",
    tenantId,
    taskType: "_all_",
    complexity: "_all_",
    weights: { quality: 0.2, cost: 0.7, latency: 0.1 },
    profile: "cost",
    capturedAt: new Date(now.getTime() - 10 * DAY_MS),
  }).run();

  // 12. API key row
  await db.insert(apiKeys).values({
    id: "ak_demo_openai",
    name: "OPENAI_API_KEY",
    provider: "openai",
    encryptedValue: "demo-encrypted-bytes",
    iv: "demo-iv",
    authTag: "demo-tag",
    tenantId,
    createdAt: new Date(now.getTime() - 40 * DAY_MS),
    updatedAt: new Date(now.getTime() - 40 * DAY_MS),
  }).run();

  // 13. A/B test — one active, on the "mini vs flash" mid-tier question
  //     for creative/medium. Two variants at 50/50.
  await db.insert(abTests).values({
    id: "ab_demo_1",
    name: "Mini vs Flash on creative/medium",
    description: "Deciding the default model for creative+medium routing.",
    status: "active",
    tenantId,
    autoGenerated: false,
    sourceTaskType: "creative",
    sourceComplexity: "medium",
    sourceReason: null,
    resolvedWinner: null,
    resolvedAt: null,
    createdAt: new Date(now.getTime() - 7 * DAY_MS),
  }).run();
  for (const [variant, provider, model] of [
    ["abv_demo_1_a", "openai", "gpt-4.1-mini"],
    ["abv_demo_1_b", "google", "gemini-2.5-flash"],
  ]) {
    await db.insert(abTestVariants).values({
      id: variant,
      abTestId: "ab_demo_1",
      provider,
      model,
      weight: 1,
      taskType: "creative",
      complexity: "medium",
    }).run();
  }

  // 14. Prompt templates
  await db.insert(promptTemplates).values({
    id: "pt_demo_support",
    tenantId,
    name: "support-triage",
    description: "Initial triage of inbound support tickets.",
    publishedVersionId: "pv_demo_support_v2",
    createdAt: new Date(now.getTime() - 20 * DAY_MS),
    updatedAt: new Date(now.getTime() - 3 * DAY_MS),
  }).run();
  await db.insert(promptVersions).values({
    id: "pv_demo_support_v1",
    templateId: "pt_demo_support",
    version: 1,
    messages: JSON.stringify([
      { role: "system", content: "You classify support tickets into {{category}}." },
      { role: "user", content: "{{ticket_body}}" },
    ]),
    variables: JSON.stringify(["category", "ticket_body"]),
    note: "Initial cut.",
    createdAt: new Date(now.getTime() - 20 * DAY_MS),
  }).run();
  await db.insert(promptVersions).values({
    id: "pv_demo_support_v2",
    templateId: "pt_demo_support",
    version: 2,
    messages: JSON.stringify([
      { role: "system", content: "Classify the following support ticket into one of: {{category}}. Return JSON only." },
      { role: "user", content: "{{ticket_body}}" },
    ]),
    variables: JSON.stringify(["category", "ticket_body"]),
    note: "Added JSON-only instruction after UAT miss.",
    createdAt: new Date(now.getTime() - 3 * DAY_MS),
  }).run();

  // 15. Alert rules — one webhook rule that recently triggered.
  await db.insert(alertRules).values({
    id: "ar_demo_spend",
    tenantId,
    name: "Daily spend over $25",
    metric: "spend",
    condition: "gt",
    threshold: 25,
    window: "24h",
    channel: "webhook",
    webhookUrl: "https://hooks.demo.provara.xyz/spend",
    enabled: true,
    lastTriggeredAt: new Date(now.getTime() - 2 * DAY_MS),
    createdAt: new Date(now.getTime() - 14 * DAY_MS),
  }).run();
  await db.insert(alertRules).values({
    id: "ar_demo_latency",
    tenantId,
    name: "p95 latency over 5s",
    metric: "latency_p95",
    condition: "gt",
    threshold: 5000,
    window: "1h",
    channel: "webhook",
    webhookUrl: "https://hooks.demo.provara.xyz/latency",
    enabled: true,
    lastTriggeredAt: null,
    createdAt: new Date(now.getTime() - 10 * DAY_MS),
  }).run();
  await db.insert(alertLogs).values({
    id: "al_demo_1",
    ruleId: "ar_demo_spend",
    ruleName: "Daily spend over $25",
    metric: "spend",
    value: 28.14,
    threshold: 25,
    acknowledged: true,
    createdAt: new Date(now.getTime() - 2 * DAY_MS),
  }).run();

  // 16. Guardrails — built-in PII rule + a tenant regex rule, with logs.
  await db.insert(guardrailRules).values({
    id: "gr_demo_pii",
    tenantId,
    name: "Built-in PII redaction",
    type: "pii",
    target: "both",
    action: "redact",
    pattern: null,
    enabled: true,
    builtIn: true,
    createdAt: new Date(now.getTime() - 30 * DAY_MS),
  }).run();
  await db.insert(guardrailRules).values({
    id: "gr_demo_internal",
    tenantId,
    name: "Block internal URLs",
    type: "regex",
    target: "output",
    action: "block",
    pattern: "https?://internal\\.demo\\.",
    enabled: true,
    builtIn: false,
    createdAt: new Date(now.getTime() - 14 * DAY_MS),
  }).run();
  await db.insert(guardrailLogs).values({
    id: "gl_demo_1",
    requestId: "req_demo_5",
    tenantId,
    ruleId: "gr_demo_pii",
    ruleName: "Built-in PII redaction",
    target: "input",
    action: "redact",
    matchedContent: "[email redacted]",
    createdAt: new Date(now.getTime() - 1 * DAY_MS),
  }).run();
  await db.insert(guardrailLogs).values({
    id: "gl_demo_2",
    requestId: "req_demo_37",
    tenantId,
    ruleId: "gr_demo_internal",
    ruleName: "Block internal URLs",
    target: "output",
    action: "block",
    matchedContent: "https://internal.demo.example/admin",
    createdAt: new Date(now.getTime() - 4 * DAY_MS),
  }).run();

  // 17. Pending team invite
  await db.insert(teamInvites).values({
    token: "inv_demo_pending_carol",
    tenantId,
    invitedEmail: "carol@demo.provara.xyz",
    invitedRole: "developer",
    invitedByUserId: "u_demo_visitor",
    expiresAt: new Date(now.getTime() + 5 * DAY_MS),
    consumedAt: null,
    consumedByUserId: null,
    createdAt: new Date(now.getTime() - 2 * DAY_MS),
  }).run();

  // 18. Custom provider
  await db.insert(customProviders).values({
    id: "cp_demo_together",
    name: "together-ai",
    baseURL: "https://api.together.xyz/v1",
    apiKeyRef: "TOGETHER_API_KEY",
    models: JSON.stringify(["meta-llama/Llama-3.3-70B-Instruct-Turbo"]),
    enabled: true,
    tenantId,
    createdAt: new Date(now.getTime() - 21 * DAY_MS),
  }).run();

  // 19. Context Optimizer visibility — enough recent rows for the
  //     dashboard to show savings, duplicate drops, and source IDs.
  const contextEvents = [
    {
      id: "coe_demo_support_docs",
      inputChunks: 18,
      outputChunks: 11,
      droppedChunks: 7,
      inputTokens: 12480,
      outputTokens: 8380,
      savedTokens: 4100,
      reductionPct: 32.85,
      duplicateSourceIds: ["refunds.md#4", "refunds-copy.md#1", "billing-faq#9", "billing-faq#10", "help-center#22", "help-center#23"],
      riskScanned: true,
      flaggedChunks: 0,
      quarantinedChunks: 1,
      riskySourceIds: ["community-snippet#17"],
      riskDetails: [
        {
          id: "community-snippet#17",
          decision: "quarantine",
          ruleName: "Jailbreak — instruction override",
          matchedContent: "ignore previous instructions",
        },
      ],
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    },
    {
      id: "coe_demo_policy_search",
      inputChunks: 14,
      outputChunks: 10,
      droppedChunks: 4,
      inputTokens: 9680,
      outputTokens: 7030,
      savedTokens: 2650,
      reductionPct: 27.38,
      duplicateSourceIds: ["security-policy#2", "security-policy#8", "sso-runbook#5", "sso-runbook#6"],
      riskScanned: true,
      flaggedChunks: 1,
      quarantinedChunks: 0,
      riskySourceIds: ["partner-note#3"],
      riskDetails: [
        {
          id: "partner-note#3",
          decision: "flag",
          ruleName: "Generic API Key/Secret",
          matchedContent: "secret access",
        },
      ],
      createdAt: new Date(now.getTime() - 8 * 60 * 60 * 1000),
    },
    {
      id: "coe_demo_agent_runbook",
      inputChunks: 22,
      outputChunks: 15,
      droppedChunks: 7,
      inputTokens: 15220,
      outputTokens: 10690,
      savedTokens: 4530,
      reductionPct: 29.76,
      duplicateSourceIds: ["agent-runbook#11", "agent-runbook#12", "tool-calls#4", "tool-calls#7", "handoff#2", "handoff#3", "handoff#4"],
      riskScanned: true,
      flaggedChunks: 0,
      quarantinedChunks: 0,
      riskySourceIds: [],
      riskDetails: [],
      createdAt: new Date(now.getTime() - 1 * DAY_MS),
    },
    {
      id: "coe_demo_onboarding",
      inputChunks: 9,
      outputChunks: 8,
      droppedChunks: 1,
      inputTokens: 5220,
      outputTokens: 4700,
      savedTokens: 520,
      reductionPct: 9.96,
      duplicateSourceIds: ["onboarding#14"],
      riskScanned: false,
      flaggedChunks: 0,
      quarantinedChunks: 0,
      riskySourceIds: [],
      riskDetails: [],
      createdAt: new Date(now.getTime() - 3 * DAY_MS),
    },
  ];
  for (const event of contextEvents) {
    await db.insert(contextOptimizationEvents).values({
      id: event.id,
      tenantId,
      inputChunks: event.inputChunks,
      outputChunks: event.outputChunks,
      droppedChunks: event.droppedChunks,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      savedTokens: event.savedTokens,
      reductionPct: event.reductionPct,
      duplicateSourceIds: JSON.stringify(event.duplicateSourceIds),
      riskScanned: event.riskScanned,
      flaggedChunks: event.flaggedChunks,
      quarantinedChunks: event.quarantinedChunks,
      riskySourceIds: JSON.stringify(event.riskySourceIds),
      riskDetails: JSON.stringify(event.riskDetails),
      createdAt: event.createdAt,
    }).run();
  }
}

/** Wipe every row scoped to the demo tenant. Order matters where FKs apply. */
async function wipe(db: Db, tenantId: string): Promise<void> {
  await db.delete(guardrailLogs).where(eq(guardrailLogs.tenantId, tenantId)).run();
  await db.delete(guardrailRules).where(eq(guardrailRules.tenantId, tenantId)).run();
  await db.delete(alertLogs).where(eq(alertLogs.ruleId, "ar_demo_spend")).run();
  await db.delete(alertLogs).where(eq(alertLogs.ruleId, "ar_demo_latency")).run();
  await db.delete(alertRules).where(eq(alertRules.tenantId, tenantId)).run();
  await db.delete(abTestVariants).where(eq(abTestVariants.abTestId, "ab_demo_1")).run();
  await db.delete(abTests).where(eq(abTests.tenantId, tenantId)).run();
  await db.delete(promptVersions).where(eq(promptVersions.templateId, "pt_demo_support")).run();
  await db.delete(promptTemplates).where(eq(promptTemplates.tenantId, tenantId)).run();
  await db.delete(costLogs).where(eq(costLogs.tenantId, tenantId)).run();
  await db.delete(feedback).where(eq(feedback.tenantId, tenantId)).run();
  await db.delete(replayBank).where(eq(replayBank.tenantId, tenantId)).run();
  await db.delete(regressionEvents).where(eq(regressionEvents.tenantId, tenantId)).run();
  await db.delete(requests).where(eq(requests.tenantId, tenantId)).run();
  await db.delete(modelScores).where(eq(modelScores.tenantId, tenantId)).run();
  await db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId)).run();
  await db.delete(routingWeightSnapshots).where(eq(routingWeightSnapshots.tenantId, tenantId)).run();
  await db.delete(spendBudgets).where(eq(spendBudgets.tenantId, tenantId)).run();
  await db.delete(costMigrations).where(eq(costMigrations.tenantId, tenantId)).run();
  await db.delete(contextOptimizationEvents).where(eq(contextOptimizationEvents.tenantId, tenantId)).run();
  await db.delete(customProviders).where(eq(customProviders.tenantId, tenantId)).run();
  await db.delete(teamInvites).where(eq(teamInvites.tenantId, tenantId)).run();
  await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId)).run();
  await db.delete(apiTokens).where(eq(apiTokens.tenant, tenantId)).run();
  await db.delete(subscriptions).where(eq(subscriptions.tenantId, tenantId)).run();
  for (const uid of DEMO_USER_IDS) {
    await db.delete(sessions).where(eq(sessions.userId, uid)).run();
  }
  await db.delete(users).where(eq(users.tenantId, tenantId)).run();
}
