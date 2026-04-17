import Stripe from "stripe";

/**
 * Stripe SDK singleton. Lazy-initialized so tests can run without
 * Stripe env vars present. Returns null when `STRIPE_SECRET_KEY` is
 * unset — callers treat null as "Stripe integration is disabled" and
 * skip silently, same pattern as the embedding provider.
 */
let client: Stripe | null = null;
let initialized = false;

export function getStripe(): Stripe | null {
  if (initialized) return client;
  initialized = true;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  client = new Stripe(key, {
    // Version pinned at build time. Update when Stripe's API shape changes
    // in a way that affects our event handlers.
    apiVersion: "2026-03-25.dahlia",
    maxNetworkRetries: 2,
  });
  return client;
}

/** Test hook — reset the singleton so a test can swap keys. */
export function __resetStripeForTests(): void {
  client = null;
  initialized = false;
}
