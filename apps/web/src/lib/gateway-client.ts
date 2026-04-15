"use client";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_KEY || "";

export function gatewayUrl(path: string): string {
  return `${GATEWAY_URL}${path}`;
}

export function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ADMIN_KEY) {
    headers["X-Admin-Key"] = ADMIN_KEY;
  }
  return headers;
}

export async function gatewayClientFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(gatewayUrl(path), {
    ...options,
    headers: {
      ...adminHeaders(),
      ...options?.headers as Record<string, string>,
    },
  });
  if (!res.ok) {
    throw new Error(`Gateway error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
