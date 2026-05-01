import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { guardrailRules } from "@provara/db";
import { and, eq } from "drizzle-orm";
import { createGuardrailRoutes } from "../src/routes/guardrails.js";
import { PROMPT_INJECTION_FIREWALL_TYPE } from "../src/guardrails/patterns.js";
import { __testSetTenant } from "../src/auth/tenant.js";
import { makeTestDb } from "./_setup/db.js";

function appFor(db: Parameters<typeof createGuardrailRoutes>[0], tenantId: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    __testSetTenant(c.req.raw, tenantId);
    await next();
  });
  app.route("/", createGuardrailRoutes(db));
  return app;
}

describe("prompt injection firewall preset", () => {
  it("bulk-enables the built-in prompt injection rules for a tenant", async () => {
    const db = await makeTestDb();
    const app = appFor(db, "tenant-firewall");

    const before = await app.request("/");
    expect(before.status).toBe(200);

    let rules = await db
      .select()
      .from(guardrailRules)
      .where(
        and(
          eq(guardrailRules.tenantId, "tenant-firewall"),
          eq(guardrailRules.type, PROMPT_INJECTION_FIREWALL_TYPE),
          eq(guardrailRules.builtIn, true),
        ),
      )
      .all();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => !rule.enabled)).toBe(true);

    const res = await app.request("/presets/prompt-injection-firewall", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      preset: { id: string; totalRules: number; enabledRules: number };
    };
    expect(body.preset.id).toBe("prompt-injection-firewall");
    expect(body.preset.enabledRules).toBe(body.preset.totalRules);

    rules = await db
      .select()
      .from(guardrailRules)
      .where(
        and(
          eq(guardrailRules.tenantId, "tenant-firewall"),
          eq(guardrailRules.type, PROMPT_INJECTION_FIREWALL_TYPE),
          eq(guardrailRules.builtIn, true),
        ),
      )
      .all();
    expect(rules.every((rule) => rule.enabled)).toBe(true);
  });

  it("rejects invalid preset actions", async () => {
    const db = await makeTestDb();
    const app = appFor(db, "tenant-firewall");

    const res = await app.request("/presets/prompt-injection-firewall", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "quarantine" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe("validation_error");
  });
});
