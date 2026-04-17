import type { Db } from "@provara/db";
import type Stripe from "stripe";
import {
  getTenantForSubscription,
  markSubscriptionCanceled,
  setSubscriptionStatus,
  upsertSubscription,
} from "./subscriptions.js";

/**
 * Resolve the Product a Subscription's first item points to, expanding
 * if the server only sent an ID. The subscription upsert needs the
 * product's metadata (tier, includes_intelligence) to denormalize.
 */
async function resolveProductForSubscription(
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<Stripe.Product> {
  const item = subscription.items.data[0];
  if (!item) throw new Error(`subscription ${subscription.id} has no items`);
  const product = item.price.product;
  if (typeof product === "string") {
    return stripe.products.retrieve(product);
  }
  if (product.deleted) {
    throw new Error(`subscription ${subscription.id} points at a deleted product`);
  }
  return product;
}

/**
 * `checkout.session.completed` — the first time we see a customer for
 * this subscription. The session carries `metadata.tenantId` (written
 * at Checkout Session creation time by the dashboard) and a pointer to
 * the resulting subscription. We resolve the subscription + its product
 * and upsert the first row linking tenant → Stripe.
 */
export async function handleCheckoutSessionCompleted(
  db: Db,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<void> {
  // Only subscription-mode checkouts produce subscriptions. Payment-mode
  // (one-off) and setup-mode (saved payment method only) are ignored.
  if (session.mode !== "subscription" || !session.subscription) return;

  const tenantId = session.metadata?.tenantId;
  if (!tenantId) {
    console.warn(`[stripe] checkout.session.completed ${session.id} missing tenantId metadata — ignoring`);
    return;
  }

  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const product = await resolveProductForSubscription(stripe, subscription);

  await upsertSubscription(db, subscription, tenantId, product);
  console.log(`[stripe] subscription ${subscription.id} linked to tenant ${tenantId} (${product.name})`);
}

/**
 * `customer.subscription.updated` — plan changes (monthly→annual, tier
 * upgrades), renewals, and status flips. The tenantId is already in our
 * row from the initial checkout, so we read it out and reuse it.
 */
export async function handleSubscriptionUpdated(
  db: Db,
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<void> {
  const tenantId = await getTenantForSubscription(db, subscription.id);
  if (!tenantId) {
    console.warn(`[stripe] subscription.updated for unknown subscription ${subscription.id} — ignoring`);
    return;
  }
  const product = await resolveProductForSubscription(stripe, subscription);
  await upsertSubscription(db, subscription, tenantId, product);
}

/**
 * `customer.subscription.deleted` — subscription is gone (canceled or
 * expired). Feature-gate code will read status === "canceled" and revoke
 * access on the next request.
 */
export async function handleSubscriptionDeleted(
  db: Db,
  subscription: Stripe.Subscription,
): Promise<void> {
  await markSubscriptionCanceled(db, subscription.id);
}

/**
 * `invoice.payment_failed` — customer's card got declined or transfer
 * failed. Mark the subscription past_due so feature-gate UX can show a
 * "payment issue, please update your card" banner. Stripe's own dunning
 * (Smart Retries) will try again several times before giving up.
 */
export async function handleInvoicePaymentFailed(
  db: Db,
  invoice: Stripe.Invoice,
): Promise<void> {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  await setSubscriptionStatus(db, subscriptionId, "past_due");
}

/**
 * `invoice.paid` — renewal or dunning recovery. Flip back to active.
 * If the subscription was already active, this is a no-op.
 */
export async function handleInvoicePaid(
  db: Db,
  invoice: Stripe.Invoice,
): Promise<void> {
  const subscriptionId = getSubscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  await setSubscriptionStatus(db, subscriptionId, "active");
}

function getSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  // In 2025-09+ API the subscription reference moved off Invoice and onto
  // Invoice.parent when the invoice was generated from a subscription.
  const parent = invoice.parent;
  if (parent?.type === "subscription_details") {
    const sub = parent.subscription_details?.subscription;
    if (sub) return typeof sub === "string" ? sub : sub.id;
  }
  return null;
}

/**
 * Top-level event dispatcher. Unknown event types are logged and no-op'd
 * — Stripe sends lots of events our app doesn't care about (price changes
 * on the platform dashboard, customer metadata updates, etc.), and 200-
 * ing them is the correct response.
 */
export async function dispatchStripeEvent(
  db: Db,
  stripe: Stripe,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(db, stripe, event.data.object);
    case "customer.subscription.updated":
    case "customer.subscription.created":
      return handleSubscriptionUpdated(db, stripe, event.data.object);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(db, event.data.object);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(db, event.data.object);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handleInvoicePaid(db, event.data.object);
    default:
      // No-op; 200-ing unknown events is correct.
      return;
  }
}
