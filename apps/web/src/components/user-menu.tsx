"use client";

import { useAuth } from "../lib/auth-context";

export function UserMenu() {
  const { user, loading, logout } = useAuth();

  if (loading) return null;
  if (!user) return null;

  return (
    <div className="flex items-center gap-3 ml-4 pl-4 border-l border-zinc-800">
      {user.avatarUrl && (
        <img
          src={user.avatarUrl}
          alt=""
          className="w-6 h-6 rounded-full"
        />
      )}
      <span className="text-xs text-zinc-400">{user.name || user.email}</span>
      <button
        onClick={logout}
        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
