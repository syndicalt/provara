import type { Db } from "@provara/db";
import {
  apiKeys,
  apiTokens,
  auditLogs,
  costLogs,
  costMigrations,
  feedback,
  modelScores,
  regressionEvents,
  replayBank,
  requests,
  routingWeightSnapshots,
  sessions,
  spendBudgets,
  subscriptions,
  users,
} from "@provara/db";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

/**
 * Demo-tenant seed (#229). Wipes and reseeds `t_demo` with data that
 * exercises every narrative surface on the dashboard:
 *
 *   - Attribution: requests + cost_logs across 3 providers, 3 users,
 *     2 api tokens, 30 days of history
 *   - Quality envelope: ~30% of requests have judge feedback scores
 *   - Regression detection: one unresolved event on a specific cell
 *   - Auto cost migration: two completed migrations with savings
 *   - Spend intelligence: enough volume for trajectory + drift views
 *   - Budgets: monthly cap at 75% with the 50 + 75% thresholds fired
 *   - Audit log: a representative set of auth / admin events
 *   - Routing weight snapshots: one mid-window weight change so drift
 *     endpoint returns a non-empty events array
 *
 * Subscription is seeded as Enterprise tier (`includesIntelligence=true`)
 * so every gated feature — drift, recommendations, user/token
 * attribution — renders for the demo visitor.
 *
 * Idempotent: the function DELETEs all t_demo-scoped rows first, then
 * re-inserts from scratch. Running twice is a clean no-op in terms of
 * final state.
 *
 * This file is tiny on purpose — the numbers are coarse and obvious so
 * the demo data tells a clear story at a glance. A more "realistic"
 * seed would obscure the features we're trying to showcase.
 */

export const DEMO_TENANT_ID = "t_demo";
const DEMO_USER_IDS = ["u_demo_visitor", "u_demo_member_alice", "u_demo_member_bob"];
const DEMO_PROVIDERS = ["openai", "anthropic", "google"] as const;
const DEMO_MODELS: Record<(typeof DEMO_PROVIDERS)[number], string[]> = {
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"],
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  google: ["gemini-2.5-flash", "gemini-2.0-flash"],
};
const DEMO_CELLS = [
  { taskType: "coding", complexity: "complex" },
  { taskType: "coding", complexity: "medium" },
  { taskType: "qa", complexity: "simple" },
  { taskType: "creative", complexity: "medium" },
  { taskType: "general", complexity: "simple" },
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function reseedDemoTenant(db: Db, now: Date = new Date()): Promise<void> {
  const tenantId = DEMO_TENANT_ID;

  await wipe(db, tenantId);

  // 1. Users — a demo "visitor" who holds the session plus two team members
  //    to make per-user attribution interesting.
  for (const id of DEMO_USER_IDS) {
    await db.insert(users).values({
      id,
      email: `${id.replace("u_demo_", "")}@demo.provara.xyz`,
      name: id.replace("u_demo_", "").replace("_", " "),
      firstName: id.split("_")[2] ?? "Demo",
      lastName: "Demo",
      tenantId,
      role: id === "u_demo_visitor" ? "owner" : "member",
      createdAt: new Date(now.getTime() - 60 * DAY_MS),
    }).run();
  }

  // 2. Enterprise subscription so every tier-gated view unlocks.
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

  // 3. API tokens so per-token attribution has >1 key.
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

  // 4. Requests + cost_logs across 30 days. Rotate through cells,
  //    providers, users, tokens so every attribution dim has signal.
  const totalRequests = 200;
  const seenCosts: Record<string, number> = {};
  for (let i = 0; i < totalRequests; i++) {
    const cell = DEMO_CELLS[i % DEMO_CELLS.length];
    const provider = DEMO_PROVIDERS[i % DEMO_PROVIDERS.length];
    const model = DEMO_MODELS[provider][i % DEMO_MODELS[provider].length];
    const user = DEMO_USER_IDS[i % DEMO_USER_IDS.length];
    const apiTokenId = i % 2 === 0 ? tokenProd : tokenStaging;
    const dayOffset = Math.floor((i / totalRequests) * 30);
    const createdAt = new Date(now.getTime() - (30 - dayOffset) * DAY_MS + (i % 24) * 60 * 60 * 1000);
    const inputTokens = 400 + (i * 37) % 800;
    const outputTokens = 200 + (i * 53) % 600;
    const cost = Number(((inputTokens * 0.0000025) + (outputTokens * 0.00001)).toFixed(6));
    seenCosts[provider] = (seenCosts[provider] ?? 0) + cost;

    const reqId = `req_demo_${i}`;
    await db.insert(requests).values({
      id: reqId,
      provider,
      model,
      prompt: JSON.stringify([{ role: "user", content: `demo prompt ${i}` }]),
      response: `demo response ${i}`,
      inputTokens,
      outputTokens,
      latencyMs: 300 + (i * 11) % 1400,
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
      id: `cl_demo_${i}`,
      requestId: reqId,
      tenantId,
      provider,
      model,
      inputTokens,
      outputTokens,
      cost,
      userId: user,
      apiTokenId,
      createdAt,
    }).run();

    // Judge feedback on ~30% of requests, scores 2-5, weighted toward
    // good. One cell gets systematically low scores to support the
    // regression-detection narrative below.
    if (i % 3 === 0) {
      const isRegressingCell = cell.taskType === "coding" && cell.complexity === "complex";
      const score = isRegressingCell && i % 6 === 0 ? 2 : Math.min(5, 3 + (i % 3));
      await db.insert(feedback).values({
        id: `fb_demo_${i}`,
        requestId: reqId,
        tenantId,
        score,
        comment: null,
        source: "judge",
        createdAt,
      }).run();
    }
  }

  // 5. Model scores: EMA-ish values so the adaptive matrix renders with
  //    plausible winners per cell.
  const scoreRows: Array<{
    taskType: string; complexity: string; provider: string; model: string; qualityScore: number; sampleCount: number;
  }> = [
    { taskType: "coding", complexity: "complex", provider: "anthropic", model: "claude-sonnet-4-6", qualityScore: 0.86, sampleCount: 42 },
    { taskType: "coding", complexity: "complex", provider: "openai", model: "gpt-4.1", qualityScore: 0.81, sampleCount: 38 },
    { taskType: "coding", complexity: "complex", provider: "openai", model: "gpt-4.1-mini", qualityScore: 0.72, sampleCount: 36 },
    { taskType: "coding", complexity: "medium", provider: "openai", model: "gpt-4.1-mini", qualityScore: 0.82, sampleCount: 55 },
    { taskType: "coding", complexity: "medium", provider: "anthropic", model: "claude-haiku-4-5-20251001", qualityScore: 0.79, sampleCount: 48 },
    { taskType: "qa", complexity: "simple", provider: "openai", model: "gpt-4.1-nano", qualityScore: 0.88, sampleCount: 70 },
    { taskType: "qa", complexity: "simple", provider: "google", model: "gemini-2.0-flash", qualityScore: 0.86, sampleCount: 62 },
    { taskType: "creative", complexity: "medium", provider: "anthropic", model: "claude-sonnet-4-6", qualityScore: 0.91, sampleCount: 40 },
    { taskType: "general", complexity: "simple", provider: "openai", model: "gpt-4.1-nano", qualityScore: 0.83, sampleCount: 65 },
    { taskType: "general", complexity: "simple", provider: "google", model: "gemini-2.5-flash", qualityScore: 0.80, sampleCount: 58 },
  ];
  for (const row of scoreRows) {
    await db.insert(modelScores).values({
      tenantId,
      ...row,
      updatedAt: new Date(now.getTime() - (7 * DAY_MS)),
    }).run();
  }

  // 6. Replay bank entries so the judge narrative has something to
  //    show in the dashboard.
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

  // 7. Regression event — one unresolved, on the cell we gave bad
  //    judge scores to above.
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

  // 8. Cost migrations — two active with reported savings.
  await db.insert(costMigrations).values({
    id: "cm_demo_1",
    tenantId,
    taskType: "qa",
    complexity: "simple",
    fromProvider: "openai",
    fromModel: "gpt-4.1",
    fromCostPer1M: 8,
    fromQualityScore: 0.88,
    toProvider: "openai",
    toModel: "gpt-4.1-nano",
    toCostPer1M: 0.5,
    toQualityScore: 0.86,
    projectedMonthlySavingsUsd: 28.5,
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
    projectedMonthlySavingsUsd: 14.7,
    graceEndsAt: new Date(now.getTime() - 4 * DAY_MS),
    executedAt: new Date(now.getTime() - 18 * DAY_MS),
    rolledBackAt: null,
    rollbackReason: null,
  }).run();

  // 9. Spend budget at 75% — enough to show the threshold alert fired
  //    without triggering the hard stop.
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

  // 10. Audit log — a representative set of events covering auth /
  //     admin / billing surfaces so the /dashboard/audit table has
  //     enough rows to feel real.
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

  // 11. Routing-weight snapshots with a mid-window change so the
  //     drift endpoint returns a non-empty event array.
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

  // 12. API key row so /dashboard/api-keys has something to render.
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
}

/** Wipe every row scoped to the demo tenant. Idempotent. */
async function wipe(db: Db, tenantId: string): Promise<void> {
  // Order matters: child tables first where an FK would complain.
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
  await db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId)).run();
  await db.delete(apiTokens).where(eq(apiTokens.tenant, tenantId)).run();
  await db.delete(subscriptions).where(eq(subscriptions.tenantId, tenantId)).run();
  // Delete sessions for demo users first (FK → users.id).
  for (const uid of DEMO_USER_IDS) {
    await db.delete(sessions).where(eq(sessions.userId, uid)).run();
  }
  await db.delete(users).where(eq(users.tenantId, tenantId)).run();
}
