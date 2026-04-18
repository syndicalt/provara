import { describe, it, expect } from "vitest";
import {
  computeTrajectory,
  periodBounds,
  ANOMALY_MULTIPLIER,
  ANOMALY_RECENT_DAYS,
  ANOMALY_BASELINE_DAYS,
  type DailyCost,
} from "../src/billing/trajectory.js";

const DAY = 24 * 60 * 60 * 1000;

function utcDay(year: number, monthIdx: number, day: number): Date {
  return new Date(Date.UTC(year, monthIdx, day));
}

function daily(d: Date, cost: number): DailyCost {
  return { date: d, cost };
}

describe("#219/T4 — spend trajectory compute", () => {
  it("bounds the current month correctly", () => {
    const now = new Date(Date.UTC(2026, 3, 18, 14, 30));
    const { start, end } = periodBounds(now, "month");
    expect(start).toEqual(utcDay(2026, 3, 1));
    expect(end).toEqual(utcDay(2026, 4, 1));
  });

  it("bounds the current quarter correctly (Q2 2026)", () => {
    const now = new Date(Date.UTC(2026, 4, 10));
    const { start, end } = periodBounds(now, "quarter");
    expect(start).toEqual(utcDay(2026, 3, 1));
    expect(end).toEqual(utcDay(2026, 6, 1));
  });

  it("computes MTD and a linear run-rate projection", () => {
    // Day 10 of April: $100 spent. Period is 30 days → projected $300.
    const now = new Date(Date.UTC(2026, 3, 10, 12, 0));
    const rows: DailyCost[] = [];
    for (let d = 1; d <= 10; d++) {
      rows.push(daily(utcDay(2026, 3, d), 10));
    }
    const result = computeTrajectory(rows, now, "month");
    expect(result.mtd_cost).toBe(100);
    // Day 10 of 30, mtd=100 → projected = 100 * (30/10) = 300
    expect(result.projected_cost).toBeCloseTo(300, 5);
  });

  it("computes the prior period total from completed prior month", () => {
    const now = new Date(Date.UTC(2026, 3, 15, 0, 0));
    const rows: DailyCost[] = [];
    // March: $50/day × 31 = $1550
    for (let d = 1; d <= 31; d++) rows.push(daily(utcDay(2026, 2, d), 50));
    // April: $10 on day 1
    rows.push(daily(utcDay(2026, 3, 1), 10));

    const result = computeTrajectory(rows, now, "month");
    expect(result.prior_period_cost).toBe(1550);
  });

  it("flags an anomaly when last 7d avg > 2x trailing 28d avg", () => {
    const now = new Date(Date.UTC(2026, 3, 18, 12, 0));
    const rows: DailyCost[] = [];
    // 28-day baseline ending 7 days before now: $5/day
    for (let i = 7; i < 7 + ANOMALY_BASELINE_DAYS; i++) {
      rows.push(daily(new Date(now.getTime() - i * DAY), 5));
    }
    // Last 7 days: $20/day (4× baseline)
    for (let i = 1; i <= ANOMALY_RECENT_DAYS; i++) {
      rows.push(daily(new Date(now.getTime() - i * DAY), 20));
    }

    const result = computeTrajectory(rows, now, "month");
    expect(result.anomaly.flagged).toBe(true);
    expect(result.anomaly.reason).toMatch(/2×/);
  });

  it("does not flag when recent is only 1.5x baseline (under threshold)", () => {
    const now = new Date(Date.UTC(2026, 3, 18, 12, 0));
    const rows: DailyCost[] = [];
    for (let i = 7; i < 7 + ANOMALY_BASELINE_DAYS; i++) {
      rows.push(daily(new Date(now.getTime() - i * DAY), 10));
    }
    for (let i = 1; i <= ANOMALY_RECENT_DAYS; i++) {
      rows.push(daily(new Date(now.getTime() - i * DAY), 15));
    }

    const result = computeTrajectory(rows, now, "month");
    expect(result.anomaly.flagged).toBe(false);
  });

  it(`uses ANOMALY_MULTIPLIER=${ANOMALY_MULTIPLIER}`, () => {
    // Regression guard — document the threshold and fail loud if someone
    // silently retunes it without updating callers.
    expect(ANOMALY_MULTIPLIER).toBe(2);
  });

  it("handles day-1-of-period without wild projections", () => {
    const now = new Date(Date.UTC(2026, 3, 1, 6, 0));
    const rows: DailyCost[] = [daily(utcDay(2026, 3, 1), 5)];
    const result = computeTrajectory(rows, now, "month");
    expect(result.mtd_cost).toBe(5);
    // Day 1 of 30 → projected = 5 * 30 = 150 (run-rate extrapolation).
    expect(result.projected_cost).toBeCloseTo(150, 5);
  });

  it("handles empty data without errors", () => {
    const now = new Date(Date.UTC(2026, 3, 10));
    const result = computeTrajectory([], now, "month");
    expect(result.mtd_cost).toBe(0);
    expect(result.projected_cost).toBe(0);
    expect(result.prior_period_cost).toBe(0);
    expect(result.anomaly.flagged).toBe(false);
  });
});
