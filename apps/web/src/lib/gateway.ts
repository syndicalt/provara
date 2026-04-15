const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:4000";
const ADMIN_KEY = process.env.PROVARA_ADMIN_SECRET || "";

export async function gatewayFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers as Record<string, string>,
  };

  if (ADMIN_KEY) {
    headers["X-Admin-Key"] = ADMIN_KEY;
  }

  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    throw new Error(`Gateway error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getGatewayUrl(): string {
  return GATEWAY_URL;
}

export function getAdminKey(): string {
  return ADMIN_KEY;
}
