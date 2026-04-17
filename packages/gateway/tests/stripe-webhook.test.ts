import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { subscriptions, stripeWebhookEvents } from "@provara/db";
import type { Db } from "@provara/db";
import type Stripe from "stripe";
import { makeTestDb } from "./_setup/db.js";
import {
  claimWebhookEvent,
  isDuplicateWebhookEvent,
  releaseWebhookEventOnFailure,
  upsertSubscription,
  getSubscriptionForTenant,
  getTenantForSubscription,
  markSubscriptionCanceled,
  setSubscriptionStatus,
} from "../src/stripe/subscriptions.js";
import {
  dispatchStripeEvent,
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentFailed,
  handleInvoicePaid,
} from "../src/stripe/events.js";

// Mock the minimal Stripe surface the event handlers need.
function mockStripe(overrides?: {
  products?: Record<string, Stripe.Product>;
  subscriptions?: Record<string, Stripe.Subscription>;
}): Stripe {
  return {
    products: {
      retrieve: async (id: string) => {
        const p = overrides?.products?.[id];
        if (!p) throw new Error(`mock product ${id} not found`);
        return p;
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        const s = overrides?.subscriptions?.[id];
        if (!s) throw new Error(`mock subscription ${id} not found`);
        return s;
      },
    },
  } as unknown as Stripe;
}

function makeProduct(overrides: Partial<Stripe.Product> = {}): Stripe.Product {
  return {
    id: "prod_pro",
    object: "product",
    active: true,
    name: "Cloud - Pro",
    metadata: { tier: "pro", includes_intelligence: "true" },
    created: Math.floor(Date.now() / 1000),
    updated: Math.floor(Date.now() / 1000),
    ...overrides,
  } as Stripe.Product;
}

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: "sub_123",
    object: "subscription",
    customer: "cus_abc",
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        {
          id: "si_1",
          price: {
            id: "price_pro_monthly",
            product: "prod_pro",
          } as Stripe.Price,
          current_period_start: nowSec,
          current_period_end: nowSec + 30 * 86400,
        } as Stripe.SubscriptionItem,
      ],
    },
    ...overrides,
  } as Stripe.Subscription;
}

function makeInvoice(subscriptionId: string): Stripe.Invoice {
  return {
    id: "in_123",
    object: "invoice",
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: subscriptionId },
    },
  } as unknown as Stripe.Invoice;
}

describe("upsertSubscription + lookups", () => {
  let db: Db;
  beforeEach(async () => { db = await makeTestDb(); });

  it("inserts a new subscription row with denormalized tier metadata", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    const row = await db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, "sub_123")).get();
    expect(row).toBeTruthy();
    expect(row?.tenantId).toBe("tenant-1");
    expect(row?.tier).toBe("pro");
    expect(row?.includesIntelligence).toBe(true);
    expect(row?.status).toBe("active");
    expect(row?.stripePriceId).toBe("price_pro_monthly");
    expect(row?.stripeProductId).toBe("prod_pro");
  });

  it("updates the existing row on conflict (idempotent)", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    await upsertSubscription(
      db,
      makeSubscription({ status: "past_due" }),
      "tenant-1",
      makeProduct(),
    );
    const rows = await db.select().from(subscriptions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("past_due");
  });

  it("handles tier changes (Pro → Team) by updating the denormalized metadata", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    await upsertSubscription(
      db,
      makeSubscription({
        items: {
          data: [
            {
              id: "si_1",
              price: {
                id: "price_team_monthly",
                product: "prod_team",
              } as Stripe.Price,
              current_period_start: Math.floor(Date.now() / 1000),
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
            } as Stripe.SubscriptionItem,
          ],
        },
      }),
      "tenant-1",
      makeProduct({ id: "prod_team", name: "Cloud - Team", metadata: { tier: "team", includes_intelligence: "true" } }),
    );
    const row = await getSubscriptionForTenant(db, "tenant-1");
    expect(row?.tier).toBe("team");
    expect(row?.stripeProductId).toBe("prod_team");
  });

  it("getSubscriptionForTenant returns null for unknown tenants", async () => {
    expect(await getSubscriptionForTenant(db, "nobody")).toBeNull();
  });

  it("getTenantForSubscription returns the tenant when row exists", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    expect(await getTenantForSubscription(db, "sub_123")).toBe("tenant-1");
  });

  it("markSubscriptionCanceled flips status", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    await markSubscriptionCanceled(db, "sub_123");
    const row = await getSubscriptionForTenant(db, "tenant-1");
    expect(row?.status).toBe("canceled");
  });

  it("setSubscriptionStatus round-trips active/past_due", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    await setSubscriptionStatus(db, "sub_123", "past_due");
    expect((await getSubscriptionForTenant(db, "tenant-1"))?.status).toBe("past_due");
    await setSubscriptionStatus(db, "sub_123", "active");
    expect((await getSubscriptionForTenant(db, "tenant-1"))?.status).toBe("active");
  });
});

describe("webhook idempotency (claim/release)", () => {
  let db: Db;
  beforeEach(async () => { db = await makeTestDb(); });

  it("new event is not a duplicate; after claim it is", async () => {
    expect(await isDuplicateWebhookEvent(db, "evt_1")).toBe(false);
    await claimWebhookEvent(db, "evt_1", "checkout.session.completed", "{}");
    expect(await isDuplicateWebhookEvent(db, "evt_1")).toBe(true);
  });

  it("release-on-failure removes the claim so Stripe retry can re-attempt", async () => {
    await claimWebhookEvent(db, "evt_1", "x", "{}");
    expect(await isDuplicateWebhookEvent(db, "evt_1")).toBe(true);
    await releaseWebhookEventOnFailure(db, "evt_1");
    expect(await isDuplicateWebhookEvent(db, "evt_1")).toBe(false);
  });
});

describe("event handlers", () => {
  let db: Db;
  beforeEach(async () => { db = await makeTestDb(); });

  it("checkout.session.completed links tenant from session metadata", async () => {
    const stripe = mockStripe({
      products: { prod_pro: makeProduct() },
      subscriptions: { sub_123: makeSubscription() },
    });
    await handleCheckoutSessionCompleted(db, stripe, {
      id: "cs_test",
      mode: "subscription",
      subscription: "sub_123",
      metadata: { tenantId: "tenant-42" },
    } as unknown as Stripe.Checkout.Session);

    const row = await getSubscriptionForTenant(db, "tenant-42");
    expect(row?.tier).toBe("pro");
    expect(row?.stripeCustomerId).toBe("cus_abc");
  });

  it("checkout.session.completed is a no-op when tenantId metadata is missing", async () => {
    const stripe = mockStripe({ products: { prod_pro: makeProduct() } });
    await handleCheckoutSessionCompleted(db, stripe, {
      id: "cs_test",
      mode: "subscription",
      subscription: "sub_123",
      metadata: {},
    } as unknown as Stripe.Checkout.Session);
    const rows = await db.select().from(subscriptions).all();
    expect(rows).toHaveLength(0);
  });

  it("checkout.session.completed is a no-op for non-subscription mode", async () => {
    const stripe = mockStripe();
    await handleCheckoutSessionCompleted(db, stripe, {
      id: "cs_test",
      mode: "payment",
      metadata: { tenantId: "tenant-42" },
    } as unknown as Stripe.Checkout.Session);
    const rows = await db.select().from(subscriptions).all();
    expect(rows).toHaveLength(0);
  });

  it("subscription.updated refreshes tier + status without losing tenant linkage", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());

    const stripe = mockStripe({
      products: { prod_team: makeProduct({ id: "prod_team", metadata: { tier: "team", includes_intelligence: "true" } }) },
    });
    await handleSubscriptionUpdated(db, stripe, makeSubscription({
      items: {
        data: [{
          id: "si_1",
          price: { id: "price_team_monthly", product: "prod_team" } as Stripe.Price,
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        } as Stripe.SubscriptionItem],
      },
    }));

    const row = await getSubscriptionForTenant(db, "tenant-1");
    expect(row?.tier).toBe("team");
    expect(row?.tenantId).toBe("tenant-1");
  });

  it("subscription.updated for unknown subscription is ignored", async () => {
    const stripe = mockStripe({ products: { prod_pro: makeProduct() } });
    await handleSubscriptionUpdated(db, stripe, makeSubscription());
    expect(await db.select().from(subscriptions).all()).toHaveLength(0);
  });

  it("subscription.deleted marks the row canceled", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    await handleSubscriptionDeleted(db, makeSubscription());
    expect((await getSubscriptionForTenant(db, "tenant-1"))?.status).toBe("canceled");
  });

  it("invoice.payment_failed flips to past_due", async () => {
    await upsertSubscription(db, makeSubscription(), "tenant-1", makeProduct());
    await handleInvoicePaymentFailed(db, makeInvoice("sub_123"));
    expect((await getSubscriptionForTenant(db, "tenant-1"))?.status).toBe("past_due");
  });

  it("invoice.paid flips back to active", async () => {
    await upsertSubscription(db, makeSubscription({ status: "past_due" }), "tenant-1", makeProduct());
    await handleInvoicePaid(db, makeInvoice("sub_123"));
    expect((await getSubscriptionForTenant(db, "tenant-1"))?.status).toBe("active");
  });
});

describe("dispatchStripeEvent", () => {
  let db: Db;
  beforeEach(async () => { db = await makeTestDb(); });

  it("routes known events to their handlers", async () => {
    const stripe = mockStripe({
      products: { prod_pro: makeProduct() },
      subscriptions: { sub_123: makeSubscription() },
    });
    await dispatchStripeEvent(db, stripe, {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "subscription",
          subscription: "sub_123",
          metadata: { tenantId: "tenant-1" },
        },
      },
    } as unknown as Stripe.Event);

    expect((await getSubscriptionForTenant(db, "tenant-1"))?.tier).toBe("pro");
  });

  it("is a silent no-op for unknown event types", async () => {
    const stripe = mockStripe();
    await expect(
      dispatchStripeEvent(db, stripe, {
        id: "evt_weird",
        type: "some.unhandled.event",
        data: { object: {} },
      } as unknown as Stripe.Event),
    ).resolves.not.toThrow();
  });
});
