import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createAlertRoutes } from "../src/routes/alerts.js";
import { makeTestDb } from "./_setup/db.js";

async function buildApp() {
  const db = await makeTestDb();
  const app = new Hono();
  app.route("/v1/admin/alerts", createAlertRoutes(db));
  return app;
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
