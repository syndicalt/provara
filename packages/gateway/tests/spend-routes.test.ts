import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Db } from "@provara/db";
import { apiTokens, costLogs, feedback, requests, users } from "@provara/db";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";

vi.mock("../src/auth/admin.js", () => ({
  getAuthUser: (req: Request) => {
    const h = req.headers.get("x-test-user");
    if (!h) return null;
    const [id, tenantId, role] = h.split(":");
    return { id, tenantId, role: role as "owner" | "member" };
  },
}));

import { createSpendRoutes } from "../src/routes/spend.js";

function buildApp(db: Db) {
  const app = new Hono();
  app.route("/v1/spend", createSpendRoutes(db));
  return app;
}

function authHeader(u: { id: string; tenantId: string; role: "owner" | "member" }) {
  return `${u.id}:${u.tenantId}:${u.role}`;
}

async function seedOwner(
  db: Db,
  tenantId: string,
  tier?: "pro" | "team" | "enterprise",
) {
  await db.insert(users).values({
    id: `owner-${tenantId}`,
    email: `owner@${tenantId}.example.com`,
    tenantId,
    role: "owner",
    createdAt: new Date(),
  }).run();
  if (tier) await grantIntelligenceAccess(db, tenantId, { tier });
  return { id: `owner-${tenantId}`, tenantId, role: "owner" as const };
}

interface SeedOpts {
  tenantId: string;
  provider: string;
  model: string;
  taskType?: string;
  complexity?: string;
  userId?: string | null;
  apiTokenId?: string | null;
  cost: number;
  createdAt?: Date;
  judgeScore?: number; // 1..5 — if set, writes a feedback row with source=judge
}

async function seedRequestAndCost(db: Db, id: string, opts: SeedOpts) {
  // Default to 1 minute ago so rows fall inside the default 30-day
  // window even when the test and the query hit the same millisecond.
  const ts = opts.createdAt ?? new Date(Date.now() - 60_000);
  await db.insert(requests).values({
    id,
    provider: opts.provider,
    model: opts.model,
    prompt: "[]",
    taskType: opts.taskType,
    complexity: opts.complexity,
    tenantId: opts.tenantId,
    userId: opts.userId ?? null,
    apiTokenId: opts.apiTokenId ?? null,
    createdAt: ts,
  }).run();
  await db.insert(costLogs).values({
    id: `cl-${id}`,
    requestId: id,
    tenantId: opts.tenantId,
    provider: opts.provider,
    model: opts.model,
    inputTokens: 100,
    outputTokens: 100,
    cost: opts.cost,
    userId: opts.userId ?? null,
    apiTokenId: opts.apiTokenId ?? null,
    createdAt: ts,
  }).run();
  if (opts.judgeScore) {
    await db.insert(feedback).values({
      id: `fb-${id}`,
      requestId: id,
      tenantId: opts.tenantId,
      score: opts.judgeScore,
      source: "judge",
      createdAt: ts,
    }).run();
  }
}

describe("GET /v1/spend/by (#219/T3)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });
  afterEach(() => resetTierEnv());

  it("returns 401 without auth", async () => {
    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=provider");
    expect(res.status).toBe(401);
  });

  it("returns 400 on an invalid dim", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=bogus", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(400);
  });

  it("gates dim=provider behind Team+ (Pro gets 402)", async () => {
    const owner = await seedOwner(db, "t-pro", "pro");
    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=provider", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(402);
  });

  it("gates dim=user behind Enterprise (Team gets 402)", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=user", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(402);
  });

  it("aggregates by provider with quality envelope", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    const now = new Date();
    const recent = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await seedRequestAndCost(db, "r1", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", cost: 0.10, judgeScore: 5, createdAt: recent });
    await seedRequestAndCost(db, "r2", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", cost: 0.20, judgeScore: 4, createdAt: recent });
    await seedRequestAndCost(db, "r3", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", cost: 0.30, createdAt: recent });
    await seedRequestAndCost(db, "r4", { tenantId: "t-team", provider: "anthropic", model: "claude-sonnet-4-6", cost: 1.00, judgeScore: 3, createdAt: recent });

    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=provider", {
      headers: { "x-test-user": authHeader(owner) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dim).toBe("provider");
    // Sorted by cost_usd DESC: anthropic $1.00, openai $0.60
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ key: "anthropic", cost_usd: 1, requests: 1, judged_requests: 1, quality_median: 3 });
    expect(body.rows[1]).toMatchObject({ key: "openai", cost_usd: 0.6, requests: 3, judged_requests: 2 });
    // Linear-interpolation median of [4,5] = 4.5
    expect(body.rows[1].quality_median).toBe(4.5);
    expect(body.rows[1].cost_per_quality_point).toBeCloseTo(0.6 / 4.5, 5);
  });

  it("isolates spend across tenants", async () => {
    const ownerA = await seedOwner(db, "t-a", "team");
    await seedOwner(db, "t-b", "team");
    await seedRequestAndCost(db, "rA", { tenantId: "t-a", provider: "openai", model: "gpt-4.1-nano", cost: 0.5 });
    await seedRequestAndCost(db, "rB", { tenantId: "t-b", provider: "openai", model: "gpt-4.1-nano", cost: 99.0 });

    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=provider", {
      headers: { "x-test-user": authHeader(ownerA) },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].cost_usd).toBe(0.5);
  });

  it("computes period comparison (compare=prior)", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    const now = new Date();
    // Current window: last 30 days. Prior: 30 before that.
    const inCurrent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const inPrior = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

    await seedRequestAndCost(db, "c1", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", cost: 1.50, createdAt: inCurrent });
    await seedRequestAndCost(db, "p1", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", cost: 0.50, createdAt: inPrior });

    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=provider", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      key: "openai",
      cost_usd: 1.5,
      delta_usd: 1,
      delta_pct: 2, // (1.5 - 0.5) / 0.5
    });
    expect(body.compare_period).not.toBeNull();
    expect(body.compare_period.mode).toBe("prior");
  });

  it("resolves user labels to email and handles deleted users", async () => {
    const owner = await seedOwner(db, "t-ent", "enterprise");
    await db.insert(users).values({
      id: "u_alice",
      email: "alice@t-ent.example.com",
      tenantId: "t-ent",
      role: "member",
      createdAt: new Date(),
    }).run();

    await seedRequestAndCost(db, "u1", { tenantId: "t-ent", provider: "openai", model: "gpt-4.1-nano", userId: "u_alice", cost: 1.0 });
    await seedRequestAndCost(db, "u2", { tenantId: "t-ent", provider: "openai", model: "gpt-4.1-nano", userId: "u_deleted_1234567890", cost: 2.0 });

    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=user", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    const byKey = Object.fromEntries(body.rows.map((r: any) => [r.key, r.label]));
    expect(byKey["u_alice"]).toBe("alice@t-ent.example.com");
    expect(byKey["u_deleted_1234567890"]).toMatch(/^Unknown user \(/);
  });

  it("aggregates by category returning structured task_type/complexity", async () => {
    const owner = await seedOwner(db, "t-team", "team");
    await seedRequestAndCost(db, "k1", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", taskType: "coding", complexity: "hard", cost: 3.0 });
    await seedRequestAndCost(db, "k2", { tenantId: "t-team", provider: "openai", model: "gpt-4.1-nano", taskType: "coding", complexity: "easy", cost: 0.5 });

    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=category", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    const hard = body.rows.find((r: any) => r.key === "coding+hard");
    expect(hard).toMatchObject({ task_type: "coding", complexity: "hard", cost_usd: 3 });
  });

  it("aggregates by token with label from apiTokens.name", async () => {
    const owner = await seedOwner(db, "t-ent", "enterprise");
    await db.insert(apiTokens).values({
      id: "tok_prod",
      name: "Production ingest",
      tenant: "t-ent",
      hashedToken: "h_prod",
      tokenPrefix: "pvra_abc",
      enabled: true,
      createdAt: new Date(),
    }).run();
    await seedRequestAndCost(db, "t1", { tenantId: "t-ent", provider: "openai", model: "gpt-4.1-nano", apiTokenId: "tok_prod", cost: 2.0 });

    const app = buildApp(db);
    const res = await app.request("/v1/spend/by?dim=token", {
      headers: { "x-test-user": authHeader(owner) },
    });
    const body = await res.json();
    expect(body.rows[0]).toMatchObject({ key: "tok_prod", label: "Production ingest", cost_usd: 2 });
  });
});
