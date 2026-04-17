import { Hono } from "hono";
import type { Db } from "@provara/db";
import { getStripe } from "../stripe/index.js";
import { dispatchStripeEvent } from "../stripe/events.js";
import {
  claimWebhookEvent,
  isDuplicateWebhookEvent,
  releaseWebhookEventOnFailure,
} from "../stripe/subscriptions.js";

/**
 * Stripe webhook handler. Must run OUTSIDE of JSON body parsing — Stripe
 * signature verification requires the exact raw bytes Stripe POSTed,
 * byte-for-byte. Hono doesn't auto-parse unless the handler asks for
 * JSON, so reading `c.req.raw.text()` before any JSON call gets us the
 * unmodified body.
 *
 * Idempotency is a two-step claim/release: write the event row first,
 * process, and delete the row on handler failure so a retry can
 * re-attempt. A stale row from a crashed process would permanently
 * dedupe a retry that should have run — that's an acceptable trade-off
 * for simplicity; operator can manually delete if it happens.
 */
export function createWebhookRoutes(db: Db) {
  const app = new Hono();

  app.post("/stripe", async (c) => {
    const stripe = getStripe();
    if (!stripe) {
      // No Stripe SDK configured. Self-hosters without billing return 404
      // so accidental public exposure doesn't 200 to nothing.
      return c.json({ error: { message: "stripe integration not configured", type: "not_configured" } }, 404);
    }

    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[stripe] webhook received but STRIPE_WEBHOOK_SECRET is unset");
      return c.json({ error: { message: "webhook secret not configured", type: "misconfigured" } }, 500);
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: { message: "missing stripe-signature header", type: "invalid_request" } }, 400);
    }

    const rawBody = await c.req.raw.text();

    let event;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[stripe] webhook signature verification failed: ${msg}`);
      return c.json({ error: { message: "invalid signature", type: "invalid_signature" } }, 400);
    }

    if (await isDuplicateWebhookEvent(db, event.id)) {
      // Stripe retried a previously-handled event. 200 so it stops retrying.
      return c.json({ received: true, deduped: true });
    }

    await claimWebhookEvent(db, event.id, event.type, rawBody);

    try {
      await dispatchStripeEvent(db, stripe, event);
    } catch (err) {
      // Release the claim so Stripe's retry can re-attempt. Logged at
      // error level since unhandled handler exceptions are a real bug.
      await releaseWebhookEventOnFailure(db, event.id);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[stripe] handler failed for event ${event.id} (${event.type}):`, msg);
      return c.json({ error: { message: "handler failed", type: "handler_error" } }, 500);
    }

    return c.json({ received: true });
  });

  return app;
}
