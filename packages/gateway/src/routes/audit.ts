import { Hono } from "hono";
import type { Db } from "@provara/db";
import { auditLogs } from "@provara/db";
import { and, eq, gte, lte, lt, or, desc, sql } from "drizzle-orm";
import { getAuthUser } from "../auth/admin.js";
import { tenantHasTeamAccess } from "../auth/tier.js";

/**
 * Audit-log read API (#210/T4). Dashboard viewer (T6) and SIEM pull
 * both call this. Tenant-scoped (admin middleware + getAuthUser
 * upstream), Team+ tier gate enforced here.
 *
 * Shape:
 *   GET /v1/audit-logs
 *     ?action=<string>            filter exact match
 *     &actor=<string>             filter by actorEmail (LIKE, case-insensitive)
 *     &since=<iso>                created_at >= this
 *     &until=<iso>                created_at <  this
 *     &cursor=<opaque>            pagination (opaque base64 JSON)
 *     &format=json|csv            default json
 *     &limit=<n>                  default 100, max 500
 *
 * Cursor encodes the `(created_at, id)` tuple of the last row returned
 * on the previous page. We order by `created_at DESC, id DESC` so the
 * cursor tie-breaker is deterministic even when two rows share a
 * millisecond timestamp.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface CursorValue {
  ts: number; // createdAt epoch ms
  id: string;
}

function encodeCursor(v: CursorValue): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}
function decodeCursor(raw: string | undefined): CursorValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.ts !== "number" || typeof parsed?.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createAuditRoutes(db: Db) {
  const app = new Hono();

  app.get("/", async (c) => {
    const authUser = getAuthUser(c.req.raw);
    if (!authUser) {
      return c.json({ error: { message: "Authentication required.", type: "auth_error" } }, 401);
    }
    if (!(await tenantHasTeamAccess(db, authUser.tenantId))) {
      return c.json(
        {
          error: {
            message: "Audit logs are available on Team and Enterprise plans.",
            type: "insufficient_tier",
          },
        },
        402,
      );
    }

    const action = c.req.query("action");
    const actor = c.req.query("actor");
    const since = c.req.query("since");
    const until = c.req.query("until");
    const cursor = decodeCursor(c.req.query("cursor"));
    const format = (c.req.query("format") ?? "json").toLowerCase();
    const limit = Math.min(
      Math.max(1, Number(c.req.query("limit")) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    const conds = [eq(auditLogs.tenantId, authUser.tenantId)];
    if (action) conds.push(eq(auditLogs.action, action));
    if (actor) {
      conds.push(sql`LOWER(${auditLogs.actorEmail}) LIKE LOWER(${"%" + actor + "%"})`);
    }
    if (since) {
      const d = new Date(since);
      if (!isNaN(d.getTime())) conds.push(gte(auditLogs.createdAt, d));
    }
    if (until) {
      const d = new Date(until);
      if (!isNaN(d.getTime())) conds.push(lte(auditLogs.createdAt, d));
    }
    if (cursor) {
      // (ts, id) strictly-less-than: either strictly earlier ts, or same
      // ts with lexicographically smaller id. Keeps the DESC ordering
      // stable across pages when multiple rows share a millisecond.
      const ts = new Date(cursor.ts);
      conds.push(
        or(
          lt(auditLogs.createdAt, ts),
          and(eq(auditLogs.createdAt, ts), lt(auditLogs.id, cursor.id))!,
        )!,
      );
    }

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor = hasMore
      ? encodeCursor({ ts: page[page.length - 1].createdAt.getTime(), id: page[page.length - 1].id })
      : null;

    if (format === "csv") {
      const csv = toCsv(page);
      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${authUser.tenantId}-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
    }

    return c.json({
      events: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        actorEmail: r.actorEmail,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    });
  });

  return app;
}

const CSV_HEADERS = [
  "id",
  "created_at",
  "action",
  "actor_user_id",
  "actor_email",
  "resource_type",
  "resource_id",
  "metadata",
] as const;

function toCsv(rows: (typeof auditLogs.$inferSelect)[]): string {
  const head = CSV_HEADERS.join(",") + "\n";
  const body = rows
    .map((r) =>
      [
        r.id,
        r.createdAt.toISOString(),
        r.action,
        r.actorUserId ?? "",
        r.actorEmail ?? "",
        r.resourceType ?? "",
        r.resourceId ?? "",
        r.metadata ? JSON.stringify(r.metadata) : "",
      ]
        .map(csvEscape)
        .join(","),
    )
    .join("\n");
  return head + body + (rows.length > 0 ? "\n" : "");
}

function csvEscape(value: string): string {
  if (value === "") return "";
  // Quote when the cell contains a delimiter, a quote, or a newline.
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
