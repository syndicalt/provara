import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { alertLogs, alertRules, contextCanonicalBlocks, contextCanonicalReviewEvents, contextCollections } from "@provara/db";
import { eq } from "drizzle-orm";
import { createAlertRoutes } from "../src/routes/alerts.js";
import { makeTestDb } from "./_setup/db.js";

async function buildApp() {
  const db = await makeTestDb();
  const app = new Hono();
  app.route("/v1/admin/alerts", createAlertRoutes(db));
  return app;
}

async function buildFixture() {
  const db = await makeTestDb();
  const app = new Hono();
  app.route("/v1/admin/alerts", createAlertRoutes(db));
  return { app, db };
}

function postRule(app: Hono, body: unknown) {
  return app.request("/v1/admin/alerts/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("alert webhook URL validation (SSRF guard)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  beforeEach(() => {
    delete process.env.PROVARA_ALLOW_HTTP_WEBHOOKS;
  });

  const baseRule = { name: "r", metric: "spend", threshold: 1, window: "1h" };

  it("accepts https URL on public host", async () => {
    const app = await buildApp();
    const res = await postRule(app, { ...baseRule, webhookUrl: "https://hooks.slack.com/services/x" });
    expect(res.status).toBe(201);
  });

  it("rejects http URL by default", async () => {
    const app = await buildApp();
    const res = await postRule(app, { ...baseRule, webhookUrl: "http://example.com/hook" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/https/i);
  });

  it("allows http when PROVARA_ALLOW_HTTP_WEBHOOKS=true (for local dev)", async () => {
    process.env.PROVARA_ALLOW_HTTP_WEBHOOKS = "true";
    const app = await buildApp();
    const res = await postRule(app, { ...baseRule, webhookUrl: "http://example.com/hook" });
    expect(res.status).toBe(201);
  });

  it("rejects cloud metadata endpoints", async () => {
    const app = await buildApp();
    for (const host of ["169.254.169.254", "metadata.google.internal", "100.100.100.200"]) {
      const res = await postRule(app, { ...baseRule, webhookUrl: `https://${host}/x` });
      expect(res.status, `should reject ${host}`).toBe(400);
    }
  });

  it("rejects loopback and private ranges", async () => {
    const app = await buildApp();
    const privates = [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.16.0.1/x",
      "https://172.31.255.255/x",
    ];
    for (const url of privates) {
      const res = await postRule(app, { ...baseRule, webhookUrl: url });
      expect(res.status, `should reject ${url}`).toBe(400);
    }
  });

  it("rejects malformed URL", async () => {
    const app = await buildApp();
    const res = await postRule(app, { ...baseRule, webhookUrl: "not a url" });
    expect(res.status).toBe(400);
  });

  it("permits omitting webhookUrl entirely", async () => {
    const app = await buildApp();
    const res = await postRule(app, baseRule);
    expect(res.status).toBe(201);
  });
});

describe("context governance alerts", () => {
  it("provisions default context governance alert rules in alert management", async () => {
    const { app, db } = await buildFixture();
    const res = await app.request("/v1/admin/alerts/rules");
    expect(res.status).toBe(200);
    const body = await res.json() as { rules: Array<{ name: string; metric: string; threshold: number; window: string }> };
    expect(body.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Context policy failures", metric: "context_policy_failures", threshold: 0 }),
      expect.objectContaining({ name: "Stale canonical review queue", metric: "context_stale_drafts", window: "24h" }),
      expect.objectContaining({ name: "Approved context export change", metric: "context_approved_export_delta" }),
    ]));
    expect(await db.select().from(alertRules).all()).toHaveLength(3);
  });

  it("evaluates stale canonical draft queues into alert history", async () => {
    const { app, db } = await buildFixture();
    const now = new Date();
    const stale = new Date(now.getTime() - 48 * 3600_000);
    await db.insert(contextCollections).values({
      id: "collection-stale",
      tenantId: null,
      name: "Stale KB",
      description: null,
      status: "active",
      documentCount: 0,
      blockCount: 0,
      canonicalBlockCount: 1,
      approvedBlockCount: 0,
      tokenCount: 0,
      createdAt: stale,
      updatedAt: stale,
    }).run();
    await db.insert(contextCanonicalBlocks).values({
      id: "canonical-stale",
      tenantId: null,
      collectionId: "collection-stale",
      content: "Stale draft knowledge.",
      contentHash: "hash-stale",
      tokenCount: 4,
      sourceBlockIds: "[]",
      sourceDocumentIds: "[]",
      sourceCount: 0,
      reviewStatus: "draft",
      policyStatus: "passed",
      policyDetails: "[]",
      metadata: "{}",
      createdAt: stale,
      updatedAt: stale,
    }).run();

    const res = await app.request("/v1/admin/alerts/evaluate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { fired: string[] };
    expect(body.fired).toContain("Stale canonical review queue");

    const alerts = await db.select().from(alertLogs).all();
    expect(alerts).toEqual([
      expect.objectContaining({
        ruleName: "Stale canonical review queue",
        metric: "context_stale_drafts",
        value: 1,
        threshold: 0,
      }),
    ]);
  });

  it("evaluates approved context export deltas into alert history", async () => {
    const { app, db } = await buildFixture();
    await app.request("/v1/admin/alerts/rules");
    const deltaRule = await db.select().from(alertRules).where(eq(alertRules.metric, "context_approved_export_delta")).get();
    expect(deltaRule).toBeTruthy();
    await db.update(alertRules).set({ threshold: 1 }).where(eq(alertRules.id, deltaRule!.id)).run();

    const now = new Date();
    await db.insert(contextCollections).values({
      id: "collection-approved-delta",
      tenantId: null,
      name: "Approved Delta KB",
      description: null,
      status: "active",
      documentCount: 0,
      blockCount: 0,
      canonicalBlockCount: 2,
      approvedBlockCount: 2,
      tokenCount: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(contextCanonicalBlocks).values([
      {
        id: "canonical-approved-1",
        tenantId: null,
        collectionId: "collection-approved-delta",
        content: "Approved knowledge one.",
        contentHash: "hash-approved-1",
        tokenCount: 3,
        sourceBlockIds: "[]",
        sourceDocumentIds: "[]",
        sourceCount: 0,
        reviewStatus: "approved",
        policyStatus: "passed",
        policyDetails: "[]",
        metadata: "{}",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "canonical-approved-2",
        tenantId: null,
        collectionId: "collection-approved-delta",
        content: "Approved knowledge two.",
        contentHash: "hash-approved-2",
        tokenCount: 3,
        sourceBlockIds: "[]",
        sourceDocumentIds: "[]",
        sourceCount: 0,
        reviewStatus: "approved",
        policyStatus: "passed",
        policyDetails: "[]",
        metadata: "{}",
        createdAt: now,
        updatedAt: now,
      },
    ]).run();
    await db.insert(contextCanonicalReviewEvents).values([
      {
        id: "review-approved-1",
        tenantId: null,
        collectionId: "collection-approved-delta",
        canonicalBlockId: "canonical-approved-1",
        fromStatus: "draft",
        toStatus: "approved",
        note: null,
        actorUserId: null,
        createdAt: now,
      },
      {
        id: "review-approved-2",
        tenantId: null,
        collectionId: "collection-approved-delta",
        canonicalBlockId: "canonical-approved-2",
        fromStatus: "draft",
        toStatus: "approved",
        note: null,
        actorUserId: null,
        createdAt: now,
      },
    ]).run();

    const res = await app.request("/v1/admin/alerts/evaluate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { fired: string[] };
    expect(body.fired).toContain("Approved context export change");

    const alerts = await db.select().from(alertLogs).all();
    expect(alerts).toEqual([
      expect.objectContaining({
        ruleName: "Approved context export change",
        metric: "context_approved_export_delta",
        value: 2,
        threshold: 1,
      }),
    ]);
  });
});
