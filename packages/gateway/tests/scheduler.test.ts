import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { scheduledJobs } from "@provara/db";
import type { Db } from "@provara/db";
import { createScheduler } from "../src/scheduler/index.js";
import { makeTestDb } from "./_setup/db.js";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("scheduler", () => {
  let db: Db;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("runs a job immediately when initialDelayMs=0 and records success", async () => {
    const scheduler = createScheduler(db);
    const runs: number[] = [];
    await scheduler.schedule({
      name: "test-job",
      intervalMs: 60_000,
      initialDelayMs: 0,
      handler: () => {
        runs.push(Date.now());
      },
    });
    scheduler.start();

    await wait(60);
    scheduler.stop();

    expect(runs.length).toBeGreaterThanOrEqual(1);
    const row = await db.select().from(scheduledJobs).where(eq(scheduledJobs.name, "test-job")).get();
    expect(row?.lastStatus).toBe("ok");
    expect(row?.runCount).toBeGreaterThanOrEqual(1);
  });

  it("records errors in lastStatus/lastError", async () => {
    const scheduler = createScheduler(db);
    await scheduler.schedule({
      name: "err-job",
      intervalMs: 60_000,
      initialDelayMs: 0,
      handler: () => {
        throw new Error("boom");
      },
    });
    scheduler.start();

    await wait(60);
    scheduler.stop();

    const row = await db.select().from(scheduledJobs).where(eq(scheduledJobs.name, "err-job")).get();
    expect(row?.lastStatus).toBe("error");
    expect(row?.lastError).toBe("boom");
  });

  it("skips start when PROVARA_SCHEDULER_ROLE is not 'leader'", async () => {
    process.env.PROVARA_SCHEDULER_ROLE = "follower";
    const scheduler = createScheduler(db);
    const runs: number[] = [];
    await scheduler.schedule({
      name: "leader-test",
      intervalMs: 50,
      initialDelayMs: 0,
      handler: () => runs.push(Date.now()),
    });
    scheduler.start();
    await wait(100);
    scheduler.stop();

    expect(runs).toHaveLength(0);
  });

  it("runNow executes the job on demand regardless of schedule timing", async () => {
    const scheduler = createScheduler(db);
    const runs: number[] = [];
    await scheduler.schedule({
      name: "ondemand",
      intervalMs: 10_000,
      initialDelayMs: 10_000,
      handler: () => runs.push(Date.now()),
    });
    scheduler.start();
    await scheduler.runNow("ondemand");
    scheduler.stop();

    expect(runs).toHaveLength(1);
  });

  it("runNow throws for unknown job names", async () => {
    const scheduler = createScheduler(db);
    await expect(scheduler.runNow("nope")).rejects.toThrow(/unknown job/);
  });

  it("skips overlapping runs of the same job", async () => {
    const scheduler = createScheduler(db);
    let running = 0;
    let maxConcurrent = 0;
    await scheduler.schedule({
      name: "slow-job",
      intervalMs: 60_000,
      initialDelayMs: 10_000,
      handler: async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await wait(50);
        running--;
      },
    });
    scheduler.start();

    // Fire twice rapidly — the second must see the first still running
    const a = scheduler.runNow("slow-job");
    const b = scheduler.runNow("slow-job");
    await Promise.all([a, b]);
    scheduler.stop();

    expect(maxConcurrent).toBe(1);
    const row = await db.select().from(scheduledJobs).where(eq(scheduledJobs.name, "slow-job")).get();
    // Second call recorded as skipped
    expect(["ok", "skipped"]).toContain(row?.lastStatus);
  });

  it("getJobs returns persisted state", async () => {
    const scheduler = createScheduler(db);
    await scheduler.schedule({
      name: "job-a",
      intervalMs: 60_000,
      initialDelayMs: 10_000,
      handler: async () => {},
    });
    await scheduler.schedule({
      name: "job-b",
      intervalMs: 30_000,
      initialDelayMs: 10_000,
      handler: async () => {},
    });
    const jobs = await scheduler.getJobs();
    expect(jobs.map((j) => j.name).sort()).toEqual(["job-a", "job-b"]);
    expect(jobs.find((j) => j.name === "job-a")?.intervalMs).toBe(60_000);
  });
});
