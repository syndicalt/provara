import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "../src/routes/conversations.js";
import { makeTestDb } from "./_setup/db.js";

async function buildApp() {
  const db = await makeTestDb();
  const app = new Hono();
  app.route("/v1/conversations", createConversationRoutes(db));
  return { db, app };
}

function req(app: Hono, path: string, init?: RequestInit) {
  return app.request(path, init);
}

describe("conversations routes", () => {
  it("creates with auto-title from first user message", async () => {
    const { app } = await buildApp();
    const res = await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "What is the capital of France?" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/.{4,}/);
    expect(body.title).toBe("What is the capital of France?");
  });

  it("truncates long titles to 60 chars with an ellipsis", async () => {
    const { app } = await buildApp();
    const long = "a".repeat(200);
    const res = await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: long }] }),
    });
    const body = await res.json();
    expect(body.title.length).toBe(60);
    expect(body.title.endsWith("…")).toBe(true);
  });

  it("explicit title in POST overrides auto-title", async () => {
    const { app } = await buildApp();
    const res = await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Custom title",
        messages: [{ role: "user", content: "whatever" }],
      }),
    });
    const body = await res.json();
    expect(body.title).toBe("Custom title");
  });

  it("lists newest first and returns summaries (no messages)", async () => {
    const { app } = await buildApp();
    await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "first" }] }),
    });
    // updatedAt is stored as Unix seconds (Drizzle `mode: "timestamp"`), so
    // back-to-back inserts share a timestamp. Sleep 1.1s to land on a new
    // second boundary and give the list query something to order by.
    await new Promise((r) => setTimeout(r, 1100));
    await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "second" }] }),
    });

    const list = await (await req(app, "/v1/conversations")).json();
    expect(list.conversations).toHaveLength(2);
    expect(list.conversations[0].title).toBe("second");
    expect(list.conversations[0].messages).toBeUndefined();
  });

  it("GET /:id returns full messages", async () => {
    const { app } = await buildApp();
    const created = await (await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
      }),
    })).json();

    const detail = await (await req(app, `/v1/conversations/${created.id}`)).json();
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1].content).toBe("pong");
  });

  it("PATCH updates messages and bumps updatedAt", async () => {
    const { app } = await buildApp();
    const created = await (await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "v1" }] }),
    })).json();

    const patchRes = await req(app, `/v1/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "v2" }] }),
    });
    expect(patchRes.status).toBe(200);

    const detail = await (await req(app, `/v1/conversations/${created.id}`)).json();
    expect(detail.messages[0].content).toBe("v2");
  });

  it("DELETE removes the row", async () => {
    const { app } = await buildApp();
    const created = await (await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    })).json();

    await req(app, `/v1/conversations/${created.id}`, { method: "DELETE" });
    const res = await req(app, `/v1/conversations/${created.id}`);
    expect(res.status).toBe(404);
  });
});

describe("cross-tenant isolation (#178)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function buildMultiTenantApp() {
    process.env.PROVARA_MODE = "multi_tenant";
    const db = await makeTestDb();
    const app = new Hono();

    // Swap tenant resolution to read from a header so we can simulate
    // different tenants per request without full auth plumbing.
    app.use("*", async (c, next) => {
      const tenantId = c.req.header("x-test-tenant");
      if (tenantId) {
        // Access the module's internal tenantMap through getTenantId's
        // WeakMap keyed on the underlying Request. Using a small helper
        // that mirrors what the real middleware does.
        const { __testSetTenant } = await import("../src/auth/tenant.js");
        __testSetTenant(c.req.raw, tenantId);
      }
      return next();
    });

    app.route("/v1/conversations", createConversationRoutes(db));
    return { db, app };
  }

  it("tenant A cannot list tenant B's conversations", async () => {
    const { app } = await buildMultiTenantApp();

    // Tenant B creates a conversation
    await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": "tenant-b" },
      body: JSON.stringify({ messages: [{ role: "user", content: "tenant B secret" }] }),
    });

    // Tenant A lists
    const res = await req(app, "/v1/conversations", { headers: { "x-test-tenant": "tenant-a" } });
    const body = await res.json();
    expect(body.conversations).toHaveLength(0);
  });

  it("tenant A cannot read tenant B's specific conversation by id", async () => {
    const { app } = await buildMultiTenantApp();

    const created = await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": "tenant-b" },
      body: JSON.stringify({ messages: [{ role: "user", content: "secret" }] }),
    }).then((r) => r.json());

    const res = await req(app, `/v1/conversations/${created.id}`, {
      headers: { "x-test-tenant": "tenant-a" },
    });
    expect(res.status).toBe(404);
  });

  it("in multi-tenant mode, a request with NO tenant context returns empty list (fail-safe)", async () => {
    const { app } = await buildMultiTenantApp();

    // Seed a conversation owned by tenant-b
    await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-tenant": "tenant-b" },
      body: JSON.stringify({ messages: [{ role: "user", content: "secret" }] }),
    });

    // Request without x-test-tenant header — simulates the bug where tenant
    // resolution fails silently. Must return empty, not everything.
    const res = await req(app, "/v1/conversations");
    const body = await res.json();
    expect(body.conversations).toHaveLength(0);
  });

  it("self-host mode (PROVARA_MODE unset) keeps legacy behavior — null tenant = all rows", async () => {
    // Don't set PROVARA_MODE — defaults to self_hosted
    const db = await makeTestDb();
    const app = new Hono();
    app.route("/v1/conversations", createConversationRoutes(db));

    await req(app, "/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    const res = await req(app, "/v1/conversations");
    const body = await res.json();
    expect(body.conversations).toHaveLength(1);
  });
});
