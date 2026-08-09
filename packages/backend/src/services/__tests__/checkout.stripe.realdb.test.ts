/**
 * Checkout on the Stripe rail, end to end, against a REAL Postgres database.
 *
 * The cart is real, the reservation is real, the orders are real, the payment
 * aggregate and its ledger are real, the webhook is verified by the REAL Stripe
 * SDK against a REAL signature, and the settlement writes real transfers and
 * real postings. Only Stripe's own API is faked, and only because a sandbox
 * cannot make a charge succeed without a browser.
 *
 * ## Why none of this can be a mocked test
 *
 * Every property here lives in a gap no mock has:
 *
 *  - "one PaymentIntent per checkout group, however many times you submit" is
 *    held by a UNIQUE index on `payments.checkout_group_id` and a per-order
 *    `orders_idempotency_key_key`, and a mocked insert refuses neither;
 *  - "the ledger balances and the seller's payable closes" is arithmetic across
 *    two transactions written by two different modules — the second one only
 *    cancels the first if both agree on the currency and the amount;
 *  - "a withheld transfer does not touch its sibling" is a loop that has to
 *    survive a real failure in the middle of it;
 *  - "a late capture after the sweep raises an exception instead of overselling"
 *    crosses the reservation sweep, the order state machine, the payment CAS and
 *    the webhook ingress, and any one of them being mocked would prove nothing.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * nothing here truncates a table another file uses. Every id is minted per test
 * and every assertion is scoped to rows this file wrote — the stronger form
 * anyway, since a table-wide count starts passing for the wrong reason as soon
 * as somebody else adds a fixture.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import { and, eq, sql } from 'drizzle-orm';

/**
 * The paid transition fires best-effort buyer/seller notifications. Left
 * unmocked they buffer against infrastructure this file has no reason to open,
 * and then swallow the failure — so the tests would spend their time on a side
 * effect none of them asserts.
 */
vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowInventoryAlert: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));

const PLATFORM_SECRET = 'whsec_checkout_stripe_not_a_real_one';

/** The fake Stripe API. Hoisted so the `vi.mock` factory can close over it. */
const api = vi.hoisted(() => ({
  intents: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, Record<string, unknown>>(),
  transfers: new Map<string, Record<string, unknown>>(),
  /** Idempotency key → the object that key already produced (Stripe's own rule). */
  byKey: new Map<string, Record<string, unknown>>(),
  intentCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  transferCalls: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  cancelCalls: [] as string[],
  /** What the rail's conversion does to a non-EUR charge, in minor units per unit. */
  exchangeRate: 0.9,
  /** What Stripe keeps, in the settlement currency. */
  fee: 155,
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
    const id = `pi_e2e_${String(api.nextId)}`;
    const intent = {
      id,
      object: 'payment_intent',
      status: 'requires_payment_method',
      amount: params.amount,
      currency: params.currency,
      metadata: params.metadata,
      client_secret: `${id}_secret_e2e`,
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
    api.cancelCalls.push(id);
    const intent = api.intents.get(id);
    if (!intent) throw new Error(`No fake PaymentIntent registered for ${id}`);
    if (intent.status === 'succeeded') {
      throw Object.assign(
        new Error('You cannot cancel this PaymentIntent because it has a status of succeeded.'),
        { type: 'StripeInvalidRequestError', code: 'payment_intent_unexpected_state' },
      );
    }
    intent.status = 'canceled';
    return Promise.resolve(intent);
  },
  retrieveStripeChargeWithBalance: (id: string) => {
    const charge = api.charges.get(id);
    if (!charge) throw new Error(`No fake charge registered for ${id}`);
    return Promise.resolve(charge);
  },
  createStripeTransfer: (params: Record<string, unknown>, idempotencyKey: string) => {
    api.transferCalls.push({ params, idempotencyKey });
    const existing = api.byKey.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    api.nextId += 1;
    const transfer = { id: `tr_e2e_${String(api.nextId)}`, object: 'transfer', ...params };
    api.transfers.set(String(transfer.id), transfer);
    api.byKey.set(idempotencyKey, transfer);
    return Promise.resolve(transfer);
  },
  retrieveStripeTransfer: (id: string) => Promise.resolve(api.transfers.get(id)),
  createStripeConnectedAccount: () => {
    throw new Error('This suite creates no connected accounts.');
  },
  retrieveStripeAccount: () => {
    throw new Error('This suite reads no connected accounts.');
  },
  createStripeAccountLink: () => {
    throw new Error('This suite mints no account links.');
  },
  // #49's reads and writes. Present so the mocked module offers every export the
  // real one does — a named import missing from a mock factory fails at link
  // time — and each throws, which doubles as an assertion that the checkout path
  // reaches none of them.
  retrieveStripeChargeWithRefunds: () => {
    throw new Error('This suite reads no charge refunds.');
  },
  createStripeRefund: () => {
    throw new Error('This suite creates no refund.');
  },
  retrieveStripeRefund: () => {
    throw new Error('This suite reads no refund.');
  },
  createStripeTransferReversal: () => {
    throw new Error('This suite reverses no transfer.');
  },
  retrieveStripeDispute: () => {
    throw new Error('This suite reads no dispute.');
  },
  retrieveStripePayout: () => {
    throw new Error('This suite reads no payout.');
  },
}));

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type Database = import('../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let checkout: typeof import('../checkout.service.js').checkout;
let readCheckoutPaymentStatus: typeof import('../payments/checkout-payment.service.js').readCheckoutPaymentStatus;
let ingestStripeDelivery: typeof import('../payments/stripe/ingress.js').ingestStripeDelivery;
let handleExpireReservations: typeof import('../../queue/handlers.js').handleExpireReservations;
let insertVariants: typeof import('../../db/catalog/variantRepository.js').insertVariants;
let findVariantsByIds: typeof import('../../db/catalog/variantRepository.js').findVariantsByIds;
let insertAddress: typeof import('../../db/buyers/addressRepository.js').insertAddress;
let ensureCart: typeof import('../../db/buyers/cartRepository.js').ensureCart;
let upsertCartItem: typeof import('../../db/buyers/cartRepository.js').upsertCartItem;
let ensureSellerProfile: typeof import('../../db/buyers/sellerProfileRepository.js').ensureSellerProfile;
let upsertUserPreference: typeof import('../../db/buyers/userPreferenceRepository.js').upsertUserPreference;
let insertProviderAccount: typeof import('../../db/payments/providerAccountRepository.js').insertProviderAccount;
let applyProviderAccountState: typeof import('../../db/payments/providerAccountRepository.js').applyProviderAccountState;
let findNativePaymentByCheckoutGroupId: typeof import('../../db/payments/paymentRepository.js').findNativePaymentByCheckoutGroupId;
let findOrdersInCheckoutGroup: typeof import('../../db/orders/orderRepository.js').findOrdersInCheckoutGroup;
let paymentSchema: typeof import('../../db/schema/payments.js');
let ledgerSchema: typeof import('../../db/schema/ledger.js');
let orderSchema: typeof import('../../db/schema/orders.js');
let catalogSchema: typeof import('../../db/schema/catalog.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_checkout_stripe_connect';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_not_a_real_key';
  // The platform settles in EUR and accepts EUR/USD presentment — ADR 0001 D8's
  // launch configuration, stated rather than inherited so a change to the
  // default is a failing test here rather than a surprise in production.
  process.env.STRIPE_PLATFORM_CURRENCY = 'EUR';
  process.env.STRIPE_PRESENTMENT_CURRENCIES = 'EUR,USD';
  // Deterministic FX for the cart's own native → presentment conversions. The
  // rail's presentment → platform conversion is separate and comes from the fake
  // balance transaction.
  process.env.FX_PROVIDER = 'static';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  // Dynamic, like every realdb file here: a STATIC import pulls
  // `config/index.ts` at module load, before the STRIPE_* values above exist.
  ({ checkout } = await import('../checkout.service.js'));
  ({ readCheckoutPaymentStatus } = await import('../payments/checkout-payment.service.js'));
  ({ ingestStripeDelivery } = await import('../payments/stripe/ingress.js'));
  ({ handleExpireReservations } = await import('../../queue/handlers.js'));
  ({ insertVariants, findVariantsByIds } = await import('../../db/catalog/variantRepository.js'));
  ({ insertAddress } = await import('../../db/buyers/addressRepository.js'));
  ({ ensureCart, upsertCartItem } = await import('../../db/buyers/cartRepository.js'));
  ({ ensureSellerProfile } = await import('../../db/buyers/sellerProfileRepository.js'));
  ({ upsertUserPreference } = await import('../../db/buyers/userPreferenceRepository.js'));
  ({ insertProviderAccount, applyProviderAccountState } = await import(
    '../../db/payments/providerAccountRepository.js'
  ));
  ({ findNativePaymentByCheckoutGroupId } = await import(
    '../../db/payments/paymentRepository.js'
  ));
  ({ findOrdersInCheckoutGroup } = await import('../../db/orders/orderRepository.js'));
  paymentSchema = await import('../../db/schema/payments.js');
  ledgerSchema = await import('../../db/schema/ledger.js');
  orderSchema = await import('../../db/schema/orders.js');
  catalogSchema = await import('../../db/schema/catalog.js');
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
  api.transferCalls.length = 0;
  api.cancelCalls.length = 0;
  api.exchangeRate = 0.9;
  api.fee = 155;
});

/** A payment-ready seller with a connected account, and their listing. */
async function seedSeller(input: {
  label: string;
  priceMinor: number;
  currency: 'EUR' | 'USD';
  available?: number;
}): Promise<{ sellerId: string; accountId: string; listingId: string; variantId: string }> {
  const sellerId = `seller-${RUN}-${input.label}`;
  const accountId = `acct_${RUN}_${input.label}`;
  await ensureSellerProfile(sellerId);

  const account = await insertProviderAccount(db, {
    provider: 'stripe',
    ownerType: 'user',
    ownerId: sellerId,
    providerAccountId: accountId,
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

  // Inserted through the table rather than `insertListing`, so the column
  // defaults apply: this fixture cares about the owner, the price and the stock,
  // and spelling out thirty columns it does not read would be a fixture that
  // breaks whenever the catalogue gains one.
  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'user',
      oxyUserId: sellerId,
      title: `Thing ${input.label}`,
      description: '',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning();
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: input.priceMinor,
      priceCurrency: input.currency,
      inventoryTracked: true,
      inventoryAvailable: input.available ?? 5,
      position: 0,
      optionValues: [],
    },
  ]);

  return { sellerId, accountId, listingId: listing.id, variantId: variant.id };
}

/** A buyer with a saved address, a presentment currency and a cart. */
async function seedBuyer(input: {
  label: string;
  currency: 'EUR' | 'USD' | 'GBP';
  lines: { listingId: string; variantId: string; quantity: number }[];
}): Promise<{ buyerId: string; addressId: string }> {
  const buyerId = `buyer-${RUN}-${input.label}`;
  await upsertUserPreference(buyerId, { preferredCurrency: input.currency });

  const address = await insertAddress(buyerId, {
    recipientName: 'Buyer',
    line1: '1 Street',
    city: 'Barcelona',
    postalCode: '08001',
    country: 'ES',
  });

  const cart = await ensureCart({ kind: 'oxy_user', oxyUserId: buyerId });
  for (const line of input.lines) {
    await upsertCartItem(cart.id, line);
  }
  return { buyerId, addressId: address.id };
}

/**
 * Make the fake rail report a successful capture, and register the charge and
 * BALANCE TRANSACTION the ingress reads the platform amount and fee from.
 *
 * `platformAmount` is what the charge became in EUR: the same figure for a EUR
 * charge, and the converted one for a USD charge — which is the case that makes
 * the ledger and the transfers change currency.
 */
function fundIntent(intentId: string): { chargeId: string; platformAmount: number } {
  const intent = api.intents.get(intentId);
  if (!intent) throw new Error(`No fake PaymentIntent registered for ${intentId}`);
  const chargeId = `ch_${intentId}`;
  const converted = intent.currency === 'eur';
  const platformAmount = converted
    ? Number(intent.amount)
    : Math.round(Number(intent.amount) * api.exchangeRate);

  intent.status = 'succeeded';
  intent.latest_charge = chargeId;
  api.charges.set(chargeId, {
    id: chargeId,
    object: 'charge',
    payment_intent: intentId,
    balance_transaction: {
      id: `txn_${intentId}`,
      object: 'balance_transaction',
      amount: platformAmount,
      currency: 'eur',
      exchange_rate: converted ? null : api.exchangeRate,
      fee: api.fee,
      created: Math.floor(Date.now() / 1000),
    },
  });
  return { chargeId, platformAmount };
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

/** Every ledger entry this payment produced, flattened for assertion. */
async function ledgerEntriesFor(
  paymentId: string,
): Promise<{ kind: string; account: string; currency: string; amount: bigint }[]> {
  const rows = await db
    .select({
      kind: ledgerSchema.ledgerTransactions.kind,
      account: ledgerSchema.ledgerEntries.account,
      currency: ledgerSchema.ledgerEntries.currency,
      amount: ledgerSchema.ledgerEntries.amountMinor,
    })
    .from(ledgerSchema.ledgerEntries)
    .innerJoin(
      ledgerSchema.ledgerTransactions,
      eq(ledgerSchema.ledgerEntries.transactionId, ledgerSchema.ledgerTransactions.id),
    )
    .where(eq(ledgerSchema.ledgerTransactions.paymentId, paymentId))
    .orderBy(ledgerSchema.ledgerTransactions.createdAt, ledgerSchema.ledgerEntries.createdAt);
  return rows.map((row) => ({ ...row, amount: BigInt(row.amount) }));
}

/** The payment's transfers, oldest first. */
async function transfersFor(paymentId: string) {
  return await db
    .select()
    .from(paymentSchema.transfers)
    .where(eq(paymentSchema.transfers.paymentId, paymentId))
    .orderBy(paymentSchema.transfers.createdAt);
}

/** The outbox rows this payment produced, by event type. */
async function outboxTypesFor(paymentId: string): Promise<string[]> {
  const rows = await db
    .select({ type: paymentSchema.paymentOutboxes.eventType })
    .from(paymentSchema.paymentOutboxes)
    .where(sql`${paymentSchema.paymentOutboxes.payload}->>'paymentId' = ${paymentId}`)
    .orderBy(paymentSchema.paymentOutboxes.createdAt);
  return rows.map((row) => row.type);
}

/** One variant's stock, as the columns actually hold it. */
async function stockOf(variantId: string): Promise<{ available: number; committed: number }> {
  const [variant] = await findVariantsByIds([variantId]);
  return { available: variant.inventoryAvailable, committed: variant.inventoryCommitted };
}

describe('checkout on the Stripe rail — single seller', () => {
  it('creates ONE PaymentIntent carrying everything ADR 0001 D11 requires', async () => {
    const seller = await seedSeller({ label: 'eur1', priceMinor: 4_500, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'eur1',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-eur1`);

    expect(result.orders).toHaveLength(1);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(payment?.provider).toBe('stripe');

    // The charge is the ORDER's own grand total — shipping included — not the
    // cart subtotal: the buyer must be charged the figure their order states.
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(api.intentCalls).toHaveLength(1);
    const [call] = api.intentCalls;
    expect(call.params).toMatchObject({
      amount: order.totalsGrandTotalPresentmentAmount,
      currency: 'eur',
      capture_method: 'automatic',
      payment_method_types: ['card'],
      transfer_group: result.checkoutGroupId,
    });
    expect(call.params.metadata).toEqual({
      paymentId: payment?.id,
      checkoutGroupId: result.checkoutGroupId,
      orderCount: '1',
      orderIds: order.id,
    });
    expect(call.idempotencyKey).toBe(`pi:${String(payment?.id)}`);

    // The handoff carries the client material and NOTHING else (issue #47,
    // backend 7): no charge id, no connected account, no seller identity.
    //
    // Exhaustive on purpose, and it earned its keep when #107 added `methods`:
    // a field appearing in the buyer's handoff has to be a decision somebody
    // made, not a spread that grew. `methods` is the server-authoritative
    // payment-surface set (ADR 0006 G2/G14) — a list of what a client may
    // RENDER, carrying nothing about the buyer, the seller or the charge.
    // `returnUrl` is absent because this deployment configures no return origin.
    expect(result.payment).toEqual({
      paymentId: payment?.id,
      provider: 'stripe',
      clientSecret: `${String(payment?.providerObjectId)}_secret_e2e`,
      publishableKey: 'pk_test_not_a_real_key',
      amount: {
        amount: order.totalsGrandTotalPresentmentAmount,
        currency: 'EUR',
      },
      methods: ['card', 'apple_pay', 'google_pay', 'link'],
    });
  });

  it('pays the order, books a balanced ledger and settles the seller', async () => {
    const seller = await seedSeller({ label: 'eur2', priceMinor: 4_500, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'eur2',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-eur2`);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const paymentId = String(payment?.id);
    const intentId = String(payment?.providerObjectId);
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    const gross = order.totalsGrandTotalPresentmentAmount;

    const { chargeId } = fundIntent(intentId);
    await deliverIntentEvent({
      eventId: 'evt-eur2',
      type: 'payment_intent.succeeded',
      intentId,
    });

    // The order is paid and its stock committed — by the ORDER transition, which
    // is the only thing that moves inventory.
    const [paid] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(paid.status).toBe('paid');
    expect(paid.paymentStatus).toBe('paid');
    // The reservation was CONSUMED, not released: `available` stays down (the
    // unit left the shelf at reserve time) and `committed` returns to zero (it
    // is no longer merely held). The sweep case below is the contrast — there
    // `available` goes back up.
    expect(await stockOf(seller.variantId)).toEqual({ available: 4, committed: 0 });

    // The ledger: the charge, then the transfer that settles it. Both in EUR,
    // and the seller's payable closes to zero — which only happens if the two
    // modules agreed on the amount AND the currency.
    const entries = await ledgerEntriesFor(paymentId);
    expect(entries).toEqual([
      { kind: 'charge_succeeded', account: 'provider_clearing', currency: 'EUR', amount: BigInt(gross - api.fee) },
      { kind: 'charge_succeeded', account: 'processor_expense', currency: 'EUR', amount: BigInt(api.fee) },
      { kind: 'charge_succeeded', account: 'merchant_payable', currency: 'EUR', amount: BigInt(-gross) },
      { kind: 'transfer_created', account: 'merchant_payable', currency: 'EUR', amount: BigInt(gross) },
      { kind: 'transfer_created', account: 'provider_clearing', currency: 'EUR', amount: BigInt(-gross) },
    ]);
    // There is no commission leg: the rate is zero until #88, so the residual
    // `chargeSucceeded` computes is zero and a zero leg is omitted rather than
    // booked. A non-zero one here would be a rounding leak reported as revenue.
    expect(entries.some((entry) => entry.account === 'commission_revenue')).toBe(false);
    // Balanced per currency, which is the invariant the whole ledger rests on.
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);

    // The transfer: one per seller order, in the PLATFORM currency, drawn from
    // the charge, keyed on two durable Mercaria ids.
    const [transfer] = await transfersFor(paymentId);
    expect(transfer.status).toBe('paid');
    expect(transfer.amountAmount).toBe(gross);
    expect(transfer.amountCurrency).toBe('EUR');
    expect(transfer.orderId).toBe(order.id);
    expect(api.transferCalls).toHaveLength(1);
    expect(api.transferCalls[0].params).toEqual({
      amount: gross,
      currency: 'eur',
      destination: seller.accountId,
      source_transaction: chargeId,
      transfer_group: result.checkoutGroupId,
      metadata: { orderId: order.id, paymentId },
    });
    expect(api.transferCalls[0].idempotencyKey).toBe(`tr:${paymentId}:${order.id}`);
    // The row names the object the rail actually made, which is what a later
    // `transfer.*` event correlates through.
    const [madeTransferId] = [...api.transfers.keys()];
    expect(transfer.providerObjectId).toBe(madeTransferId);

    // No exception was raised: the only outbox row is the success itself.
    expect(await outboxTypesFor(paymentId)).toEqual(['payment_succeeded']);
  });

  it('converts a USD charge once, and settles in the platform currency', async () => {
    const seller = await seedSeller({ label: 'usd1', priceMinor: 10_000, currency: 'USD' });
    const buyer = await seedBuyer({
      label: 'usd1',
      currency: 'USD',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-usd1`);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const paymentId = String(payment?.id);
    const intentId = String(payment?.providerObjectId);
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);

    // The buyer is charged in USD — their presentment currency.
    expect(api.intentCalls[0].params.currency).toBe('usd');
    expect(order.totalsGrandTotalPresentmentCurrency).toBe('USD');

    const { platformAmount } = fundIntent(intentId);
    await deliverIntentEvent({ eventId: 'evt-usd1', type: 'payment_intent.succeeded', intentId });

    // The conversion is CAPTURED on the payment with its rate, so the figure is
    // reproducible rather than re-derived from a live rate later.
    const settled = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(settled?.platformAmount).toBe(platformAmount);
    expect(settled?.platformCurrency).toBe('EUR');
    expect(settled?.platformRateFrom).toBe('USD');
    expect(settled?.platformRateTo).toBe('EUR');
    expect(settled?.platformRateRate).toBe(api.exchangeRate);
    expect(settled?.platformRateProvider).toBe('stripe');

    // Every ledger leg is in EUR — where the money actually landed — and the
    // transfer is denominated to match, so the payable closes.
    const entries = await ledgerEntriesFor(paymentId);
    expect(entries.every((entry) => entry.currency === 'EUR')).toBe(true);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);

    const [transfer] = await transfersFor(paymentId);
    expect(transfer.amountCurrency).toBe('EUR');
    expect(transfer.amountAmount).toBe(platformAmount);
    expect(api.transferCalls[0].params.currency).toBe('eur');
  });
});

describe('checkout on the Stripe rail — multi-seller', () => {
  it('funds two sellers with ONE PaymentIntent and settles each separately', async () => {
    const first = await seedSeller({ label: 'multiA', priceMinor: 3_000, currency: 'EUR' });
    const second = await seedSeller({ label: 'multiB', priceMinor: 7_000, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'multi',
      currency: 'EUR',
      lines: [
        { listingId: first.listingId, variantId: first.variantId, quantity: 1 },
        { listingId: second.listingId, variantId: second.variantId, quantity: 1 },
      ],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-multi`);
    expect(result.orders).toHaveLength(2);

    // ONE intent for the whole group (ADR 0001 D4): one statement line, one SCA
    // challenge, one charge every later refund draws from.
    expect(api.intentCalls).toHaveLength(1);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const paymentId = String(payment?.id);
    const intentId = String(payment?.providerObjectId);
    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    const gross = orders.reduce(
      (total, order) => total + order.totalsGrandTotalPresentmentAmount,
      0,
    );
    expect(api.intentCalls[0].params.amount).toBe(gross);
    expect(api.intentCalls[0].params.metadata).toMatchObject({ orderCount: '2' });

    fundIntent(intentId);
    await deliverIntentEvent({ eventId: 'evt-multi', type: 'payment_intent.succeeded', intentId });

    // Both siblings funded together — they cannot have different outcomes.
    const paidOrders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(paidOrders.map((order) => order.status)).toEqual(['paid', 'paid']);

    // TWO transfers, one per seller order, summing to exactly the gross.
    const transfers = await transfersFor(paymentId);
    expect(transfers).toHaveLength(2);
    expect(transfers.reduce((sum, transfer) => sum + transfer.amountAmount, 0)).toBe(gross);
    expect(api.transferCalls.map((call) => call.params.destination).sort()).toEqual(
      [first.accountId, second.accountId].sort(),
    );
    // Each order's transfer matches the order's own total: the split is the
    // orders' proportions, not an even division.
    for (const order of paidOrders) {
      const transfer = transfers.find((row) => row.orderId === order.id);
      expect(transfer?.amountAmount).toBe(order.totalsGrandTotalPresentmentAmount);
    }

    const entries = await ledgerEntriesFor(paymentId);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);
  });

  it('withholds ONE seller whose account lapsed, and settles the sibling anyway', async () => {
    const good = await seedSeller({ label: 'isoA', priceMinor: 2_500, currency: 'EUR' });
    const lapsed = await seedSeller({ label: 'isoB', priceMinor: 6_500, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'iso',
      currency: 'EUR',
      lines: [
        { listingId: good.listingId, variantId: good.variantId, quantity: 1 },
        { listingId: lapsed.listingId, variantId: lapsed.variantId, quantity: 1 },
      ],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-iso`);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const paymentId = String(payment?.id);
    const intentId = String(payment?.providerObjectId);

    // The seller loses readiness AFTER the buyer paid and BEFORE the transfer —
    // the window ADR 0001 D4 calls Mercaria's controlled skipped transfer.
    await db
      .update(paymentSchema.providerAccounts)
      .set({ onboardingState: 'restricted', payoutsEnabled: false })
      .where(
        and(
          eq(paymentSchema.providerAccounts.provider, 'stripe'),
          eq(paymentSchema.providerAccounts.ownerId, lapsed.sellerId),
        ),
      );

    fundIntent(intentId);
    await deliverIntentEvent({ eventId: 'evt-iso', type: 'payment_intent.succeeded', intentId });

    // BOTH orders stay paid: the buyer's side of the sale is complete either way,
    // and un-paying one because its seller cannot be paid would take goods back
    // from a buyer who did nothing wrong.
    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(orders.map((order) => order.status)).toEqual(['paid', 'paid']);

    // The good seller was paid; the lapsed one's transfer exists but is pending
    // and was never sent.
    const transfers = await transfersFor(paymentId);
    expect(transfers).toHaveLength(2);
    const goodOrder = orders.find((order) => order.sellerOxyUserId === good.sellerId);
    const lapsedOrder = orders.find((order) => order.sellerOxyUserId === lapsed.sellerId);
    const goodTransfer = transfers.find((row) => row.orderId === goodOrder?.id);
    const lapsedTransfer = transfers.find((row) => row.orderId === lapsedOrder?.id);
    expect(goodTransfer?.status).toBe('paid');
    expect(goodTransfer?.providerObjectId).toBeTruthy();
    expect(lapsedTransfer?.status).toBe('pending');
    expect(lapsedTransfer?.providerObjectId).toBeNull();
    expect(api.transferCalls).toHaveLength(1);
    expect(api.transferCalls[0].params.destination).toBe(good.accountId);

    // The exception is DURABLE, not a log line — money is owed and unsent.
    expect(await outboxTypesFor(paymentId)).toEqual(['payment_succeeded', 'transfer_withheld']);
    const [withheld] = await db
      .select()
      .from(paymentSchema.paymentOutboxes)
      .where(eq(paymentSchema.paymentOutboxes.id, `payment:transfer_withheld:${paymentId}:${String(lapsedOrder?.id)}`));
    expect(withheld?.payload).toMatchObject({
      orderId: lapsedOrder?.id,
      sellerKey: `user:${lapsed.sellerId}`,
      reason: expect.stringContaining('restricted'),
    });

    // Only the settled seller's payable closed. The lapsed one's stays open,
    // which is exactly what "Mercaria still owes them" means in the accounts.
    const entries = await ledgerEntriesFor(paymentId);
    const payableBalance = entries
      .filter((entry) => entry.account === 'merchant_payable')
      .reduce((sum, entry) => sum + entry.amount, 0n);
    expect(payableBalance).toBe(BigInt(-(lapsedOrder?.totalsGrandTotalPresentmentAmount ?? 0)));
  });
});

describe('checkout on the Stripe rail — idempotency and refusals', () => {
  it('converges two concurrent submits on ONE PaymentIntent and one reservation', async () => {
    const seller = await seedSeller({
      label: 'idem',
      priceMinor: 4_000,
      currency: 'EUR',
      available: 5,
    });
    const buyer = await seedBuyer({
      label: 'idem',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 2 }],
    });
    const key = `key-${RUN}-idem`;

    // Both submits start against the SAME full cart — the double-tap, and the
    // shape the durable guarantee is actually for. Redis is best-effort and is
    // not running here, so what converges these two is the per-order
    // `orders_idempotency_key_key`: the loser rolls its own reservations back
    // and returns the winner's group.
    const [first, replay] = await Promise.all([
      checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, key),
      checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, key),
    ]);

    expect(replay.checkoutGroupId).toBe(first.checkoutGroupId);
    expect(replay.orders.map((order) => order.id).sort()).toEqual(
      first.orders.map((order) => order.id).sort(),
    );
    // ONE intent object, and the same client secret — a second charge for the
    // same goods is the failure the whole idempotency chain exists to prevent.
    expect(api.intents.size).toBe(1);
    expect(replay.payment?.clientSecret).toBe(first.payment?.clientSecret);
    expect(replay.payment?.paymentId).toBe(first.payment?.paymentId);

    // One payment row, one reservation: stock was taken once, not twice.
    const payments = await db
      .select()
      .from(paymentSchema.payments)
      .where(eq(paymentSchema.payments.checkoutGroupId, first.checkoutGroupId));
    expect(payments).toHaveLength(1);
    expect((await stockOf(seller.variantId)).available).toBe(3);
  });

  it('refuses a cart the rail cannot charge, before taking any stock', async () => {
    const seller = await seedSeller({ label: 'gbp', priceMinor: 4_000, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'gbp',
      currency: 'GBP',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    await expect(
      checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-gbp`),
    ).rejects.toThrow(/not available in GBP.*EUR or USD/is);

    // Nothing was reserved and no charge was opened: a currency question needs
    // no stock to answer.
    expect((await stockOf(seller.variantId)).available).toBe(5);
    expect(api.intentCalls).toHaveLength(0);
  });

  it('leaves the reservation clock alone when a payment fails and is retried', async () => {
    const seller = await seedSeller({ label: 'retry', priceMinor: 5_000, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'retry',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });
    const key = `key-${RUN}-retry`;

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, key);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const intentId = String(payment?.providerObjectId);
    const [before] = await findOrdersInCheckoutGroup(result.checkoutGroupId);

    // A declined confirmation: Stripe leaves the intent reusable, so the buyer
    // retries on the SAME intent with another card.
    const intent = api.intents.get(intentId);
    if (intent) intent.status = 'requires_payment_method';
    await deliverIntentEvent({
      eventId: 'evt-retry-failed',
      type: 'payment_intent.payment_failed',
      intentId,
    });

    const failed = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(failed?.status).toBe('requires_action');
    // The order is untouched: a failed payment releases nothing (#45 acceptance
    // 4). Only the reservation sweep releases stock, and its clock is the
    // ORDER's creation time, which no retry can move.
    const [after] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(after.status).toBe('pending_payment');
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());

    // The buyer confirms again on that same intent and it succeeds. No second
    // PaymentIntent was ever created: a failed confirmation leaves Stripe's
    // intent reusable, so a retry is another attempt on ONE charge object rather
    // than a new one — and the reservation clock, which belongs to the order,
    // never restarts.
    fundIntent(intentId);
    await deliverIntentEvent({
      eventId: 'evt-retry-succeeded',
      type: 'payment_intent.succeeded',
      intentId,
    });

    expect(api.intents.size).toBe(1);
    expect(api.intentCalls).toHaveLength(1);
    const [settledOrder] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(settledOrder.status).toBe('paid');
    expect(settledOrder.createdAt.getTime()).toBe(before.createdAt.getTime());
  });
});

describe('checkout on the Stripe rail — abandonment and a late capture', () => {
  it('cancels the PaymentIntent when the reservation expires, and raises an exception if the money arrives anyway', async () => {
    const seller = await seedSeller({ label: 'sweep', priceMinor: 3_500, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'sweep',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-sweep`);
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const paymentId = String(payment?.id);
    const intentId = String(payment?.providerObjectId);
    const [order] = await findOrdersInCheckoutGroup(result.checkoutGroupId);

    // Age the order past the reservation TTL, the way time would.
    await db
      .update(orderSchema.orders)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1_000) })
      .where(eq(orderSchema.orders.id, order.id));

    await handleExpireReservations();

    // Stock went back, the order is cancelled, and the rail was told to stop.
    expect((await stockOf(seller.variantId)).available).toBe(5);
    const [cancelled] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(cancelled.status).toBe('cancelled');
    expect(api.cancelCalls).toEqual([intentId]);
    expect(api.intents.get(intentId)?.status).toBe('canceled');
    const released = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    expect(released?.status).toBe('canceled');

    // …and then the money arrives anyway: a capture that raced the sweep.
    fundIntent(intentId);
    await deliverIntentEvent({
      eventId: 'evt-sweep-late',
      type: 'payment_intent.succeeded',
      intentId,
    });

    // NOTHING is re-committed. Re-committing would oversell whatever has been
    // bought since; booking the charge would credit commission with the whole
    // gross; refunding is a policy decision needing a person.
    expect((await stockOf(seller.variantId)).available).toBe(5);
    expect((await stockOf(seller.variantId)).committed).toBe(0);
    const [stillCancelled] = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(stillCancelled.status).toBe('cancelled');
    expect(await ledgerEntriesFor(paymentId)).toEqual([]);
    expect(await transfersFor(paymentId)).toEqual([]);

    // The condition is durable and visible instead — #50's operator queue.
    expect(await outboxTypesFor(paymentId)).toEqual(['payment_succeeded_after_release']);
  });
});

describe('the buyer-facing payment status', () => {
  it('answers from verified state, and only to the buyer who owns the group', async () => {
    const seller = await seedSeller({ label: 'status', priceMinor: 2_000, currency: 'EUR' });
    const buyer = await seedBuyer({
      label: 'status',
      currency: 'EUR',
      lines: [{ listingId: seller.listingId, variantId: seller.variantId, quantity: 1 }],
    });

    const result = await checkout({ kind: 'oxy', oxyUserId: buyer.buyerId }, { addressId: buyer.addressId }, `key-${RUN}-status`);
    const before = await readCheckoutPaymentStatus({ kind: 'oxy_user', oxyUserId: buyer.buyerId }, result.checkoutGroupId);
    expect(before.status).toBe('created');
    expect(before.orders).toHaveLength(1);
    expect(before.orders[0]?.paymentStatus).toBe('unpaid');

    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    const intentId = String(payment?.providerObjectId);
    fundIntent(intentId);
    await deliverIntentEvent({
      eventId: 'evt-status',
      type: 'payment_intent.succeeded',
      intentId,
    });

    const after = await readCheckoutPaymentStatus({ kind: 'oxy_user', oxyUserId: buyer.buyerId }, result.checkoutGroupId);
    expect(after.status).toBe('succeeded');
    expect(after.orders[0]?.status).toBe('paid');
    expect(after.orders[0]?.paymentStatus).toBe('paid');

    // Somebody else's checkout group does not exist as far as this buyer is
    // concerned — a 404, never a 403, because its existence is not a fact to
    // confirm.
    await expect(
      readCheckoutPaymentStatus({ kind: 'oxy_user', oxyUserId: `stranger-${RUN}` }, result.checkoutGroupId),
    ).rejects.toThrow(/not found/i);
  });
});
