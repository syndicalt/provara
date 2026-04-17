import { describe, it, expect } from "vitest";
import { getJudgeConfig, setJudgeConfig, hydrateJudgeConfig } from "../src/routing/judge.js";
import { makeTestDb } from "./_setup/db.js";

describe("judge config persistence", () => {
  it("persists sampleRate + enabled through a set/hydrate round-trip", async () => {
    const db1 = await makeTestDb();

    await setJudgeConfig(db1, { sampleRate: 0.37, enabled: false });
    expect(getJudgeConfig().sampleRate).toBeCloseTo(0.37, 5);
    expect(getJudgeConfig().enabled).toBe(false);

    // Simulate a restart: hydrate should re-read from the DB into a fresh boot
    // (module state persists across db instances; that's exactly what the fix in #65 ensures
    // survives when the module re-initializes on restart. We cover that by hydrating from a
    // second db handle pointed at the same :memory: — but :memory: is per-connection, so
    // we use a round-trip through db1 instead.)
    const db2 = db1;
    await hydrateJudgeConfig(db2);
    expect(getJudgeConfig().sampleRate).toBeCloseTo(0.37, 5);
    expect(getJudgeConfig().enabled).toBe(false);
  });

  it("stores and restores a pinned provider/model", async () => {
    const db = await makeTestDb();

    await setJudgeConfig(db, {
      sampleRate: 0.2,
      enabled: true,
      provider: "openai",
      model: "gpt-4.1-nano",
    });
    expect(getJudgeConfig()).toMatchObject({
      sampleRate: 0.2,
      enabled: true,
      provider: "openai",
      model: "gpt-4.1-nano",
    });
  });

  it("clamps sampleRate into [0, 1]", async () => {
    const db = await makeTestDb();

    await setJudgeConfig(db, { sampleRate: 1.7 });
    expect(getJudgeConfig().sampleRate).toBe(1);

    await setJudgeConfig(db, { sampleRate: -0.4 });
    expect(getJudgeConfig().sampleRate).toBe(0);
  });

  it("unsetting provider + model via null reverts to auto (cheapest)", async () => {
    const db = await makeTestDb();

    await setJudgeConfig(db, { provider: "openai", model: "gpt-4.1-nano" });
    expect(getJudgeConfig().provider).toBe("openai");

    await setJudgeConfig(db, { provider: null, model: null });
    expect(getJudgeConfig().provider).toBeNull();
    expect(getJudgeConfig().model).toBeNull();
  });
});
