import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Db } from "@provara/db";
import { optimizeContextChunks } from "../src/context/optimizer.js";
import { createContextRoutes } from "../src/routes/context.js";
import { makeTestDb } from "./_setup/db.js";
import { grantIntelligenceAccess, resetTierEnv } from "./_setup/tier.js";

vi.mock("../src/auth/tenant.js", () => ({
  getTenantId: (req: Request) => req.headers.get("x-test-tenant"),
}));

import { requireIntelligenceTier } from "../src/auth/tier.js";

function buildApp(db: Db) {
  const app = new Hono();
  app.use("/v1/context/*", requireIntelligenceTier(db));
  app.route("/v1/context", createContextRoutes());
  return app;
}

describe("context optimizer core", () => {
  it("drops exact duplicate chunks and reports token savings", () => {
    const result = optimizeContextChunks([
      {
        id: "chunk-1",
        content: "Refunds are available within 30 days.",
        source: "help-center",
        metadata: { url: "https://example.com/refunds" },
      },
      {
        id: "chunk-2",
        content: "  refunds are available within 30 days.  ",
        source: "help-center-copy",
      },
      {
        id: "chunk-3",
        content: "Enterprise plans include audit logs.",
        source: "pricing",
      },
    ]);

    expect(result.optimized).toHaveLength(2);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        id: "chunk-2",
        reason: "duplicate",
        duplicateOf: "chunk-1",
      }),
    ]);
    expect(result.optimized[0]).toMatchObject({
      id: "chunk-1",
      sourceIds: ["chunk-1", "chunk-2"],
      source: "help-center",
      metadata: { url: "https://example.com/refunds" },
    });
    expect(result.metrics.inputChunks).toBe(3);
    expect(result.metrics.outputChunks).toBe(2);
    expect(result.metrics.savedTokens).toBeGreaterThan(0);
    expect(result.metrics.reductionPct).toBeGreaterThan(0);
  });
});

describe("POST /v1/context/optimize", () => {
  let db: Db;

  beforeEach(async () => {
    db = await makeTestDb();
    resetTierEnv();
  });

  afterEach(() => {
    resetTierEnv();
  });

  it("requires Intelligence access", async () => {
    process.env.PROVARA_CLOUD = "true";
    const app = buildApp(db);

    const res = await app.request("/v1/context/optimize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-tenant": "tenant-free",
      },
      body: JSON.stringify({
        chunks: [{ id: "a", content: "alpha" }],
      }),
    });

    expect(res.status).toBe(402);
    const body = await res.json() as { gate: { reason: string } };
    expect(body.gate.reason).toBe("no_subscription");
  });

  it("returns an optimization report for paid tenants", async () => {
    process.env.PROVARA_CLOUD = "true";
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro" });
    const app = buildApp(db);

    const res = await app.request("/v1/context/optimize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-tenant": "tenant-pro",
      },
      body: JSON.stringify({
        chunks: [
          { id: "a", content: "Context A", metadata: { doc: "one" } },
          { id: "b", content: "context a" },
          { id: "c", content: "Context C" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      optimization: {
        optimized: Array<{ id: string; sourceIds: string[]; metadata?: Record<string, unknown> }>;
        dropped: Array<{ id: string; duplicateOf: string }>;
        metrics: { inputChunks: number; outputChunks: number; droppedChunks: number };
      };
    };
    expect(body.optimization.optimized).toHaveLength(2);
    expect(body.optimization.optimized[0]).toMatchObject({
      id: "a",
      sourceIds: ["a", "b"],
      metadata: { doc: "one" },
    });
    expect(body.optimization.dropped).toEqual([{ id: "b", reason: "duplicate", duplicateOf: "a", inputTokens: 3 }]);
    expect(body.optimization.metrics).toMatchObject({
      inputChunks: 3,
      outputChunks: 2,
      droppedChunks: 1,
    });
  });

  it("validates chunks", async () => {
    process.env.PROVARA_CLOUD = "true";
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro" });
    const app = buildApp(db);

    const res = await app.request("/v1/context/optimize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-tenant": "tenant-pro",
      },
      body: JSON.stringify({ chunks: [{ id: "missing-content" }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("validation_error");
    expect(body.error.message).toContain("content is required");
  });

  it("rejects malformed JSON", async () => {
    process.env.PROVARA_CLOUD = "true";
    await grantIntelligenceAccess(db, "tenant-pro", { tier: "pro" });
    const app = buildApp(db);

    const res = await app.request("/v1/context/optimize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-tenant": "tenant-pro",
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error).toEqual({
      type: "validation_error",
      message: "Invalid JSON body",
    });
  });
});
