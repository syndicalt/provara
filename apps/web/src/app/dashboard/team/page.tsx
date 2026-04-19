"use client";

import { useCallback, useEffect, useState } from "react";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";
import { TierBadge } from "../../../components/tier-badge";
import { useToast } from "../../../components/toast";
import { useAuth } from "../../../lib/auth-context";

type Role = "owner" | "admin" | "developer" | "viewer";

interface Member {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "owner" | "admin" | "developer" | "viewer";
  createdAt: string;
}

interface Seats {
  tier: string;
  members: number;
  pendingInvites: number;
  used: number;
  limit: number;
  unlimited: boolean;
  canInvite: boolean;
}

interface Invite {
  token: string;
  invitedEmail: string;
  invitedRole: "owner" | "admin" | "developer" | "viewer";
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function TeamPage() {
  const { user } = useAuth();
  const viewerRole = (user?.role ?? "viewer") as Role;
  const viewerId = user?.id ?? "";
  const [members, setMembers] = useState<Member[]>([]);
  const [seats, setSeats] = useState<Seats | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [teamRes, invitesRes] = await Promise.all([
        gatewayClientFetch<{ members: Member[]; seats: Seats }>("/v1/admin/team"),
        gatewayClientFetch<{ invites: Invite[] }>("/v1/admin/team/invites"),
      ]);
      setMembers(teamRes.members);
      setSeats(teamRes.seats);
      setInvites(invitesRes.invites);
    } catch (err) {
      console.error("team fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading team...</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Team</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Manage team members and invites.
          </p>
        </div>
        {seats && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="flex items-center gap-2 justify-end">
                <TierBadge tier={seats.tier} size="xs" />
                <span className="text-xs text-zinc-500">
                  {seats.unlimited
                    ? `${seats.used} seats`
                    : `${seats.used} / ${seats.limit} seats`}
                </span>
              </div>
              {!seats.unlimited && seats.pendingInvites > 0 && (
                <div className="text-[11px] text-zinc-500 mt-1">
                  incl. {seats.pendingInvites} pending invite{seats.pendingInvites !== 1 ? "s" : ""}
                </div>
              )}
            </div>
            <button
              onClick={() => setInviteOpen(true)}
              disabled={!seats.canInvite}
              className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              title={seats.canInvite ? "Invite a team member" : "Seat limit reached — upgrade your plan or remove a member"}
            >
              Invite member
            </button>
          </div>
        )}
      </div>

      {seats && !seats.canInvite && !seats.unlimited && (
        <div className="bg-amber-950/30 border border-amber-900/60 rounded-lg p-4 text-sm text-amber-200">
          Your team is at the {seats.limit}-seat limit for the {seats.tier} tier. {" "}
          <a href="/dashboard/billing" className="underline text-amber-100 hover:text-amber-50">
            Upgrade your plan
          </a>{" "}
          or remove a member to invite more people.
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-widest mb-3">
          Members ({members.length})
        </h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-400 text-xs border-b border-zinc-800">
                <th className="text-left px-4 py-2.5 font-medium">User</th>
                <th className="text-left px-4 py-2.5 font-medium">Role</th>
                <th className="text-left px-4 py-2.5 font-medium">Joined</th>
                <th className="px-4 py-2.5 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  viewerRole={viewerRole}
                  viewerId={viewerId}
                  onChanged={load}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {invites.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-widest mb-3">
            Pending invites ({invites.length})
          </h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-400 text-xs border-b border-zinc-800">
                  <th className="text-left px-4 py-2.5 font-medium">Email</th>
                  <th className="text-left px-4 py-2.5 font-medium">Role</th>
                  <th className="text-left px-4 py-2.5 font-medium">Expires</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <InviteRow key={inv.token} invite={inv} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {inviteOpen && seats && (
        <InviteModal
          viewerRole={viewerRole}
          onClose={() => setInviteOpen(false)}
          onCreated={(url) => {
            setInviteOpen(false);
            toast.success("Invite sent — link copied to clipboard");
            navigator.clipboard?.writeText(url).catch(() => {});
            load();
          }}
          onError={(msg) => toast.error(`Could not create invite: ${msg}`)}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  viewerRole,
  viewerId,
  onChanged,
}: {
  member: Member;
  viewerRole: Role;
  viewerId: string;
  onChanged: () => void;
}) {
  const toast = useToast();

  // Permission gating — mirrors the backend policy so the UI never
  // shows an action the server will refuse. See team.ts PATCH/DELETE.
  const isSelf = member.id === viewerId;
  const viewerIsOwner = viewerRole === "owner";
  // Only owners can touch owner rows; nobody can touch themselves.
  const canEditRole = !isSelf && (viewerIsOwner || member.role !== "owner");
  const canRemove = !isSelf && (viewerIsOwner || member.role !== "owner");
  // Owner tier is only assignable by another owner.
  const roleOptions: Array<{ value: Role; label: string }> = [
    ...(viewerIsOwner ? [{ value: "owner" as const, label: "Owner" }] : []),
    { value: "admin", label: "Admin" },
    { value: "developer", label: "Developer" },
    { value: "viewer", label: "Viewer" },
  ];

  async function updateRole(newRole: Role) {
    const res = await gatewayFetchRaw(`/v1/admin/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Could not change role: ${body?.error?.message ?? "Unknown error"}`);
      return;
    }
    onChanged();
  }

  async function remove() {
    if (!confirm(`Remove ${member.email} from the team?`)) return;
    const res = await gatewayFetchRaw(`/v1/admin/team/${member.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Could not remove member: ${body?.error?.message ?? "Unknown error"}`);
      return;
    }
    onChanged();
  }

  return (
    <tr className="border-t border-zinc-800/50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {member.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={member.avatarUrl} alt="" className="w-7 h-7 rounded-full" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-zinc-800" />
          )}
          <div>
            <div className="text-zinc-200">
              {member.name || member.email}
              {isSelf && <span className="ml-2 text-xs text-zinc-500">(you)</span>}
            </div>
            {member.name && <div className="text-xs text-zinc-500">{member.email}</div>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        {canEditRole ? (
          <select
            value={member.role}
            onChange={(e) => updateRole(e.target.value as Role)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
          >
            {/* Include the current role even if it wouldn't normally be
                in the assignable set (edge: viewer-era history). */}
            {!roleOptions.some((o) => o.value === member.role) && (
              <option value={member.role}>{member.role}</option>
            )}
            {roleOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-zinc-400 capitalize">{member.role}</span>
        )}
      </td>
      <td className="px-4 py-3 text-zinc-500 text-xs">{formatDate(member.createdAt)}</td>
      <td className="px-4 py-3 text-right">
        {canRemove ? (
          <button
            onClick={remove}
            className="text-xs text-zinc-500 hover:text-red-400"
          >
            Remove
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function InviteRow({ invite, onChanged }: { invite: Invite; onChanged: () => void }) {
  const toast = useToast();
  const inviteUrl = typeof window !== "undefined"
    ? `${window.location.origin}/invite/${invite.token}`
    : `/invite/${invite.token}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Link copied");
    } catch {
      toast.error(`Could not copy. Link: ${inviteUrl}`);
    }
  }

  async function revoke() {
    if (!confirm(`Revoke invite for ${invite.invitedEmail}?`)) return;
    const res = await gatewayFetchRaw(`/v1/admin/team/invites/${invite.token}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Could not revoke: ${body?.error?.message ?? "Unknown error"}`);
      return;
    }
    onChanged();
  }

  return (
    <tr className="border-t border-zinc-800/50">
      <td className="px-4 py-3 text-zinc-200">{invite.invitedEmail}</td>
      <td className="px-4 py-3 text-zinc-400 capitalize text-xs">{invite.invitedRole}</td>
      <td className="px-4 py-3 text-zinc-500 text-xs">{formatDate(invite.expiresAt)}</td>
      <td className="px-4 py-3 text-right">
        <button onClick={copy} className="text-xs text-blue-400 hover:text-blue-300 mr-4">
          Copy link
        </button>
        <button onClick={revoke} className="text-xs text-zinc-500 hover:text-red-400">
          Revoke
        </button>
      </td>
    </tr>
  );
}

function InviteModal({
  onClose,
  viewerRole,
  onCreated,
  onError,
}: {
  viewerRole: Role;
  onClose: () => void;
  onCreated: (url: string) => void;
  onError: (msg: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [submitting, setSubmitting] = useState(false);
  const canInviteOwner = viewerRole === "owner";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await gatewayFetchRaw("/v1/admin/team/invites", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        onError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const body = await res.json();
      onCreated(body.inviteUrl);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold mb-1">Invite a team member</h3>
        <p className="text-xs text-zinc-500 mb-5">
          We&apos;ll send them an email with a link. You&apos;ll also get a copy-paste link in case it doesn&apos;t arrive.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="person@example.com"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="viewer">Viewer — read-only access to dashboards, logs, spend</option>
              <option value="developer">Developer — use the gateway, manage own tokens, edit prompts</option>
              <option value="admin">Admin — everything except billing and tenant deletion</option>
              {canInviteOwner && (
                <option value="owner">Owner — full access including billing and team</option>
              )}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 rounded text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send invite"}
          </button>
        </div>
      </form>
    </div>
  );
}
