import type { Db } from "@provara/db";
import { scheduledJobs } from "@provara/db";
import { eq } from "drizzle-orm";

export type JobHandler = () => Promise<void> | void;

export interface JobRegistration {
  name: string;
  intervalMs: number;
  handler: JobHandler;
  /**
   * Delay in ms before the first run. Defaults to intervalMs (i.e. the
   * job waits a full interval before firing for the first time). Useful
   * for jobs that should run at startup — pass 0 or a small number.
   */
  initialDelayMs?: number;
}

export interface JobState {
  name: string;
  enabled: boolean;
  intervalMs: number;
  lastRunAt: Date | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runCount: number;
}

/**
 * Single-replica job runner. Keeps per-job state in `scheduled_jobs` for
 * observability and restart continuity. Not a queue — there is no retry,
 * no distributed lease, no priority. Each registered job fires on a fixed
 * interval via `setInterval`; concurrent runs of the same job are guarded
 * by an in-memory "running" set.
 *
 * Multi-replica safety: set `PROVARA_SCHEDULER_ROLE=leader` on exactly one
 * replica; others will register jobs but skip start. When the env var is
 * unset, the scheduler runs (single-replica default). See #150 for the
 * durable multi-replica story.
 */
export function createScheduler(db: Db) {
  const jobs = new Map<string, JobRegistration>();
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  let started = false;

  function isLeader(): boolean {
    const role = process.env.PROVARA_SCHEDULER_ROLE;
    return role === undefined || role === "" || role === "leader";
  }

  async function upsertState(name: string, intervalMs: number): Promise<void> {
    const existing = await db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.name, name))
      .get();
    const now = new Date();
    if (existing) {
      await db
        .update(scheduledJobs)
        .set({ intervalMs, updatedAt: now })
        .where(eq(scheduledJobs.name, name))
        .run();
    } else {
      await db
        .insert(scheduledJobs)
        .values({ name, enabled: true, intervalMs, runCount: 0, updatedAt: now })
        .run();
    }
  }

  async function recordRun(
    name: string,
    status: "ok" | "error" | "skipped",
    durationMs: number,
    error?: string,
  ): Promise<void> {
    const existing = await db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.name, name))
      .get();
    const runCount = (existing?.runCount ?? 0) + (status === "skipped" ? 0 : 1);
    await db
      .update(scheduledJobs)
      .set({
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: error ?? null,
        lastDurationMs: durationMs,
        runCount,
        updatedAt: new Date(),
      })
      .where(eq(scheduledJobs.name, name))
      .run();
  }

  async function executeJob(name: string): Promise<void> {
    const job = jobs.get(name);
    if (!job) return;

    // Atomic check-and-set before any await so concurrent calls cannot both
    // pass the guard. Without this, two runNow() calls both see an empty
    // `running` set, then both enter the async body and double-fire.
    if (running.has(name)) {
      await recordRun(name, "skipped", 0, "previous run still in progress");
      return;
    }
    running.add(name);

    try {
      const state = await db
        .select({ enabled: scheduledJobs.enabled })
        .from(scheduledJobs)
        .where(eq(scheduledJobs.name, name))
        .get();
      if (state && !state.enabled) {
        await recordRun(name, "skipped", 0, "disabled");
        return;
      }

      const start = Date.now();
      try {
        await job.handler();
        await recordRun(name, "ok", Date.now() - start);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] job "${name}" failed:`, msg);
        await recordRun(name, "error", Date.now() - start, msg);
      }
    } finally {
      running.delete(name);
    }
  }

  async function schedule(job: JobRegistration): Promise<void> {
    jobs.set(job.name, job);
    await upsertState(job.name, job.intervalMs);
    if (started) armTimer(job);
  }

  function armTimer(job: JobRegistration): void {
    if (timers.has(job.name)) {
      clearTimeout(timers.get(job.name)!);
      clearInterval(timers.get(job.name)!);
    }
    const delay = job.initialDelayMs ?? job.intervalMs;
    const first = setTimeout(() => {
      void executeJob(job.name);
      const loop = setInterval(() => void executeJob(job.name), job.intervalMs);
      timers.set(job.name, loop);
    }, delay);
    timers.set(job.name, first);
  }

  function start(): void {
    if (started) return;
    if (!isLeader()) {
      console.log("[scheduler] non-leader role, skipping timer start");
      started = true;
      return;
    }
    for (const job of jobs.values()) armTimer(job);
    started = true;
    if (jobs.size > 0) {
      console.log(`[scheduler] started with ${jobs.size} job(s): ${Array.from(jobs.keys()).join(", ")}`);
    }
  }

  function stop(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.clear();
    started = false;
  }

  async function getJobs(): Promise<JobState[]> {
    const rows = await db.select().from(scheduledJobs).all();
    return rows.map((row) => ({
      name: row.name,
      enabled: row.enabled,
      intervalMs: row.intervalMs,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      lastDurationMs: row.lastDurationMs,
      runCount: row.runCount,
    }));
  }

  async function runNow(name: string): Promise<void> {
    if (!jobs.has(name)) throw new Error(`unknown job: ${name}`);
    await executeJob(name);
  }

  return { schedule, start, stop, getJobs, runNow };
}

export type Scheduler = ReturnType<typeof createScheduler>;
