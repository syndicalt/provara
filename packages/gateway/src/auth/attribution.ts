import { getTokenInfo } from "./middleware.js";
import { getSessionUserId } from "./tenant.js";

/**
 * Spend-intelligence attribution (#219). Resolves the (userId, apiTokenId)
 * pair for a request from the auth context that the existing middleware
 * already populated:
 *
 *   - dashboard/playground call (session cookie) → userId, no token
 *   - programmatic call (Bearer token)           → apiTokenId, no user
 *
 * They are not mutually exclusive in the schema, but in practice exactly
 * one is set per request because the auth middleware resolves exactly one
 * credential. Both can be null on the /v1/chat/completions open-mode path
 * (no tokens configured) — that's fine; the columns are nullable.
 *
 * This is a pure read over the existing WeakMaps — no DB calls, no new
 * middleware. Call-sites resolve on demand just before persisting.
 */
export function getRequestAttribution(req: Request): {
  userId: string | null;
  apiTokenId: string | null;
} {
  return {
    userId: getSessionUserId(req),
    apiTokenId: getTokenInfo(req)?.id ?? null,
  };
}
