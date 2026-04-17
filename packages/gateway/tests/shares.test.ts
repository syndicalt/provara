import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "../src/routes/conversations.js";
import { createShareHandlers } from "../src/routes/shares.js";
import { makeTestDb } from "./_setup/db.js";

async function buildApp() {
  const db = await makeTestDb();
  const app = new Hono();
  const shares = createShareHandlers(db);
  app.route("/v1/conversations", createConversationRoutes(db));
  app.post("/v1/conversations/:id/share", shares.create);
  app.get("/v1/shared/:token", shares.getPublic);
  app.delete("/v1/shares/:token", shares.revoke);
  return { db, app };
}

async function createConv(app: Hono) {
  const res = await app.request("/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "What is Provara?" },
        { role: "assistant", content: "A multi-provider LLM gateway." },
      ],
    }),
  });
  return (await res.json()) as { id: string };
}

describe("share links", () => {
  it("create → public read → revoke → read returns 404", async () => {
    const { app } = await buildApp();
    const { id } = await createConv(app);

    const shareRes = await app.request(`/v1/conversations/${id}/share`, { method: "POST" });
    expect(shareRes.status).toBe(201);
    const { token } = await shareRes.json();
    expect(token).toMatch(/^sh_/);

    // Public read
    const pubRes = await app.request(`/v1/shared/${token}`);
    expect(pubRes.status).toBe(200);
    const pub = await pubRes.json();
    expect(pub.title).toBe("What is Provara?");
    expect(pub.messages).toHaveLength(2);

    // Revoke
    const revokeRes = await app.request(`/v1/shares/${token}`, { method: "DELETE" });
    expect(revokeRes.status).toBe(200);

    // Post-revoke read
    const goneRes = await app.request(`/v1/shared/${token}`);
    expect(goneRes.status).toBe(404);
  });

  it("repeated POST returns the same active token (no orphan minting)", async () => {
    const { app } = await buildApp();
    const { id } = await createConv(app);

    const first = await (await app.request(`/v1/conversations/${id}/share`, { method: "POST" })).json();
    const second = await (await app.request(`/v1/conversations/${id}/share`, { method: "POST" })).json();
    expect(first.token).toBe(second.token);
  });

  it("POST for non-existent conversation returns 404", async () => {
    const { app } = await buildApp();
    const res = await app.request("/v1/conversations/does-not-exist/share", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("public read of unknown token returns 404", async () => {
    const { app } = await buildApp();
    const res = await app.request("/v1/shared/sh_bogus");
    expect(res.status).toBe(404);
  });
});
