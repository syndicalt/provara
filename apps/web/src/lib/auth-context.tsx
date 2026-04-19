"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { gatewayClientFetch } from "./gateway-client";

interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  tenantId: string;
  role: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** True when the current session is a public read-only demo session (#229). */
  isDemo: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  isDemo: false,
  logout: async () => {},
});

/**
 * Client-side playground state lives in sessionStorage under `pg:*` keys
 * (see `use-chat-session.ts`, `use-session-persist.ts`). sessionStorage
 * is scoped to the browser origin, not to the signed-in user — which
 * means switching accounts in the same tab used to leak the previous
 * user's chat history + settings into the new account's Playground.
 *
 * We guard against this in two places:
 *   1. Explicit logout() clears all pg:* keys before redirecting.
 *   2. AuthProvider compares the signed-in user's id to a stashed
 *      `pg:user_id` on each load. A mismatch means either the server
 *      expired one user's session and they re-signed-in as someone
 *      else, or a tab inherited sessionStorage across a user switch.
 *      Either way, purge before rendering.
 */
function clearPlaygroundState() {
  if (typeof window === "undefined") return;
  const keysToDrop: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith("pg:")) keysToDrop.push(k);
  }
  keysToDrop.forEach((k) => sessionStorage.removeItem(k));
}

const PG_USER_KEY = "pg:user_id";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    gatewayClientFetch<{ user: User | null; isDemo?: boolean }>("/auth/me")
      .then((data) => {
        if (typeof window !== "undefined") {
          const stashedId = sessionStorage.getItem(PG_USER_KEY);
          if (data.user) {
            if (stashedId && stashedId !== data.user.id) {
              clearPlaygroundState();
            }
            sessionStorage.setItem(PG_USER_KEY, data.user.id);
          } else if (stashedId) {
            clearPlaygroundState();
          }
        }
        setUser(data.user);
        setIsDemo(data.isDemo === true);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    try {
      await gatewayClientFetch("/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    clearPlaygroundState();
    setUser(null);
    window.location.href = "/login";
  }

  return (
    <AuthContext.Provider value={{ user, loading, isDemo, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
