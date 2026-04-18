import type { Db } from "@provara/db";
import { apiTokens, routingWeightSnapshots } from "@provara/db";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { resolveWeights } from "../routing/adaptive/scoring.js";
import type { RoutingProfile } from "../routing/adaptive/types.js";

/**
 * Daily routing-weight snapshot (#219/T5). Per tenant, we pick a
 * representative token (the most-recently-enabled API token) and
 * capture its resolved `{quality, cost, latency}` weights. Over time
 * these snapshots feed the drift-correlation view: "tenant X moved
 * cost-weight from 0.4 to 0.7 on 2026-04-12; spend mix shifted 28%
 * toward anthropic in the 14 days after".
 *
 * Cell granularity (`task_type`, `complexity`) is fixed at `_all_`
 * for v1 — Provara doesn't carry per-cell tenant weights in the data
 * model yet. The columns are in the schema so a future per-cell
 * feature can populate them without a migration.
 *
 * Idempotency: we only insert a new snapshot row if the resolved
 * weights differ from the most recent snapshot. Running the job
 * multiple times per day (e.g. after a restart) therefore costs
 * nothing and doesn't create drift noise.
 */

export interface SnapshotStats {
  tenantsScanned: number;
  snapshotsWritten: number;
}

export async function runWeightSnapshotCycle(
  db: Db,
  opts: { now?: Date } = {},
): Promise<SnapshotStats> {
  const now = opts.now ?? new Date();

  const tokens = await db
    .select({
      tenant: apiTokens.tenant,
      routingProfile: apiTokens.routingProfile,
      routingWeights: apiTokens.routingWeights,
      enabled: apiTokens.enabled,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.enabled, true))
    .all();

  // Group by tenant, pick the most recently created enabled token as the
  // representative. Ties (same createdAt) are broken by token ordering —
  // stable enough for daily snapshot purposes.
  const byTenant = new Map<string, typeof tokens[number]>();
  for (const tok of tokens) {
    const existing = byTenant.get(tok.tenant);
    if (!existing || tok.createdAt.getTime() > existing.createdAt.getTime()) {
      byTenant.set(tok.tenant, tok);
    }
  }

  let written = 0;
  for (const [tenantId, tok] of byTenant.entries()) {
    const profile = (tok.routingProfile ?? "balanced") as RoutingProfile;
    let customWeights: { quality: number; cost: number; latency: number } | undefined;
    if (tok.routingWeights) {
      try {
        customWeights = JSON.parse(tok.routingWeights);
      } catch {
        // Malformed weights JSON — fall back to profile defaults below.
      }
    }
    const weights = resolveWeights(profile, customWeights);

    const last = await db
      .select()
      .from(routingWeightSnapshots)
      .where(
        and(
          eq(routingWeightSnapshots.tenantId, tenantId),
          eq(routingWeightSnapshots.taskType, "_all_"),
          eq(routingWeightSnapshots.complexity, "_all_"),
        ),
      )
      .orderBy(desc(routingWeightSnapshots.capturedAt))
      .limit(1)
      .get();

    if (last && weightsEqual(last.weights, weights)) continue;

    await db
      .insert(routingWeightSnapshots)
      .values({
        id: nanoid(),
        tenantId,
        taskType: "_all_",
        complexity: "_all_",
        weights,
        profile,
        capturedAt: now,
      })
      .run();
    written += 1;
  }

  return { tenantsScanned: byTenant.size, snapshotsWritten: written };
}

const EPSILON = 1e-9;

function weightsEqual(
  a: { quality: number; cost: number; latency: number },
  b: { quality: number; cost: number; latency: number },
): boolean {
  return (
    Math.abs(a.quality - b.quality) < EPSILON &&
    Math.abs(a.cost - b.cost) < EPSILON &&
    Math.abs(a.latency - b.latency) < EPSILON
  );
}
