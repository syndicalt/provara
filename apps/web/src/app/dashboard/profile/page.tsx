"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";
import { useToast } from "../../../components/toast";
import { useAuth } from "../../../lib/auth-context";

interface Me {
  id: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  tenantId: string;
  role: "owner" | "admin" | "developer" | "viewer";
  createdAt: string;
  isSoleOwner: boolean;
  ownerCount: number;
  authMethods: string[];
}

interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ProfilePage() {
  const router = useRouter();
  const toast = useToast();
  const { logout } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);

  const load = useCallback(async () => {
    try {
      const [meRes, sessRes] = await Promise.all([
        gatewayClientFetch<{ user: Me }>("/v1/me"),
        gatewayClientFetch<{ sessions: SessionRow[] }>("/v1/me/sessions"),
      ]);
      setMe(meRes.user);
      setFirstName(meRes.user.firstName ?? "");
      setLastName(meRes.user.lastName ?? "");
      setSessions(sessRes.sessions);
    } catch (err) {
      console.error("Failed to load profile:", err);
      toast.error("Could not load profile");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveIdentity(e: React.FormEvent) {
    e.preventDefault();
    setSavingIdentity(true);
    try {
      const res = await gatewayFetchRaw("/v1/me", {
        method: "PATCH",
        body: JSON.stringify({ firstName, lastName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(`Could not save: ${body?.error?.message ?? "Unknown error"}`);
        return;
      }
      toast.success("Profile updated");
      load();
    } finally {
      setSavingIdentity(false);
    }
  }

  async function revokeOthers() {
    if (!confirm("Sign out of all other sessions? You'll stay signed in on this device.")) return;
    const res = await gatewayFetchRaw("/v1/me/sessions/revoke-others", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Could not revoke: ${body?.error?.message ?? "Unknown error"}`);
      return;
    }
    const body = await res.json();
    toast.success(`Signed out of ${body.revoked} other session(s)`);
    load();
  }

  async function deleteAccount() {
    if (!me) return;
    if (me.isSoleOwner) {
      const typed = prompt(
        `You are the sole owner of this tenant.\n\nDeleting your account will:\n  • Cancel your Stripe subscription immediately\n  • Permanently delete ALL tenant data (requests, logs, prompts, keys, tokens)\n\nThis cannot be undone.\n\nType your tenant ID to confirm:\n${me.tenantId}`,
      );
      if (typed !== me.tenantId) {
        if (typed !== null) toast.error("Tenant ID did not match — nothing deleted");
        return;
      }
      const res = await gatewayFetchRaw("/v1/me", {
        method: "DELETE",
        body: JSON.stringify({ confirmTenantName: me.tenantId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(`Could not delete: ${body?.error?.message ?? "Unknown error"}`);
        return;
      }
      toast.success("Account and tenant deleted");
      await logout();
      router.push("/");
      return;
    }

    if (!confirm(`Leave ${me.tenantId}? Your account and all sessions will be deleted.`)) return;
    const res = await gatewayFetchRaw("/v1/me", { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Could not delete: ${body?.error?.message ?? "Unknown error"}`);
      return;
    }
    toast.success("Account deleted");
    await logout();
    router.push("/");
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading profile...</p>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Could not load profile.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Manage your account, sessions, and sign-in methods.
        </p>
      </div>

      {/* Identity */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-widest mb-4">Identity</h2>
        <form onSubmit={saveIdentity} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">First name</label>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Last name</label>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Email</label>
            <input
              value={me.email}
              readOnly
              className="w-full bg-zinc-800/50 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-400 cursor-not-allowed"
            />
            <p className="text-xs text-zinc-500 mt-1">Email changes are not supported yet. Contact support if needed.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Role</label>
              <input
                value={me.role}
                readOnly
                className="w-full bg-zinc-800/50 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-400 capitalize cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Tenant</label>
              <input
                value={me.tenantId}
                readOnly
                className="w-full bg-zinc-800/50 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-400 font-mono cursor-not-allowed"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingIdentity}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {savingIdentity ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </section>

      {/* Sign-in methods */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-widest mb-4">Sign-in methods</h2>
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between py-2 border-b border-zinc-800/50">
            <span className="text-zinc-300">Magic link (email)</span>
            <span className="text-zinc-500 text-xs">Always available</span>
          </div>
          {me.authMethods.map((m) => (
            <div key={m} className="flex items-center justify-between py-2 border-b border-zinc-800/50 last:border-0">
              <span className="text-zinc-300 capitalize">{m}</span>
              <span className="text-emerald-400 text-xs">Connected</span>
            </div>
          ))}
        </div>
      </section>

      {/* Sessions */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-widest">
            Active sessions ({sessions.length})
          </h2>
          {sessions.length > 1 && (
            <button
              onClick={revokeOthers}
              className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1 rounded border border-zinc-700 hover:border-zinc-500"
            >
              Sign out everywhere else
            </button>
          )}
        </div>
        <div className="space-y-1 text-sm">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between py-2 border-b border-zinc-800/50 last:border-0">
              <div>
                <span className="font-mono text-xs text-zinc-400">{s.id}…</span>
                {s.current && <span className="ml-2 text-xs text-emerald-400">(this device)</span>}
              </div>
              <div className="text-xs text-zinc-500">
                Created {formatDate(s.createdAt)} · Expires {formatDate(s.expiresAt)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Danger zone */}
      <section className="bg-red-950/20 border border-red-900/40 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-red-200 uppercase tracking-widest mb-2">Danger zone</h2>
        <p className="text-sm text-zinc-400 mb-4">
          {me.isSoleOwner ? (
            <>
              You are the <strong>sole owner</strong> of this tenant. Deleting your account will
              cancel the Stripe subscription and permanently delete all tenant data. To preserve
              the tenant, promote another member to Owner first in{" "}
              <a href="/dashboard/team" className="text-blue-400 hover:underline">Team settings</a>.
            </>
          ) : (
            <>Deleting your account removes you from this tenant. Tenant data and other members are unaffected.</>
          )}
        </p>
        <button
          onClick={deleteAccount}
          className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 border border-red-800 rounded-lg text-sm font-medium text-red-200 transition-colors"
        >
          {me.isSoleOwner ? "Delete tenant and my account" : "Delete my account"}
        </button>
      </section>
    </div>
  );
}
