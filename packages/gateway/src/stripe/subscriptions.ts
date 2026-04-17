import type { Db } from "@provara/db";
import { subscriptions, stripeWebhookEvents } from "@provara/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

/**
 * Denormalize a Stripe Subscription into our local row shape. The
 * `tier` and `includesIntelligence` fields come from the subscription's
 * price → product → metadata chain; we write them flat so feature-gate
 * reads are a single row lookup rather than a Stripe roundtrip.
 *
 * `tenantId` is passed separately because not every event path has it
 * on the subscription object itself. The webhook handler resolves it
 * (usually from checkout session metadata on first write) and passes it
 * in.
 */
export interface StripeProductMetadata {
  tier?: string;
  includes_intelligence?: string;
}

function parseTier(metadata: StripeProductMetadata | null | undefined): {
  tier: string;
  includesIntelligence: boolean;
} {
  const tier = metadata?.tier ?? "free";
  const includesIntelligence = metadata?.includes_intelligence === "true";
  return { tier, includesIntelligence };
}

/**
 * Idempotent upsert — safe to call on every webhook firing, including
 * Stripe retries. PrimaryKey is `stripeSubscriptionId`; on conflict we
 * update everything except `createdAt`.
 */
export async function upsertSubscription(
  db: Db,
  stripeSub: Stripe.Subscription,
  tenantId: string,
  product: Stripe.Product,
): Promise<void> {
  const { tier, includesIntelligence } = parseTier(
    product.metadata as StripeProductMetadata,
  );

  const item = stripeSub.items.data[0];
  if (!item) {
    throw new Error(`subscription ${stripeSub.id} has no items`);
  }
  const price = item.price;

  // In 2025-09 API the billing-cycle period moved from the subscription to
  // each subscription item. For our single-item subscriptions the first
  // item carries the canonical period.
  const periodStart = item.current_period_start ?? Math.floor(Date.now() / 1000);
  const periodEnd = item.current_period_end ?? Math.floor(Date.now() / 1000);

  const now = new Date();
  const values = {
    stripeSubscriptionId: stripeSub.id,
    tenantId,
    stripeCustomerId: typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer.id,
    stripePriceId: price.id,
    stripeProductId: typeof price.product === "string" ? price.product : price.product.id,
    tier,
    includesIntelligence,
    status: stripeSub.status,
    currentPeriodStart: new Date(periodStart * 1000),
    currentPeriodEnd: new Date(periodEnd * 1000),
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    trialEnd: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null,
    updatedAt: now,
  };

  await db
    .insert(subscriptions)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: values,
    })
    .run();
}

/** Flip a subscription's status to canceled without touching other fields. */
export async function markSubscriptionCanceled(
  db: Db,
  stripeSubscriptionId: string,
): Promise<void> {
  await db
    .update(subscriptions)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .run();
}

/** Flip status to past_due (payment_failed) or active (payment recovered). */
export async function setSubscriptionStatus(
  db: Db,
  stripeSubscriptionId: string,
  status: "active" | "past_due" | "unpaid",
): Promise<void> {
  await db
    .update(subscriptions)
    .set({ status, updatedAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .run();
}

/**
 * Feature-gate query: which subscription does this tenant currently have?
 * Returns null when the tenant has no row (= Free tier in the gated-
 * by-tier world). Used by #168's feature-gate middleware.
 */
export async function getSubscriptionForTenant(
  db: Db,
  tenantId: string,
): Promise<typeof subscriptions.$inferSelect | null> {
  const row = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .get();
  return row ?? null;
}

/**
 * Look up the tenantId associated with a Stripe subscription, for events
 * that arrive with only the subscription in hand (updated/deleted/invoice
 * events). Returns null if we haven't seen this subscription before —
 * shouldn't happen in normal flow since checkout.session.completed writes
 * the first row.
 */
export async function getTenantForSubscription(
  db: Db,
  stripeSubscriptionId: string,
): Promise<string | null> {
  const row = await db
    .select({ tenantId: subscriptions.tenantId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .get();
  return row?.tenantId ?? null;
}

/**
 * Dedupe Stripe webhook retries. Returns true if the event has already
 * been processed (skip); false if it's new (claim it by writing the
 * row, then process).
 *
 * Ordering matters: the caller should claim BEFORE processing and roll
 * back on handler failure. Claiming is the write; rolling back is
 * deleting the row so the next retry picks it up.
 */
export async function isDuplicateWebhookEvent(
  db: Db,
  eventId: string,
): Promise<boolean> {
  const row = await db
    .select({ eventId: stripeWebhookEvents.eventId })
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.eventId, eventId))
    .get();
  return Boolean(row);
}

export async function claimWebhookEvent(
  db: Db,
  eventId: string,
  eventType: string,
  payload: string,
): Promise<void> {
  await db
    .insert(stripeWebhookEvents)
    .values({ eventId, eventType, payload })
    .run();
}

export async function releaseWebhookEventOnFailure(
  db: Db,
  eventId: string,
): Promise<void> {
  await db
    .delete(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.eventId, eventId))
    .run();
}
