import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createAdminMiddleware, __adminAuthInternals } from "../src/auth/admin.js";

async function buildApp(secret: string | undefined) {
  if (secret === undefined) delete process.env.PROVARA_ADMIN_SECRET;
  else process.env.PROVARA_ADMIN_SECRET = secret;
  process.env.PROVARA_MODE = "self_hosted";

  const app = new Hono();
  app.use("/admin/*", createAdminMiddleware());
  app.get("/admin/ok", (c) => c.json({ ok: true }));
  return app;
}

function req(app: Hono, path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers });
}

describe("admin-auth", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    __adminAuthInternals.reset();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("no secret configured → open mode (no auth required)", async () => {
    const app = await buildApp(undefined);
    const res = await req(app, "/admin/ok");
    expect(res.status).toBe(200);
  });

  it("correct key passes", async () => {
    const app = await buildApp("s3cretKEY12345");
    const res = await req(app, "/admin/ok", { "X-Admin-Key": "s3cretKEY12345" });
    expect(res.status).toBe(200);
  });

  it("wrong key returns 401", async () => {
    const app = await buildApp("s3cretKEY12345");
    const res = await req(app, "/admin/ok", { "X-Admin-Key": "wrong-key-xxxxx" });
    expect(res.status).toBe(401);
  });

  it("wrong-length key returns 401 (timing-safe path rejects length mismatch)", async () => {
    const app = await buildApp("s3cretKEY12345");
    const res = await req(app, "/admin/ok", { "X-Admin-Key": "short" });
    expect(res.status).toBe(401);
  });

  it("missing key returns 401", async () => {
    const app = await buildApp("s3cretKEY12345");
    const res = await req(app, "/admin/ok");
    expect(res.status).toBe(401);
  });

  it("locks out after MAX_FAILURES consecutive wrong keys (returns 429)", async () => {
    const app = await buildApp("s3cretKEY12345");
    const ip = { "X-Forwarded-For": "10.0.0.5" };
    for (let i = 0; i < __adminAuthInternals.MAX_FAILURES; i++) {
      const res = await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "wrong-key-xxxxx" });
      expect(res.status).toBe(401);
    }
    const res = await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "wrong-key-xxxxx" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("locked client is rejected even with correct key (lockout trumps credential)", async () => {
    const app = await buildApp("s3cretKEY12345");
    const ip = { "X-Forwarded-For": "10.0.0.6" };
    for (let i = 0; i < __adminAuthInternals.MAX_FAILURES; i++) {
      await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "wrong-key-xxxxx" });
    }
    const res = await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "s3cretKEY12345" });
    expect(res.status).toBe(429);
  });

  it("lockout is per-IP (different IP not affected)", async () => {
    const app = await buildApp("s3cretKEY12345");
    for (let i = 0; i < __adminAuthInternals.MAX_FAILURES; i++) {
      await req(app, "/admin/ok", { "X-Forwarded-For": "10.0.0.7", "X-Admin-Key": "wrong-key-xxxxx" });
    }
    const res = await req(app, "/admin/ok", { "X-Forwarded-For": "10.0.0.8", "X-Admin-Key": "s3cretKEY12345" });
    expect(res.status).toBe(200);
  });

  it("successful auth clears the failure counter", async () => {
    const app = await buildApp("s3cretKEY12345");
    const ip = { "X-Forwarded-For": "10.0.0.9" };
    // 4 failures, then 1 success
    for (let i = 0; i < 4; i++) {
      await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "wrong-key-xxxxx" });
    }
    await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "s3cretKEY12345" });
    // Now 5 more failures should lock after the 5th, not the 1st.
    for (let i = 0; i < 4; i++) {
      const res = await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "wrong-key-xxxxx" });
      expect(res.status).toBe(401);
    }
    const res = await req(app, "/admin/ok", { ...ip, "X-Admin-Key": "wrong-key-xxxxx" });
    expect(res.status).toBe(401); // 5th failure — lock starts AT the threshold, not before
  });
});
