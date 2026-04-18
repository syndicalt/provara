import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@provara/db";
import { apiTokens, costLogs, requests, routingWeightSnapshots } from "@provara/db";
import { nanoid } from "nanoid";
import { makeTestDb } from "./_setup/db.js";
import { computeDriftEvents } from "../src/billing/drift.js";
import { runWeightSnapshotCycle } from "../src/scheduler/weight-snapshots.js";

const DAY = 24 * 60 * 60 * 1000;

async function seedSnapshot(
  db: Db,
  tenantId: string,
  weights: { quality: number; cost: number; latency: number },
  capturedAt: Date,
) {
  await db.insert(routingWeightSnapshots).values({
    id: nanoid(),
    tenantId,
    taskType: "_all_",
    complexity: "_all_",
    weights,
    capturedAt,
  }).run();
}

async function seedCost(
  db: Db,
  tenantId: string,
  provider: string,
  cost: number,
  createdAt: Date,
) {
  const id = nanoid();
  await db.insert(requests).values({
    id,
    provider,
    model: "m",
    prompt: "[]",
    tenantId,
    createdAt,
  }).run();
  await db.insert(costLogs).values({
    id: `cl-${id}`,
    requestId: id,
    tenantId,
    provider,
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    cost,
    createdAt,
  }).run();
}

describe("#219/T5 — drift compute", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("returns empty when no snapshots exist", async () => {
    const events = await computeDriftEvents(db, "t1", {
      from: new Date(Date.now() - 30 * DAY),
      to: new Date(),
    });
    expect(events).toEqual([]);
  });

  it("emits a drift event when weights change between snapshots", async () => {
    const now = new Date();
    const day10 = new Date(now.getTime() - 10 * DAY);
    const day5 = new Date(now.getTime() - 5 * DAY);

    await seedSnapshot(db, "t1", { quality: 0.4, cost: 0.4, latency: 0.2 }, day10);
    await seedSnapshot(db, "t1", { quality: 0.2, cost: 0.7, latency: 0.1 }, day5);

    // Seed spend in the attribution window after the change.
    await seedCost(db, "t1", "openai", 30, new Date(day5.getTime() + 1 * DAY));
    await seedCost(db, "t1", "anthropic", 70, new Date(day5.getTime() + 2 * DAY));

    const events = await computeDriftEvents(db, "t1", {
      from: new Date(now.getTime() - 14 * DAY),
      to: now,
      windowDays: 14,
      now,
    });
    expect(events).toHaveLength(1);
    expect(events[0].deltas).toMatchObject({ quality: -0.2, cost: 0.3, latency: -0.1 });
    expect(events[0].spend_mix).toHaveLength(2);
    const anthropic = events[0].spend_mix.find((r) => r.provider === "anthropic")!;
    expect(anthropic.share_pct).toBeCloseTo(70, 0);
  });

  it("treats the first snapshot as baseline and emits no event", async () => {
    const now = new Date();
    await seedSnapshot(db, "t1", { quality: 0.4, cost: 0.4, latency: 0.2 }, new Date(now.getTime() - 5 * DAY));

    const events = await computeDriftEvents(db, "t1", {
      from: new Date(now.getTime() - 14 * DAY),
      to: now,
    });
    expect(events).toEqual([]);
  });

  it("ignores sub-epsilon changes as noise", async () => {
    const now = new Date();
    await seedSnapshot(db, "t1", { quality: 0.4, cost: 0.4, latency: 0.2 }, new Date(now.getTime() - 5 * DAY));
    await seedSnapshot(db, "t1", { quality: 0.402, cost: 0.398, latency: 0.2 }, new Date(now.getTime() - 3 * DAY));

    const events = await computeDriftEvents(db, "t1", {
      from: new Date(now.getTime() - 14 * DAY),
      to: now,
    });
    expect(events).toEqual([]);
  });

  it("truncates the attribution window when a later change arrives", async () => {
    // SQLite stores `mode: "timestamp"` values as epoch seconds, so use
    // second-aligned Dates to get a deterministic round-trip.
    const nowSec = Math.floor(Date.now() / 1000) * 1000;
    const now = new Date(nowSec);
    const d20 = new Date(nowSec - 20 * DAY);
    const d15 = new Date(nowSec - 15 * DAY);
    const d12 = new Date(nowSec - 12 * DAY);

    await seedSnapshot(db, "t1", { quality: 0.5, cost: 0.3, latency: 0.2 }, d20);
    await seedSnapshot(db, "t1", { quality: 0.2, cost: 0.7, latency: 0.1 }, d15); // change 1
    await seedSnapshot(db, "t1", { quality: 0.6, cost: 0.2, latency: 0.2 }, d12); // change 2

    const events = await computeDriftEvents(db, "t1", {
      from: new Date(nowSec - 30 * DAY),
      to: now,
      windowDays: 14,
      now,
    });
    expect(events).toHaveLength(2);
    expect(events[0].window_end).toBe(d12.toISOString());
    expect(events[0].attribution_window_days).toBeCloseTo(3, 0);
  });
});

describe("#219/T5 — weight-snapshot scheduler", () => {
  let db: Db;
  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("writes one snapshot per tenant with at least one enabled token", async () => {
    await db.insert(apiTokens).values({
      id: "tok1",
      name: "Prod",
      tenant: "t1",
      hashedToken: "h1",
      tokenPrefix: "p1",
      enabled: true,
      routingProfile: "cost",
      createdAt: new Date(),
    }).run();

    const stats = await runWeightSnapshotCycle(db);
    expect(stats.snapshotsWritten).toBe(1);

    const rows = await db.select().from(routingWeightSnapshots).all();
    expect(rows).toHaveLength(1);
    // cost profile: quality 0.2, cost 0.7, latency 0.1
    expect(rows[0].weights).toEqual({ quality: 0.2, cost: 0.7, latency: 0.1 });
  });

  it("is idempotent when weights haven't changed", async () => {
    await db.insert(apiTokens).values({
      id: "tok1",
      name: "Prod",
      tenant: "t1",
      hashedToken: "h1",
      tokenPrefix: "p1",
      enabled: true,
      routingProfile: "balanced",
      createdAt: new Date(),
    }).run();

    await runWeightSnapshotCycle(db);
    const stats = await runWeightSnapshotCycle(db);
    expect(stats.snapshotsWritten).toBe(0);
    const rows = await db.select().from(routingWeightSnapshots).all();
    expect(rows).toHaveLength(1);
  });

  it("writes a new row when a tenant flips from balanced → cost", async () => {
    await db.insert(apiTokens).values({
      id: "tok1",
      name: "Prod",
      tenant: "t1",
      hashedToken: "h1",
      tokenPrefix: "p1",
      enabled: true,
      routingProfile: "balanced",
      createdAt: new Date(),
    }).run();
    await runWeightSnapshotCycle(db);

    await db.update(apiTokens).set({ routingProfile: "cost" }).run();
    const stats = await runWeightSnapshotCycle(db);
    expect(stats.snapshotsWritten).toBe(1);
    const rows = await db.select().from(routingWeightSnapshots).all();
    expect(rows).toHaveLength(2);
  });
});
