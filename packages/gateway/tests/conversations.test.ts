import { describe, it, expect } from "vitest";
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
