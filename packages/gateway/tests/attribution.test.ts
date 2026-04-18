import { describe, it, expect } from "vitest";
import { costLogs, requests, type Db } from "@provara/db";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./_setup/db.js";
import { logCost } from "../src/cost/index.js";
import { getRequestAttribution } from "../src/auth/attribution.js";
import { __testSetSessionUserId } from "../src/auth/tenant.js";

async function seedRequest(db: Db, id: string) {
  await db.insert(requests).values({
    id,
    provider: "openai",
    model: "gpt-4.1-nano",
    prompt: "[]",
  }).run();
}

describe("#219/T2 — spend attribution at ingest", () => {
  it("logCost persists userId + apiTokenId when provided", async () => {
    const db = await makeTestDb();
    await seedRequest(db, "req_attr_1");

    await logCost(db, {
      requestId: "req_attr_1",
      provider: "openai",
      model: "gpt-4.1-nano",
      inputTokens: 10,
      outputTokens: 20,
      tenantId: "t_1",
      userId: "u_1",
      apiTokenId: "tok_1",
    });

    const row = await db
      .select()
      .from(costLogs)
      .where(eq(costLogs.requestId, "req_attr_1"))
      .get();

    expect(row?.userId).toBe("u_1");
    expect(row?.apiTokenId).toBe("tok_1");
    expect(row?.tenantId).toBe("t_1");
  });

  it("logCost defaults attribution to null when omitted (backwards-compat)", async () => {
    const db = await makeTestDb();
    await seedRequest(db, "req_attr_2");

    await logCost(db, {
      requestId: "req_attr_2",
      provider: "openai",
      model: "gpt-4.1-nano",
      inputTokens: 10,
      outputTokens: 20,
      tenantId: "t_1",
    });

    const row = await db
      .select()
      .from(costLogs)
      .where(eq(costLogs.requestId, "req_attr_2"))
      .get();

    expect(row?.userId).toBeNull();
    expect(row?.apiTokenId).toBeNull();
  });

  it("getRequestAttribution pulls session user id when tenant middleware populated it", () => {
    const req = new Request("http://localhost/v1/chat/completions");
    __testSetSessionUserId(req, "u_session");

    const attribution = getRequestAttribution(req);

    expect(attribution.userId).toBe("u_session");
    expect(attribution.apiTokenId).toBeNull();
  });

  it("getRequestAttribution returns both null on an unauthenticated request", () => {
    const req = new Request("http://localhost/v1/chat/completions");

    const attribution = getRequestAttribution(req);

    expect(attribution.userId).toBeNull();
    expect(attribution.apiTokenId).toBeNull();
  });
});
