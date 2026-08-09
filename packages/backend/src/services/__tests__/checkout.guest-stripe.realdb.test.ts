/**
 * Guest checkout on the Stripe rail, end to end, against a REAL Postgres
 * database (#107, ADR 0006).
 *
 * `checkout.stripe.realdb.test.ts` proves the rail for an Oxy buyer. This file
 * proves the four things that are only true of a GUEST, and every one of them
 * lives in a gap a mock has no way to reach:
 *
 *  - the PaymentIntent's `guestCheckoutId` is the id of a row that really
 *    exists, written in the orders' own transaction (a mocked repository would
 *    return whatever it was told to);
 *  - a converging replay composes BYTE-IDENTICAL metadata, which is what keeps
 *    the reused idempotency key valid — and it is only interesting because the
 *    guest id comes from a second table, read again on the converge path;
 *  - verified success produces exactly ONE `guest_portal_initialization` row
 *    however many times the event is delivered, held by the outbox's primary key
 *    and not by a counter;
 *  - the payment-status read is scoped through `guest_checkouts.guest_session_id`
 *    — a JOIN, so another guest's session answers 404 rather than 403.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * nothing here truncates a table another file uses. Every id is minted per run
 * and every assertion is scoped to rows this file wrote.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';

/**
 * The paid transition fires best-effort buyer/seller notifications. Left
 * unmocked they buffer against infrastructure this file has no reason to open.
 */
vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowStockAlert: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));

const PLATFORM_SECRET = 'whsec_guest_checkout_not_a_real_one';

/** The fake Stripe API. Hoisted so the `vi.mock` factory can close over it. */
const api = vi.hoisted(() => ({
  intents: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
  transfers: new Map<string, Record<string, unknown>>(),
  /** Idempotency key → the object that key already produced (Stripe's own rule). */
  byKey: new Map<string, Record<string, unknown>>(),
  intentCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  nextId: 0,
}));

vi.mock('../payments/stripe/client.js', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  getStripeClient: () => {
    throw new Error('This suite must not construct a real Stripe client.');
  },
  resetStripeClient: () => undefined,
  createStripePaymentIntent: (params: Record<string, unknown>, idempotencyKey: string) => {
    api.intentCalls.push({ params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    api.nextId += 1;
    const id = `pi_guest_${String(api.nextId)}`;
    const intent = {
      id,
      object: 'payment_intent',
      status: 'requires_payment_method',
      amount: params.amount,
      currency: params.currency,
      metadata: params.metadata,
      client_secret: `${id}_secret_guest`,
    };
    api.intents.set(id, intent);
    api.byKey.set(idempotencyKey, intent);
    return Promise.resolve(intent);
  },
  retrieveStripePaymentIntent: (id: string) => {
    const intent = api.intents.get(id);
    if (!intent) throw new Error(`No fake PaymentIntent registered for ${id}`);
    return Promise.resolve(intent);
  },
  cancelStripePaymentIntent: (id: string) => {
    const intent = api.intents.get(id);
    if (!intent) throw new Error(`No fake PaymentIntent registered for ${id}`);
    intent.status = 'canceled';
    return Promise.resolve(intent);
  },
  retrieveStripeChargeWithBalance: (id: string) => {
    const charge = api.charges.get(id);
    if (!charge) throw new Error(`No fake charge registered for ${id}`);
    return Promise.resolve(charge);
  },
  createStripeTransfer: (params: Record<string, unknown>, idempotencyKey: string) => {
    api.nextId += 1;
    const id = `tr_guest_${String(api.nextId)}`;
    const transfer = { id, object: 'transfer', ...params };
    api.transfers.set(id, transfer);
    api.byKey.set(idempotencyKey, transfer);
    return Promise.resolve(transfer);
  },
  createStripeRefund: () => {
    throw new Error('This suite makes no refunds.');
  },
  createStripeTransferReversal: () => {
    throw new Error('This suite makes no reversals.');
  },
}));

/** A per-run suffix, so nothing this file writes can collide with a sibling's. */
const RUN = Math.random().toString(36).slice(2, 10);

let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let checkout: typeof import('../checkout.service.js').checkout;
let readCheckoutPaymentStatus: typeof import('../payments/checkout-payment.service.js').readCheckoutPaymentStatus;
let ingestStripeDelivery: typeof import('../payments/stripe/ingress.js').ingestStripeDelivery;
let issueGuestSession: typeof import('../guest-session.service.js').issueGuestSession;
let insertVariants: typeof import('../../db/catalog/variantRepository.js').insertVariants;
let insertLocation: typeof import('../../db/stores/locationRepository.js').insertLocation;
let insertLevels: typeof import('../../db/catalog/inventoryLevelRepository.js').insertLevels;
let upsertUserPreference: typeof import('../../db/buyers/userPreferenceRepository.js').upsertUserPreference;
let ensureCart: typeof import('../../db/buyers/cartRepository.js').ensureCart;
let upsertCartItem: typeof import('../../db/buyers/cartRepository.js').upsertCartItem;
let insertProviderAccount: typeof import('../../db/payments/providerAccountRepository.js').insertProviderAccount;
let applyProviderAccountState: typeof import('../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let paymentSchema: typeof import('../../db/schema/payments.js');
let orderSchema: typeof import('../../db/schema/orders.js');
let catalogSchema: typeof import('../../db/schema/catalog.js');
let guestSchema: typeof import('../../db/schema/guests.js');
let storeSchema: typeof import('../../db/schema/stores.js');

const INLINE_ADDRESS = {
  recipientName: 'Guest Buyer',
  line1: 'Carrer de Colon 1',
  city: 'Valencia',
  postalCode: '46004',
  country: 'ES',
};

beforeAll(async () => {
  // Set BEFORE any import that reads config: `config/index.ts` reads the
  // environment once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_guest_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_guest_connect_not_a_real_one';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_guest_not_a_real_key';
  process.env.STRIPE_PLATFORM_CURRENCY = 'EUR';
  process.env.STRIPE_PRESENTMENT_CURRENCIES = 'EUR,USD';
  process.env.FX_PROVIDER = 'static';
  // Guest commerce, and the two keys the M8 half-configuration rule demands.
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  // A REAL 32-byte key: `lib/guest-pii.ts` refuses anything else, and the
  // contact row is encrypted inside the orders' own transaction.
  process.env.GUEST_PII_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.GUEST_EMAIL_HASH_KEY = 'b'.repeat(64);
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';
  process.env.GUEST_CART_ENABLED = 'true';
  process.env.GUEST_INLINE_DESTINATION_ENABLED = 'true';
  // No lever set: this file is about the rail, and a kill switch firing would
  // refuse every case in it for the wrong reason.
  delete process.env.GUEST_CHECKOUT_BLOCKED_PLATFORMS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_MARKETS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_SELLER_KEYS;
  delete process.env.GUEST_CHECKOUT_BLOCKED_FULFILMENT_METHODS;
  delete process.env.GUEST_SELLER_ACTIVATION_REQUIRED;

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  ({ checkout } = await import('../checkout.service.js'));
  ({ readCheckoutPaymentStatus } = await import('../payments/checkout-payment.service.js'));
  ({ ingestStripeDelivery } = await import('../payments/stripe/ingress.js'));
  ({ issueGuestSession } = await import('../guest-session.service.js'));
  ({ insertVariants } = await import('../../db/catalog/variantRepository.js'));
  ({ insertLocation } = await import('../../db/stores/locationRepository.js'));
  ({ insertLevels } = await import('../../db/catalog/inventoryLevelRepository.js'));
  ({ upsertUserPreference } = await import('../../db/buyers/userPreferenceRepository.js'));
  ({ ensureCart, upsertCartItem } = await import('../../db/buyers/cartRepository.js'));
  ({ insertProviderAccount, applyProviderAccountState } = await import(
    '../../db/payments/providerAccountRepository.js'
  ));
  paymentSchema = await import('../../db/schema/payments.js');
  orderSchema = await import('../../db/schema/orders.js');
  catalogSchema = await import('../../db/schema/catalog.js');
  guestSchema = await import('../../db/schema/guests.js');
  storeSchema = await import('../../db/schema/stores.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  api.intents.clear();
  api.charges.clear();
  api.transfers.clear();
  api.byKey.clear();
  api.intentCalls.length = 0;
});

/**
 * A payment-ready STORE and its listing.
 *
 * A store rather than an individual, because ADR 0003 D18 refuses a guest
 * checkout from a `user` seller and #112 owns any reversal — so a P2P fixture
 * here would be refused before the rail was ever consulted.
 */
async function seedStoreSeller(label: string): Promise<{
  storeId: string;
  listingId: string;
  variantId: string;
}> {
  const [store] = await db
    .insert(storeSchema.stores)
    .values({
      handle: `guest-${RUN}-${label}`,
      name: `Guest Store ${label} ${RUN}`,
      description: 'seeded by checkout.guest-stripe.realdb.test',
      brandColor: '#000000',
      defaultCurrency: 'EUR',
    })
    .returning({ id: storeSchema.stores.id });

  const account = await insertProviderAccount(db, {
    provider: 'stripe',
    ownerType: 'store',
    ownerId: store.id,
    providerAccountId: `acct_guest_${RUN}_${label}`,
    country: 'ES',
  });
  await applyProviderAccountState(db, {
    id: account.id,
    state: {
      onboardingState: 'ready',
      chargesEnabled: false,
      payoutsEnabled: true,
      transfersCapability: 'active',
      requirementsCurrentlyDue: 0,
      requirementsEventuallyDue: 0,
      requirementsPastDue: 0,
      requirementsPendingVerification: 0,
      disabledReasonCodes: [],
      syncedAt: new Date(),
    },
  });

  // A store's stock lives at a LOCATION, so the reservation needs a default one
  // to resolve to — a P2P seller's does not, which is the whole reason this
  // fixture is heavier than its sibling's.
  const location = await insertLocation(store.id, {
    name: 'Warehouse',
    type: 'warehouse',
    isDefault: true,
    isActive: true,
    fulfillsOnlineOrders: true,
  });

  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'store',
      storeId: store.id,
      title: `Guest Thing ${label}`,
      description: '',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning();
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: 5_000,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
      position: 0,
      optionValues: [],
    },
  ]);

  await insertLevels([
    {
      variantId: variant.id,
      listingId: listing.id,
      locationId: location.id,
      available: 5,
      committed: 0,
    },
  ]);

  return { storeId: store.id, listingId: listing.id, variantId: variant.id };
}

/** A live guest session holding a cart with one line. */
async function seedGuestCart(line: {
  listingId: string;
  variantId: string;
  quantity: number;
}): Promise<{ guestSessionId: string }> {
  const issued = await issueGuestSession({ clientClass: 'web', now: new Date() });
  const cart = await ensureCart({ kind: 'guest_session', guestSessionId: issued.session.id });
  await upsertCartItem(cart.id, line);
  return { guestSessionId: issued.session.id };
}

/** Make the fake rail report a successful capture, with its balance transaction. */
function fundIntent(intentId: string): void {
  const intent = api.intents.get(intentId);
  if (!intent) throw new Error(`No fake PaymentIntent registered for ${intentId}`);
  const chargeId = `ch_${intentId}`;
  intent.status = 'succeeded';
  intent.latest_charge = chargeId;
  api.charges.set(chargeId, {
    id: chargeId,
    object: 'charge',
    payment_intent: intentId,
    balance_transaction: {
      id: `txn_${intentId}`,
      object: 'balance_transaction',
      amount: Number(intent.amount),
      currency: 'eur',
      exchange_rate: null,
      fee: 155,
      created: Math.floor(Date.now() / 1000),
    },
  });
}

/** Deliver a signed PaymentIntent event to the REAL platform-scope ingress. */
async function deliverIntentEvent(input: {
  eventId: string;
  type: string;
  intentId: string;
}): Promise<void> {
  const intent = api.intents.get(input.intentId);
  if (!intent) throw new Error(`No fake PaymentIntent registered for ${input.intentId}`);

  const payload = JSON.stringify({
    id: `${input.eventId}-${RUN}`,
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: input.type,
    data: { object: { ...intent } },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: PLATFORM_SECRET,
  });
  await ingestStripeDelivery({
    payload: Buffer.from(payload, 'utf8'),
    signature,
    scope: 'platform',
  });
}

describe('a guest pays for a store order', () => {
  it('carries the REAL guest_checkouts id into the PaymentIntent metadata', async () => {
    const seller = await seedStoreSeller('meta');
    const { guestSessionId } = await seedGuestCart({
      listingId: seller.listingId,
      variantId: seller.variantId,
      quantity: 1,
    });

    const result = await checkout(
      { kind: 'guest', guestSessionId, transport: 'cookie' },
      {
        destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
        contact: { email: 'guest.meta@example.com' },
      },
      `idem-meta-${RUN}`,
      'EUR',
    );

    // The row the checkout transaction really wrote — not a value the metadata
    // composer was handed.
    const [contact] = await db
      .select({ id: guestSchema.guestCheckouts.id })
      .from(guestSchema.guestCheckouts)
      .where(eq(guestSchema.guestCheckouts.checkoutGroupId, result.checkoutGroupId));
    expect(contact).toBeDefined();

    const [call] = api.intentCalls;
    expect(call.params.metadata).toEqual({
      paymentId: expect.any(String) as unknown as string,
      checkoutGroupId: result.checkoutGroupId,
      guestCheckoutId: contact.id,
      orderCount: '1',
      orderIds: expect.any(String) as unknown as string,
    });
    // The whole point of the key: it is durable and inert. Nothing about the
    // SESSION is in there, and the session is the thing that can be purged.
    expect(JSON.stringify(call.params.metadata)).not.toContain(guestSessionId);
    expect(JSON.stringify(call.params.metadata)).not.toContain('guest.meta@example.com');
  });

  it('composes BYTE-IDENTICAL metadata when two submits converge', async () => {
    const seller = await seedStoreSeller('replay');
    const { guestSessionId } = await seedGuestCart({
      listingId: seller.listingId,
      variantId: seller.variantId,
      quantity: 1,
    });
    const actor = { kind: 'guest', guestSessionId, transport: 'cookie' } as const;
    const body = {
      destination: { type: 'inline_shipping_address' as const, address: INLINE_ADDRESS },
      contact: { email: 'guest.replay@example.com' },
    };
    const key = `idem-replay-${RUN}`;

    // Both submits start against the SAME full cart — the double-tap, and the
    // shape the durable guarantee is actually for. Redis is best-effort and is
    // not running here, so what converges these two is
    // `orders_idempotency_key_key`: the loser rolls its reservations back and
    // returns the winner's group.
    //
    // The loser reaches `openCheckoutPayment` with a group it did NOT create,
    // and therefore with no contact record in hand — which is exactly why the
    // guest id in the metadata is read from the group rather than passed in.
    const [first, replay] = await Promise.all([
      checkout(actor, body, key, 'EUR'),
      checkout(actor, body, key, 'EUR'),
    ]);

    expect(replay.checkoutGroupId).toBe(first.checkoutGroupId);
    expect(replay.payment?.clientSecret).toBe(first.payment?.clientSecret);
    expect(replay.payment?.paymentId).toBe(first.payment?.paymentId);

    const [contact] = await db
      .select({ id: guestSchema.guestCheckouts.id })
      .from(guestSchema.guestCheckouts)
      .where(eq(guestSchema.guestCheckouts.checkoutGroupId, first.checkoutGroupId));

    // ONE guest contact row for the group, and every metadata composition of it
    // is byte-identical — which is what keeps the reused `pi:<paymentId>`
    // idempotency key valid at the rail. A differing key or a differing body
    // would be a SECOND charge for the same goods.
    const bodies = api.intentCalls.map((call) => JSON.stringify(call.params.metadata));
    expect(new Set(bodies).size).toBe(1);
    expect(new Set(api.intentCalls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(bodies[0]).toContain(contact.id);
    expect(api.intents.size).toBe(1);
  });
});

describe('verified success hands #108 exactly one portal initialization', () => {
  it('writes one row per checkout GROUP, however many times the event arrives', async () => {
    const seller = await seedStoreSeller('portal');
    const { guestSessionId } = await seedGuestCart({
      listingId: seller.listingId,
      variantId: seller.variantId,
      quantity: 1,
    });

    const result = await checkout(
      { kind: 'guest', guestSessionId, transport: 'cookie' },
      {
        destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
        contact: { email: 'guest.portal@example.com' },
      },
      `idem-portal-${RUN}`,
      'EUR',
    );
    const [intentId] = [...api.intents.keys()];
    fundIntent(intentId);

    await deliverIntentEvent({
      eventId: `evt-portal-1`,
      type: 'payment_intent.succeeded',
      intentId,
    });
    // A REDELIVERY of the same success, with a different provider event id —
    // which is the ordinary case (Stripe retries) and the one a counter would
    // get wrong.
    await deliverIntentEvent({
      eventId: `evt-portal-2`,
      type: 'payment_intent.succeeded',
      intentId,
    });

    const orders = await db
      .select({ id: orderSchema.orders.id, status: orderSchema.orders.status })
      .from(orderSchema.orders)
      .where(eq(orderSchema.orders.checkoutGroupId, result.checkoutGroupId));
    expect(orders.map((order) => order.status)).toEqual(['paid']);

    const rows = await db
      .select({
        id: paymentSchema.paymentOutboxes.id,
        payload: paymentSchema.paymentOutboxes.payload,
      })
      .from(paymentSchema.paymentOutboxes)
      .where(
        and(
          eq(paymentSchema.paymentOutboxes.eventType, 'guest_portal_initialization'),
          eq(
            paymentSchema.paymentOutboxes.id,
            `payment:guest_portal_initialization:${result.checkoutGroupId}`,
          ),
        ),
      );
    expect(rows).toHaveLength(1);

    const [contact] = await db
      .select({ id: guestSchema.guestCheckouts.id })
      .from(guestSchema.guestCheckouts)
      .where(eq(guestSchema.guestCheckouts.checkoutGroupId, result.checkoutGroupId));
    // The payload carries what #108 needs and nothing a person could be read
    // out of: two opaque Mercaria ids and the group's order ids.
    expect(rows[0].payload).toEqual({
      checkoutGroupId: result.checkoutGroupId,
      guestCheckoutId: contact.id,
      orderIds: orders.map((order) => order.id),
    });
  });

  it('writes NO portal row for an Oxy buyer s group', async () => {
    const seller = await seedStoreSeller('oxy');
    const buyerId = `buyer-${RUN}-oxy`;
    // An Oxy buyer's presentment currency is their STORED preference, and the
    // `currency` request field is ignored for them — which is exactly why it is
    // set here and passed in the guest cases above.
    await upsertUserPreference(buyerId, { preferredCurrency: 'EUR' });
    const cart = await ensureCart({ kind: 'oxy_user', oxyUserId: buyerId });
    await upsertCartItem(cart.id, {
      listingId: seller.listingId,
      variantId: seller.variantId,
      quantity: 1,
    });

    const result = await checkout(
      { kind: 'oxy', oxyUserId: buyerId },
      { destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS } },
      `idem-oxy-${RUN}`,
    );
    const [intentId] = [...api.intents.keys()];
    fundIntent(intentId);
    await deliverIntentEvent({ eventId: 'evt-oxy-1', type: 'payment_intent.succeeded', intentId });

    const rows = await db
      .select({ id: paymentSchema.paymentOutboxes.id })
      .from(paymentSchema.paymentOutboxes)
      .where(
        eq(
          paymentSchema.paymentOutboxes.id,
          `payment:guest_portal_initialization:${result.checkoutGroupId}`,
        ),
      );
    expect(rows).toHaveLength(0);
  });
});

describe('the payment-status read is scoped through the guest contact record', () => {
  it('answers the placing session and 404s a different one', async () => {
    const seller = await seedStoreSeller('status');
    const { guestSessionId } = await seedGuestCart({
      listingId: seller.listingId,
      variantId: seller.variantId,
      quantity: 1,
    });
    const result = await checkout(
      { kind: 'guest', guestSessionId, transport: 'cookie' },
      {
        destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
        contact: { email: 'guest.status@example.com' },
      },
      `idem-status-${RUN}`,
      'EUR',
    );

    const mine = await readCheckoutPaymentStatus(
      { kind: 'guest_session', guestSessionId },
      result.checkoutGroupId,
    );
    expect(mine.checkoutGroupId).toBe(result.checkoutGroupId);
    expect(mine.orders).toHaveLength(1);

    // Another live guest, holding nothing of this checkout but the group id —
    // which is a server-issued uuid and NOT a credential. A 404, not a 403:
    // the existence of somebody else's checkout is not a fact to confirm.
    const other = await issueGuestSession({ clientClass: 'web', now: new Date() });
    await expect(
      readCheckoutPaymentStatus(
        { kind: 'guest_session', guestSessionId: other.session.id },
        result.checkoutGroupId,
      ),
    ).rejects.toThrow(/not found/i);
  });
});
