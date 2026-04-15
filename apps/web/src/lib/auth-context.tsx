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
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    gatewayClientFetch<{ user: User | null }>("/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    try {
      await gatewayClientFetch("/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setUser(null);
    window.location.href = "/login";
  }

  return (
    <AuthContext.Provider value={{ user, loading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
