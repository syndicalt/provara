"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";

interface AuditEvent {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditResponse {
  events: AuditEvent[];
  nextCursor: string | null;
}

// Event taxonomy. Mirrors `packages/gateway/src/audit/actions.ts`.
// Duplicated on purpose — the dashboard is a runtime-independent
// consumer and shouldn't import a gateway module at build time.
const KNOWN_ACTIONS = [
  "auth.login.success",
  "auth.login.failed",
  "auth.session.revoked",
  "auth.sso_config.updated",
  "user.invited",
  "user.joined",
  "user.removed",
  "user.role_changed",
  "api_key.created",
  "api_key.revoked",
  "token.created",
  "token.revoked",
  "token.rotated",
  "billing.subscription.created",
  "billing.subscription.updated",
  "billing.subscription.canceled",
  "billing.checkout.started",
];

function formatAction(action: string): string {
  return action
    .split(".")
    .map((p) => p.replace(/_/g, " "))
    .join(" → ");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterActor, setFilterActor] = useState<string>("");
  const [gate, setGate] = useState<null | { reason: string }>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Debounce the actor-email filter so every keystroke doesn't fire a
  // new query. 400ms feels responsive and batches typical typing.
  const actorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedActor, setDebouncedActor] = useState("");

  useEffect(() => {
    if (actorDebounceRef.current) clearTimeout(actorDebounceRef.current);
    actorDebounceRef.current = setTimeout(() => setDebouncedActor(filterActor), 400);
    return () => {
      if (actorDebounceRef.current) clearTimeout(actorDebounceRef.current);
    };
  }, [filterActor]);

  const load = useCallback(async (opts: { reset: boolean } = { reset: true }) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterAction) params.set("action", filterAction);
      if (debouncedActor) params.set("actor", debouncedActor);
      if (!opts.reset && cursor) params.set("cursor", cursor);
      const res = await gatewayFetchRaw(`/v1/audit-logs?${params.toString()}`);
      if (res.status === 402) {
        setGate({ reason: "insufficient_tier" });
        setEvents([]);
        setHasMore(false);
        return;
      }
      if (!res.ok) {
        console.error("audit fetch failed:", res.status);
        return;
      }
      setGate(null);
      const data = (await res.json()) as AuditResponse;
      setEvents((prev) => (opts.reset ? data.events : [...prev, ...data.events]));
      setCursor(data.nextCursor);
      setHasMore(Boolean(data.nextCursor));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAction, debouncedActor]);

  useEffect(() => {
    // Reset + reload whenever a filter changes. Cursor is stateful
    // across pagination within a filter; changing the filter resets it.
    load({ reset: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAction, debouncedActor]);

  function downloadCsv() {
    const params = new URLSearchParams();
    if (filterAction) params.set("action", filterAction);
    if (debouncedActor) params.set("actor", debouncedActor);
    params.set("format", "csv");
    // Full-page navigation so the browser treats the response as a
    // download (content-disposition: attachment).
    window.location.href =
      (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "") + `/v1/audit-logs?${params.toString()}`;
  }

  if (gate?.reason === "insufficient_tier") {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold">Audit log</h1>
        <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <p className="text-zinc-300 font-medium">Audit logs are available on Team and Enterprise plans.</p>
          <p className="text-sm text-zinc-500 mt-2">
            See who signed in, who changed what, and when. Filter by action, user, or date range; export to CSV for compliance reviews.
          </p>
          <a
            href="/dashboard/billing"
            className="inline-block mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium"
          >
            Upgrade
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Audit log</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Every security- and admin-relevant event. Retention follows your plan.
          </p>
        </div>
        <button
          onClick={downloadCsv}
          className="px-3 py-2 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
        >
          Export CSV
        </button>
      </div>

      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Action</label>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded px-2 py-1.5 text-sm"
          >
            <option value="">All actions</option>
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Actor email</label>
          <input
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value)}
            placeholder="contains…"
            className="bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 rounded px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Time</th>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Actor</th>
              <th className="text-left px-4 py-3 font-medium">Resource</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500 text-sm">
                  No events match the current filter.
                </td>
              </tr>
            )}
            {events.map((e) => {
              const isOpen = expandedId === e.id;
              return (
                <>
                  <tr
                    key={e.id}
                    onClick={() => setExpandedId(isOpen ? null : e.id)}
                    className="hover:bg-zinc-950/60 cursor-pointer"
                  >
                    <td className="px-4 py-3 text-zinc-300 whitespace-nowrap">{formatDate(e.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className="text-zinc-100 font-mono text-xs">{formatAction(e.action)}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-300">
                      {e.actorEmail ?? <span className="text-zinc-600">system</span>}
                    </td>
                    <td className="px-4 py-3 text-zinc-400 text-xs">
                      {e.resourceType && e.resourceId
                        ? `${e.resourceType}: ${e.resourceId}`
                        : ""}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={e.id + "-meta"} className="bg-zinc-950">
                      <td colSpan={4} className="px-4 py-3 text-xs text-zinc-400">
                        <pre className="font-mono whitespace-pre-wrap break-all">
                          {JSON.stringify(
                            {
                              id: e.id,
                              actorUserId: e.actorUserId,
                              resourceType: e.resourceType,
                              resourceId: e.resourceId,
                              metadata: e.metadata,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {events.length} event{events.length === 1 ? "" : "s"}
          {loading && " · loading…"}
        </span>
        {hasMore && (
          <button
            onClick={() => load({ reset: false })}
            disabled={loading}
            className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-60"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
