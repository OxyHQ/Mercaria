/**
 * The Stripe ingress against a REAL Postgres database — the event, the payment,
 * its ledger, and the orders it funds.
 *
 * ## Why none of it can be mocked here
 *
 * Every property under test lives in the gap between the payment aggregate and
 * the orders it moves, or inside a constraint no mock has:
 *
 *  - a redelivered event is deduped by a UNIQUE index with `NULLS NOT
 *    DISTINCT`, which is the one thing a mocked `insert` cannot refuse;
 *  - "one ledger transaction, one outbox event, one order transition" from a
 *    duplicated or reordered sequence is held by a compare-and-swap on the
 *    payment and another on the order;
 *  - dead-lettering and replay are transitions of a real row through a real
 *    claim query, and a mocked claim would test the test.
 *
 * ## Stripe itself IS mocked, and only Stripe
 *
 * `client.ts` is replaced by a fake whose `retrieveStripePaymentIntent` reads a
 * map this file controls. That is not a shortcut around the code under test —
 * it IS the code under test: the whole point of the stale-delivery rule is that
 * the handler goes to Stripe instead of trusting a late payload, so the fake
 * exists to make "what does Stripe say NOW" differ from "what did this delivery
 * say", which is the only way to observe the rule at all.
 *
 * Signatures are real. Every delivery below is signed with the SDK's own helper
 * and verified by the real `constructEventAsync`.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * none of them may TRUNCATE a table another uses. Every assertion here is scoped
 * to rows this test itself wrote — which is the stronger form anyway, since a
 * count over a whole table starts passing for the wrong reason as soon as a
 * fixture is added elsewhere.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../../db/postgres.js';
import { uuidv7 } from '@oxyhq/db';
import { listings } from '../../../../db/schema/catalog.js';

const PLATFORM_SECRET = 'whsec_realdb_platform_not_a_real_one';
const CONNECT_SECRET = 'whsec_realdb_connect_not_a_real_one';

/** Attempts after which a retryable failure dead-letters. Small so the test is fast. */
const MAX_ATTEMPTS = 2;

/** Grand total of one seeded order, in EUR minor units. */
const ORDER_TOTAL = 4_500;
/** What Stripe keeps on that charge — booked as `processor_expense` (ADR 0001 D5). */
const STRIPE_FEE = 155;

/**
 * What ONE funded payment writes here, and why each number is what it is.
 *
 * `transactions: 1` — the charge, booked once however many deliveries arrive.
 * `entries: 3` — provider clearing, processor expense (the fee above) and the
 * seller's payable. There is no commission leg: the rate is zero until #88, so
 * the residual `chargeSucceeded` computes is zero and a zero leg is omitted.
 * `outbox: 2` — `payment_succeeded`, plus the `transfer_withheld` exception
 * #47's settlement records because the sellers seeded HERE have no connected
 * account. That is the correct outcome for this fixture and not a defect in it:
 * production refuses such a seller at checkout (the readiness gate), these
 * orders are inserted directly, and a funded order whose seller cannot be paid
 * must leave a durable record rather than a silence.
 */
const FUNDED_COUNTS = { transactions: 1, entries: 3, outbox: 2 } as const;
const SEEDED_AVAILABLE = 10;
const RESERVED_QTY = 1;

/**
 * The fake Stripe client's state, created in a hoisted block so the `vi.mock`
 * factory below can close over it — a factory is hoisted above every `const` in
 * this file and would otherwise reference an uninitialised binding.
 */
const stripeApi = vi.hoisted(() => ({
  /** PaymentIntent id → the object `retrieve` should answer with. */
  intents: new Map<
    string,
    {
      id: string;
      status: string;
      currency: string;
      metadata: Record<string, string>;
      latest_charge?: string;
    }
  >(),
  /** Charge id → the object `retrieve` should answer with, balance transaction expanded. */
  charges: new Map<string, Record<string, unknown>>(),
  /** Every retrieve this test provoked, so a re-read can be ASSERTED, not assumed. */
  retrieved: [] as string[],
  /** Connected-account id → the object `retrieve` should answer with. */
  accounts: new Map<string, Record<string, unknown>>(),
  /** Every ACCOUNT retrieve, so both a re-read and its ABSENCE can be asserted. */
  retrievedAccounts: [] as string[],
}));

vi.mock('../client.js', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  getStripeClient: () => {
    throw new Error('The realdb suite must not construct a real Stripe client.');
  },
  resetStripeClient: () => undefined,
  retrieveStripePaymentIntent: (id: string) => {
    stripeApi.retrieved.push(id);
    const intent = stripeApi.intents.get(id);
    if (!intent) throw new Error(`No fake PaymentIntent registered for ${id}`);
    return Promise.resolve(intent);
  },
  retrieveStripeTransfer: (id: string) => {
    throw new Error(`No fake Transfer registered for ${id}`);
  },
  retrieveStripeChargeWithBalance: (id: string) => {
    const charge = stripeApi.charges.get(id);
    if (!charge) throw new Error(`No fake charge registered for ${id}`);
    return Promise.resolve(charge);
  },
  // Settlement (#47) reaches for this only once a seller is payment-ready, and
  // no seeded seller here is — see `seedOrder`. A throw is therefore an
  // assertion: if this ever fires, a transfer was attempted for an account that
  // does not exist.
  createStripeTransfer: () => {
    throw new Error('The ingress suite settles nothing; no seller here is payment-ready.');
  },
  cancelStripePaymentIntent: () => {
    throw new Error('The ingress suite cancels no PaymentIntent.');
  },
  createStripePaymentIntent: () => {
    throw new Error('The ingress suite creates no PaymentIntent.');
  },
  retrieveStripeAccount: (id: string) => {
    stripeApi.retrievedAccounts.push(id);
    const account = stripeApi.accounts.get(id);
    if (!account) throw new Error(`No fake account registered for ${id}`);
    return Promise.resolve(account);
  },
  // Onboarding is not exercised from the ingress. Present so the mocked module
  // offers every export the real one does — a named import missing from a mock
  // factory fails at link time, and it would fail in whichever file imported the
  // chain rather than in the one that left it out.
  createStripeConnectedAccount: () => {
    throw new Error('The ingress suite does not create connected accounts.');
  },
  createStripeAccountLink: () => {
    throw new Error('The ingress suite does not mint account links.');
  },
}));

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let db: Database;
let closePostgres: typeof import('../../../../db/postgres.js').closePostgres;
let insertProviderAccount: typeof import('../../../../db/payments/providerAccountRepository.js').insertProviderAccount;
let findProviderAccountByProviderId: typeof import('../../../../db/payments/providerAccountRepository.js').findProviderAccountByProviderId;
let isSellerPaymentReady: typeof import('../../provider-account.service.js').isSellerPaymentReady;
let ensurePayment: typeof import('../../payment.service.js').ensurePayment;
let applyPaymentStatus: typeof import('../../payment.service.js').applyPaymentStatus;
let ingestStripeDelivery: typeof import('../ingress.js').ingestStripeDelivery;
let drainStripeEvents: typeof import('../event-processor.js').drainStripeEvents;
let replayProviderEvent: typeof import('../event-processor.js').replayProviderEvent;
let stripeWebhookStats: typeof import('../event-processor.js').stripeWebhookStats;
let insertVariants: typeof import('../../../../db/catalog/variantRepository.js').insertVariants;
let findOrderById: typeof import('../../../../db/orders/orderRepository.js').findOrderById;
let insertOrder: typeof import('../../../../db/orders/orderRepository.js').insertOrder;
let nextOrderNumber: typeof import('../../../../db/orders/orderRepository.js').nextOrderNumber;
let ensureSellerProfile: typeof import('../../../../db/buyers/sellerProfileRepository.js').ensureSellerProfile;
let reserve: typeof import('../../../inventory.service.js').reserve;
let schema: typeof import('../../../../db/schema/payments.js');
let ledgerSchema: typeof import('../../../../db/schema/ledger.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.STRIPE_EVENT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);

  const postgres = await import('../../../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  ({ ensurePayment, applyPaymentStatus } = await import('../../payment.service.js'));
  ({ ingestStripeDelivery } = await import('../ingress.js'));
  ({ drainStripeEvents, replayProviderEvent, stripeWebhookStats } = await import(
    '../event-processor.js'
  ));
  // Dynamic, like everything else above: a STATIC import of any repository pulls
  // `db/postgres.js` and therefore `config/index.ts`, which freezes its view of
  // process.env at module load — before the STRIPE_* values set at the top of
  // this hook exist. Every delivery below would then be rejected as "Stripe not
  // configured", and the failure reads as a broken ingress rather than a broken
  // import order.
  ({ insertVariants } = await import('../../../../db/catalog/variantRepository.js'));
  ({ findOrderById, insertOrder, nextOrderNumber } = await import(
    '../../../../db/orders/orderRepository.js'
  ));
  ({ ensureSellerProfile } = await import('../../../../db/buyers/sellerProfileRepository.js'));
  ({ reserve } = await import('../../../inventory.service.js'));
  ({ insertProviderAccount, findProviderAccountByProviderId } = await import(
    '../../../../db/payments/providerAccountRepository.js'
  ));
  ({ isSellerPaymentReady } = await import('../../provider-account.service.js'));
  schema = await import('../../../../db/schema/payments.js');
  ledgerSchema = await import('../../../../db/schema/ledger.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  stripeApi.intents.clear();
  stripeApi.charges.clear();
  stripeApi.retrieved.length = 0;
  stripeApi.retrievedAccounts.length = 0;
  // Nothing is deleted: every fixture below is minted under ids unique to the
  // test that made it, so there is nothing shared to clear — see the header.
  // `stripeApi.accounts` follows the same rule for the same reason: the
  // reconciliation case sweeps every provider-account row this file wrote, so
  // forgetting an earlier test's account would fail the sweep on a row the test
  // is not about.
});

/** A EUR `DualMoney` whose two sides are equal — no conversion in play. */
function eur(amount: number) {
  return { shop: { amount, currency: 'EUR' }, presentment: { amount, currency: 'EUR' } } as const;
}

/** One test's cast of characters, all freshly minted so nothing collides. */
function actors(): { buyer: string; seller: string } {
  const suffix = uuidv7();
  return { buyer: `buyer-${suffix}`, seller: `seller-${suffix}` };
}

/** Seed one `pending_payment` P2P order with a real variant holding a reservation. */
async function seedOrder(
  checkoutGroupId: string,
  who: { buyer: string; seller: string },
): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: who.seller,
      title: 'A thing',
      description: '',
      condition: 'new',
    })
    .returning({ id: listings.id });

  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: ORDER_TOTAL,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: SEEDED_AVAILABLE,
      position: 0,
      optionValues: [],
    },
  ]);

  // A real reservation, taken the way checkout takes one.
  await reserve(variant.id, RESERVED_QTY);
  // `transition('paid')` bumps this counter, so the row has to exist.
  await ensureSellerProfile(who.seller);

  const order = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOxyUserId: who.buyer,
    sellerType: 'user',
    sellerOxyUserId: who.seller,
    items: [
      {
        listingId: listing.id,
        variantId: variant.id,
        title: 'A thing',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: eur(ORDER_TOTAL),
        quantity: RESERVED_QTY,
        lineTotal: eur(ORDER_TOTAL),
      },
    ],
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Street',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: eur(0),
    totals: {
      subtotal: eur(ORDER_TOTAL),
      discountTotal: eur(0),
      shipping: eur(0),
      tax: eur(0),
      grandTotal: eur(ORDER_TOTAL),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    checkoutGroupId,
    statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: who.buyer }],
    appliedDiscounts: [],
    taxLines: [],
  });

  return order.id;
}

/** A checkout group, its order and its Stripe payment, ready to be told about. */
async function seedPayment(input: { intentId: string; status?: 'created' | 'canceled' }): Promise<{
  paymentId: string;
  orderId: string;
  checkoutGroupId: string;
}> {
  const who = actors();
  const checkoutGroupId = uuidv7();
  const orderId = await seedOrder(checkoutGroupId, who);
  const payment = await ensurePayment({
    provider: 'stripe',
    checkoutGroupId,
    presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
    buyerOxyUserId: who.buyer,
    providerObjectId: input.intentId,
  });
  if (input.status === 'canceled') {
    await applyPaymentStatus({ paymentId: payment.id, next: 'canceled' });
  }
  return { paymentId: payment.id, orderId, checkoutGroupId };
}

/**
 * Register what the fake Stripe API answers for an intent — and, for a success,
 * the charge and BALANCE TRANSACTION behind it.
 *
 * #47 reads that balance transaction during the `succeeded` transition, because
 * it is the only place Stripe states what the charge became in the platform's
 * settlement currency and what it kept in fees (ADR 0001 D8/D5). Both are booked
 * inside the same compare-and-swap that books the charge, so an intent without
 * one cannot be applied at all — which is deliberate, and is why every success
 * below gets one.
 */
function registerIntent(id: string, status: string, paymentId: string): void {
  const chargeId = `ch_${id}`;
  stripeApi.intents.set(id, {
    id,
    status,
    currency: 'eur',
    metadata: { paymentId },
    ...(status === 'succeeded' ? { latest_charge: chargeId } : {}),
  });
  if (status !== 'succeeded') return;

  stripeApi.charges.set(chargeId, {
    id: chargeId,
    object: 'charge',
    payment_intent: id,
    balance_transaction: {
      id: `txn_${id}`,
      object: 'balance_transaction',
      // Same currency in and out: these fixtures are EUR on a EUR platform, so
      // no conversion happens and the rate is one.
      amount: ORDER_TOTAL,
      currency: 'eur',
      exchange_rate: null,
      fee: STRIPE_FEE,
      created: Math.floor(Date.now() / 1000),
    },
  });
}

/** Build one Stripe event body. */
function paymentIntentEvent(input: {
  eventId: string;
  type: string;
  intentId: string;
  status: string;
  paymentId: string;
  livemode?: boolean;
}): string {
  return JSON.stringify({
    id: input.eventId,
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: input.livemode ?? false,
    type: input.type,
    data: {
      object: {
        id: input.intentId,
        object: 'payment_intent',
        status: input.status,
        amount: ORDER_TOTAL,
        currency: 'eur',
        metadata: { paymentId: input.paymentId },
        // The inline path reads the DELIVERED object, so a success has to name
        // its charge here as well as in the fake `retrieve` above.
        ...(input.status === 'succeeded' ? { latest_charge: `ch_${input.intentId}` } : {}),
      },
    },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
}

/** Sign and deliver one event to the platform endpoint. */
async function deliver(payload: string, secret: string = PLATFORM_SECRET) {
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return await ingestStripeDelivery({
    payload: Buffer.from(payload, 'utf8'),
    signature,
    scope: 'platform',
  });
}

/** Stored event rows for one Stripe event id. Scoped, never a table-wide count. */
async function storedEvents(providerEventId: string) {
  return await db
    .select()
    .from(schema.paymentProviderEvents)
    .where(
      and(
        eq(schema.paymentProviderEvents.provider, 'stripe'),
        eq(schema.paymentProviderEvents.providerEventId, providerEventId),
      ),
    );
}

/** What ONE payment wrote: ledger transactions, entries and outbox rows. */
async function counts(paymentId: string) {
  const [[transactions], [entries], [outbox]] = await Promise.all([
    db
      .select({ n: sql<string>`count(*)` })
      .from(ledgerSchema.ledgerTransactions)
      .where(eq(ledgerSchema.ledgerTransactions.paymentId, paymentId)),
    db
      .select({ n: sql<string>`count(*)` })
      .from(ledgerSchema.ledgerEntries)
      .where(
        sql`${ledgerSchema.ledgerEntries.transactionId} in (select ${ledgerSchema.ledgerTransactions.id} from ${ledgerSchema.ledgerTransactions} where ${ledgerSchema.ledgerTransactions.paymentId} = ${paymentId})`,
      ),
    db
      .select({ n: sql<string>`count(*)` })
      .from(schema.paymentOutboxes)
      .where(sql`${schema.paymentOutboxes.payload}->>'paymentId' = ${paymentId}`),
  ]);
  return {
    transactions: Number(transactions?.n ?? 0),
    entries: Number(entries?.n ?? 0),
    outbox: Number(outbox?.n ?? 0),
  };
}

/** The payment row as it stands now. */
async function paymentStatus(paymentId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: schema.payments.status })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId));
  return row?.status;
}

describe('receipt', () => {
  it('stores a verified event, applies it, and books exactly one of everything', async () => {
    const intentId = 'pi_receipt_ok';
    const { paymentId, orderId } = await seedPayment({ intentId });
    registerIntent(intentId, 'succeeded', paymentId);

    const result = await deliver(
      paymentIntentEvent({
        eventId: 'evt_receipt_ok',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );

    expect(result.outcome).toBe('accepted');
    expect(await paymentStatus(paymentId)).toBe('succeeded');

    const rows = await storedEvents('evt_receipt_ok');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('processed');
    expect(rows[0]?.paymentId).toBe(paymentId);
    // The envelope records what #48 requires: mode, API version, type and the
    // provider object ids — all of it read off the VERIFIED event.
    expect(rows[0]?.livemode).toBe(false);
    expect(rows[0]?.apiVersion).toBe('2026-07-29.dahlia');
    // Both ids, because a succeeded intent names its charge — and the charge is
    // what #47 reads the balance transaction from, so losing it here would lose
    // the correlation the settlement path depends on.
    expect(rows[0]?.objectIds).toEqual({ paymentIntent: intentId, charge: `ch_${intentId}` });
    // Platform scope carries no connected account, which is what makes the
    // unique index's NULLS NOT DISTINCT load-bearing.
    expect(rows[0]?.providerAccountId).toBeNull();

    // The payload is a SUMMARY, not the event. The buyer-identifying fields a
    // real Stripe event carries must not survive into a table operators read.
    const summary = rows[0]?.payloadSummary as { data?: { object?: Record<string, unknown> } };
    expect(summary.data?.object).toMatchObject({ id: intentId, status: 'succeeded' });

    expect(await counts(paymentId)).toEqual(FUNDED_COUNTS);

    const order = await findOrderById(orderId);
    expect(order?.status).toBe('paid');
    expect(order?.statusHistory.filter((entry) => entry.status === 'paid')).toHaveLength(1);

    // The happy path never re-reads: the payload was applicable as it arrived.
    expect(stripeApi.retrieved).toEqual([]);
  });

  it('a livemode mismatch persists NOTHING', async () => {
    const intentId = 'pi_livemode';
    const { paymentId } = await seedPayment({ intentId });
    registerIntent(intentId, 'succeeded', paymentId);

    const result = await deliver(
      paymentIntentEvent({
        eventId: 'evt_livemode_realdb',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
        livemode: true,
      }),
    );

    expect(result).toMatchObject({ outcome: 'ignored', code: 'livemode_mismatch' });
    // Asserted against the real table, not a spy: a live-mode object's ids come
    // from a different key space, so storing one would either correlate to
    // nothing or — worse — to a test object that happens to share an id.
    expect(await storedEvents('evt_livemode_realdb')).toHaveLength(0);
    expect(await paymentStatus(paymentId)).toBe('created');
  });
});

describe('convergence', () => {
  it('a byte-identical redelivery is a duplicate with no second effect', async () => {
    const intentId = 'pi_duplicate';
    const { paymentId } = await seedPayment({ intentId });
    registerIntent(intentId, 'succeeded', paymentId);
    const payload = paymentIntentEvent({
      eventId: 'evt_duplicate',
      type: 'payment_intent.succeeded',
      intentId,
      status: 'succeeded',
      paymentId,
    });

    const first = await deliver(payload);
    const second = await deliver(payload);

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('duplicate');
    // ONE row, because the unique index refused the second insert — and one of
    // everything downstream, because the duplicate never reached processing.
    expect(await storedEvents('evt_duplicate')).toHaveLength(1);
    expect(await counts(paymentId)).toEqual(FUNDED_COUNTS);
  });

  it('TWO DISTINCT success events for one intent still book once', async () => {
    const intentId = 'pi_double_success';
    const { paymentId } = await seedPayment({ intentId });
    registerIntent(intentId, 'succeeded', paymentId);

    // Different event ids, so the dedupe index does NOT catch these: both are
    // stored and both are processed. What makes them converge is the payment's
    // compare-and-swap, one layer down — which is the property being pinned.
    await deliver(
      paymentIntentEvent({
        eventId: 'evt_double_a',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );
    await deliver(
      paymentIntentEvent({
        eventId: 'evt_double_b',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );

    expect(await storedEvents('evt_double_a')).toHaveLength(1);
    expect(await storedEvents('evt_double_b')).toHaveLength(1);
    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await counts(paymentId)).toEqual(FUNDED_COUNTS);
  });

  it('processing THEN succeeded converges on succeeded', async () => {
    const intentId = 'pi_in_order';
    const { paymentId } = await seedPayment({ intentId });
    registerIntent(intentId, 'processing', paymentId);

    await deliver(
      paymentIntentEvent({
        eventId: 'evt_order_processing',
        type: 'payment_intent.processing',
        intentId,
        status: 'processing',
        paymentId,
      }),
    );
    expect(await paymentStatus(paymentId)).toBe('processing');

    registerIntent(intentId, 'succeeded', paymentId);
    await deliver(
      paymentIntentEvent({
        eventId: 'evt_order_succeeded',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );

    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await counts(paymentId)).toEqual(FUNDED_COUNTS);
    // Both deliveries were applicable as they arrived, so neither re-read.
    expect(stripeApi.retrieved).toEqual([]);
  });

  it('succeeded THEN a STALE processing re-reads Stripe and does not regress', async () => {
    const intentId = 'pi_reordered';
    const { paymentId } = await seedPayment({ intentId });
    registerIntent(intentId, 'succeeded', paymentId);

    await deliver(
      paymentIntentEvent({
        eventId: 'evt_reordered_succeeded',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );
    expect(await paymentStatus(paymentId)).toBe('succeeded');

    // The late delivery: a TRUE snapshot of a moment that has passed. Stripe
    // still says `succeeded`, which the fake above continues to report.
    await deliver(
      paymentIntentEvent({
        eventId: 'evt_reordered_processing',
        type: 'payment_intent.processing',
        intentId,
        status: 'processing',
        paymentId,
      }),
    );

    expect(await paymentStatus(paymentId)).toBe('succeeded');
    expect(await counts(paymentId)).toEqual(FUNDED_COUNTS);

    /**
     * The re-read is the mechanism, so it is asserted rather than inferred.
     * Without it the handler would submit `processing`, the compare-and-swap
     * would discard it, and the payment would look right for the wrong reason —
     * a test asserting only the final status could not tell the two apart.
     */
    expect(stripeApi.retrieved).toEqual([intentId]);
    const stale = await storedEvents('evt_reordered_processing');
    expect(stale[0]?.status).toBe('processed');
    expect(stale[0]?.processingNote).toContain('confirmed by re-reading Stripe');
  });
});

describe('the late-capture exception', () => {
  it('a success for a RELEASED payment changes nothing and raises an exception', async () => {
    const intentId = 'pi_after_release';
    const { paymentId, orderId } = await seedPayment({ intentId, status: 'canceled' });
    registerIntent(intentId, 'succeeded', paymentId);

    await deliver(
      paymentIntentEvent({
        eventId: 'evt_after_release',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );

    // The payment stays where it is. `canceled` is TRUE — Mercaria did release
    // it — and inventing a status for this would put a state every report and
    // filter has to learn into the vocabulary.
    expect(await paymentStatus(paymentId)).toBe('canceled');

    // Nothing was booked and no order moved: re-committing stock that may have
    // been sold since would oversell, and booking a charge with no orders left
    // to split it across would credit commission_revenue with the whole gross.
    const [row] = await db
      .select({ n: sql<string>`count(*)` })
      .from(ledgerSchema.ledgerTransactions)
      .where(eq(ledgerSchema.ledgerTransactions.paymentId, paymentId));
    expect(Number(row?.n ?? 0)).toBe(0);
    const order = await findOrderById(orderId);
    expect(order?.status).toBe('pending_payment');

    // What DID happen: one durable, deterministic exception for #50 to pick up.
    const [exception] = await db
      .select()
      .from(schema.paymentOutboxes)
      .where(eq(schema.paymentOutboxes.id, `payment:payment_succeeded_after_release:${paymentId}`));
    expect(exception?.eventType).toBe('payment_succeeded_after_release');
    /**
     * And its handler is WIRED. `runPaymentOutboxEvent` throws for an event type
     * it does not know — deliberately, so a rolling deploy retries rather than
     * completing work the older code cannot do — so a missing `case` would leave
     * this row `pending` with a lastError, and an assertion that only checked
     * the row EXISTS would pass either way.
     */
    expect(exception?.status).toBe('processed');
    expect(exception?.lastError).toBeNull();

    const stored = await storedEvents('evt_after_release');
    expect(stored[0]?.status).toBe('processed');
    expect(stored[0]?.processingNote).toContain('EXCEPTION');
  });

  it('a REDELIVERY of that capture raises the same exception only once', async () => {
    const intentId = 'pi_after_release_twice';
    const { paymentId } = await seedPayment({ intentId, status: 'canceled' });
    registerIntent(intentId, 'succeeded', paymentId);

    for (const eventId of ['evt_after_release_1', 'evt_after_release_2']) {
      await deliver(
        paymentIntentEvent({
          eventId,
          type: 'payment_intent.succeeded',
          intentId,
          status: 'succeeded',
          paymentId,
        }),
      );
    }

    // Two distinct events, ONE exception: an operator opening the same case
    // twice is noise that hides the next real one.
    const rows = await db
      .select()
      .from(schema.paymentOutboxes)
      .where(sql`${schema.paymentOutboxes.payload}->>'paymentId' = ${paymentId}`);
    expect(rows).toHaveLength(1);
  });
});

describe('seams are visible in the trace', () => {
  it('a payout event is stored, processed and marked deferred to #49', async () => {
    const payload = JSON.stringify({
      id: 'evt_payout_seam',
      object: 'event',
      api_version: '2026-07-29.dahlia',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: 'payout.paid',
      account: 'acct_seam_1',
      data: { object: { id: 'po_seam_1', object: 'payout' } },
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: CONNECT_SECRET,
    });

    const result = await ingestStripeDelivery({
      payload: Buffer.from(payload, 'utf8'),
      signature,
      scope: 'connect',
    });
    expect(result.outcome).toBe('accepted');

    const [row] = await storedEvents('evt_payout_seam');
    expect(row?.status).toBe('processed');
    // The connected account is stored — it is HALF the dedupe key, and the
    // reason platform-scope rows need NULLS NOT DISTINCT to dedupe at all.
    expect(row?.providerAccountId).toBe('acct_seam_1');
    /**
     * The seam marker. Marking a deferral `processed` and saying nothing else
     * would make it indistinguishable from real handling in the operator trace,
     * and the first person to notice would be a seller asking why a payout never
     * appeared.
     */
    expect(row?.processingNote).toContain('deferred: #49');
  });
});

/**
 * The connected-account half of the ingress, through the REAL delivery path.
 *
 * `account.service`'s own suite covers the derivations and the repository; what
 * is asserted HERE is the part only the real ingress can show — that a signed
 * connect-scope delivery, verified over raw bytes and stored under a dedupe key,
 * ends with a seller's readiness actually changing. The two halves being tested
 * separately is why neither has to mock the other.
 */
describe('connected-account readiness, end to end', () => {
  /** Sign and deliver one connect-scope account event. */
  async function deliverAccountEvent(input: {
    eventId: string;
    type: string;
    accountId: string;
  }) {
    const payload = JSON.stringify({
      id: input.eventId,
      object: 'event',
      api_version: '2026-07-29.dahlia',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: input.type,
      account: input.accountId,
      // Deliberately a THIN object. The handler must not read it: an account's
      // requirements are the most volatile thing Stripe reports and deliveries
      // are unordered, so anything applied from a payload can be a state the
      // seller has already moved past. If this test starts depending on the
      // fields below, the handler has begun trusting the delivery.
      data: { object: { id: input.accountId, object: 'account' } },
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: CONNECT_SECRET,
    });
    return await ingestStripeDelivery({
      payload: Buffer.from(payload, 'utf8'),
      signature,
      scope: 'connect',
    });
  }

  it('flips a seller to ready from a delivery that carries no account state', async () => {
    const ownerId = `store-ingress-${RUN}`;
    const accountId = `acct_ingress_${RUN}`;
    const row = await insertProviderAccount(db, {
      provider: 'stripe',
      ownerType: 'store',
      ownerId,
      providerAccountId: accountId,
      country: 'ES',
    });
    stripeApi.accounts.set(accountId, {
      id: accountId,
      object: 'account',
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
        current_deadline: null,
      },
    });
    expect(await isSellerPaymentReady(`store:${ownerId}`)).toBe(false);

    const result = await deliverAccountEvent({
      eventId: `evt_account_ready_${RUN}`,
      type: 'account.updated',
      accountId,
    });
    expect(result.outcome).toBe('accepted');

    const [stored] = await storedEvents(`evt_account_ready_${RUN}`);
    expect(stored?.status).toBe('processed');
    expect(stored?.processingNote).toContain("'ready'");
    // The delivery said nothing about capabilities, so this can only be true if
    // the handler went to Stripe for the current state — which is the rule.
    expect(await isSellerPaymentReady(`store:${ownerId}`)).toBe(true);
    expect(stripeApi.retrievedAccounts).toContain(accountId);
    expect(row.onboardingState).toBe('action_required');
  });

  it('converges with the reconciliation sweep on the same verdict', async () => {
    // Issue #46, acceptance 3. Same account, same Stripe state, two independent
    // paths: a delivery, and a sweep that was never told anything. Both must
    // reach one answer, because the sweep exists precisely for the deliveries
    // that never arrive.
    const ownerId = `store-converge-${RUN}`;
    const accountId = `acct_converge_${RUN}`;
    await insertProviderAccount(db, {
      provider: 'stripe',
      ownerType: 'store',
      ownerId,
      providerAccountId: accountId,
      country: 'ES',
    });
    const restrictedState = {
      id: accountId,
      object: 'account',
      charges_enabled: false,
      payouts_enabled: false,
      capabilities: { transfers: 'inactive' },
      requirements: {
        currently_due: ['company.tax_id'],
        eventually_due: ['company.tax_id'],
        past_due: ['company.tax_id'],
        pending_verification: [],
        disabled_reason: 'requirements.past_due',
        current_deadline: null,
      },
    };
    stripeApi.accounts.set(accountId, restrictedState);

    await deliverAccountEvent({
      eventId: `evt_account_converge_${RUN}`,
      type: 'account.updated',
      accountId,
    });
    const afterWebhook = await findProviderAccountByProviderId(db, 'stripe', accountId);

    const { reconcileStaleAccounts } = await import('../account-reconciler.js');
    await reconcileStaleAccounts({ staleAfterMs: -1, batchSize: 500 });
    const afterSweep = await findProviderAccountByProviderId(db, 'stripe', accountId);

    expect(afterWebhook?.onboardingState).toBe('restricted');
    expect(afterSweep?.onboardingState).toBe(afterWebhook?.onboardingState);
    expect(await isSellerPaymentReady(`store:${ownerId}`)).toBe(false);
  });

  it('revokes on deauthorization without asking Stripe about the account', async () => {
    const ownerId = `store-deauth-${RUN}`;
    const accountId = `acct_deauth_${RUN}`;
    await insertProviderAccount(db, {
      provider: 'stripe',
      ownerType: 'store',
      ownerId,
      providerAccountId: accountId,
      country: 'ES',
    });
    // Deliberately UNREGISTERED with the fake. A handler that re-read the
    // account here would throw a RETRYABLE error and the event would retry until
    // it dead-lettered, leaving a seller Mercaria cannot pay marked as active —
    // so the absence is the assertion.
    stripeApi.accounts.delete(accountId);

    const result = await deliverAccountEvent({
      eventId: `evt_account_deauth_${RUN}`,
      type: 'account.application.deauthorized',
      accountId,
    });
    expect(result.outcome).toBe('accepted');

    const [stored] = await storedEvents(`evt_account_deauth_${RUN}`);
    expect(stored?.status).toBe('processed');
    const revoked = await findProviderAccountByProviderId(db, 'stripe', accountId);
    expect(revoked?.onboardingState).toBe('disabled');
    expect(revoked?.revokedAt).not.toBeNull();
    expect(await isSellerPaymentReady(`store:${ownerId}`)).toBe(false);
  });

  it('ignores an account nothing here has a row for', async () => {
    const result = await deliverAccountEvent({
      eventId: `evt_account_unknown_${RUN}`,
      type: 'account.updated',
      accountId: `acct_not_ours_${RUN}`,
    });
    expect(result.outcome).toBe('accepted');

    const [stored] = await storedEvents(`evt_account_unknown_${RUN}`);
    // `processed`, not `failed`: an account from another environment is not work
    // a retry could complete, and retrying it would dead-letter an event that is
    // behaving exactly as it should.
    expect(stored?.status).toBe('processed');
    expect(stored?.processingNote).toContain('no provider-account row');
  });
});

describe('failure, dead-lettering and replay', () => {
  it('an unresolvable event retries, dead-letters, and then replays successfully', async () => {
    const intentId = 'pi_dead_letter';
    // Deliberately NO payment: the correlation cannot be made yet, which is a
    // RETRYABLE condition (issue #48 ordering 9 — an event can beat the
    // transaction that created the payment into visibility).
    registerIntent(intentId, 'succeeded', 'payment-that-does-not-exist-yet');

    const delivered = await deliver(
      paymentIntentEvent({
        eventId: 'evt_dead_letter',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId: 'payment-that-does-not-exist-yet',
      }),
    );
    // RECEIPT succeeded even though processing did not. That separation is the
    // whole point: answering 500 here would ask Stripe to redeliver an event
    // Mercaria has already stored.
    expect(delivered.outcome).toBe('accepted');

    const afterFirst = await storedEvents('evt_dead_letter');
    expect(afterFirst[0]?.status).toBe('failed');
    expect(afterFirst[0]?.attempts).toBe(1);
    expect(afterFirst[0]?.lastError).toContain('No Mercaria payment matches');

    const storedId = afterFirst[0]?.id ?? '';

    // Drain until it dead-letters, skipping the backoff by moving the row's own
    // clock forward — the alternative is a test that sleeps through the
    // exponential delays it is trying to prove exist.
    //
    // The loop STOPS at the dead letter rather than running a fixed number of
    // times. Nudging `next_attempt_at` on a dead-lettered row would undo the
    // very thing asserted below (a dead letter waits for a person, not a clock)
    // and the test would be measuring its own fixture.
    let deadLettered = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2 && deadLettered === 0; attempt += 1) {
      await db
        .update(schema.paymentProviderEvents)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.paymentProviderEvents.id, storedId));
      deadLettered += (await drainStripeEvents({ eventId: storedId })).deadLettered;
    }
    expect(deadLettered).toBe(1);

    const dead = await storedEvents('evt_dead_letter');
    expect(dead[0]?.status).toBe('dead_letter');
    // A dead letter waits for a person, not a clock — so nothing picks it up on
    // its own, which is what makes it stay VISIBLE instead of quietly retrying.
    expect(dead[0]?.nextAttemptAt).toBeNull();
    expect(await drainStripeEvents({ eventId: storedId })).toMatchObject({ processed: 0, failed: 0 });

    // Now make the correlation resolvable — the operator's fix — and replay.
    const who = actors();
    const checkoutGroupId = uuidv7();
    const orderId = await seedOrder(checkoutGroupId, who);
    const payment = await ensurePayment({
      provider: 'stripe',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      buyerOxyUserId: who.buyer,
      providerObjectId: intentId,
    });
    registerIntent(intentId, 'succeeded', payment.id);

    expect(await replayProviderEvent(storedId)).toBe(true);

    const replayed = await storedEvents('evt_dead_letter');
    expect(replayed[0]?.status).toBe('processed');
    expect(replayed[0]?.paymentId).toBe(payment.id);
    // The replay cleared the note its dead-lettered attempt left behind, rather
    // than leaving the trace claiming a failure that no longer describes it.
    expect(replayed[0]?.lastError).toBeNull();
    // Attempts are NOT reset: a replay that erased them would let the same event
    // be replayed indefinitely with nothing recording that anyone had.
    expect(replayed[0]?.attempts).toBeGreaterThan(MAX_ATTEMPTS);

    expect(await paymentStatus(payment.id)).toBe('succeeded');
    expect(await counts(payment.id)).toEqual(FUNDED_COUNTS);
    const order = await findOrderById(orderId);
    expect(order?.status).toBe('paid');
  });

  it('replaying an already-processed event is refused', async () => {
    const intentId = 'pi_replay_processed';
    const { paymentId } = await seedPayment({ intentId });
    registerIntent(intentId, 'succeeded', paymentId);

    await deliver(
      paymentIntentEvent({
        eventId: 'evt_replay_processed',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId,
      }),
    );
    const [row] = await storedEvents('evt_replay_processed');

    /**
     * There is nothing to redo, and reopening it would let a `processed` row be
     * pushed back into the queue — which is how an operator investigating one
     * incident causes a second one.
     */
    expect(await replayProviderEvent(row?.id ?? '')).toBe(false);
    expect(await counts(paymentId)).toEqual(FUNDED_COUNTS);
  });
});

describe('the health surface', () => {
  it('counts outstanding work and reports the lag of the oldest', async () => {
    const before = await stripeWebhookStats();

    const intentId = 'pi_stats';
    registerIntent(intentId, 'succeeded', 'payment-that-does-not-exist-for-stats');
    await deliver(
      paymentIntentEvent({
        eventId: 'evt_stats',
        type: 'payment_intent.succeeded',
        intentId,
        status: 'succeeded',
        paymentId: 'payment-that-does-not-exist-for-stats',
      }),
    );

    const after = await stripeWebhookStats();

    /**
     * Deltas, and INEQUALITIES rather than exact ones.
     *
     * `providerEventStats` counts every `stripe` row in the database by design —
     * it is a queue depth, not a per-test figure — and these files share ONE
     * throwaway database and run in PARALLEL. `stripe-webhook.integration.test.ts`
     * stores its own unresolvable events at the same time, so `toBe(before + 1)`
     * fails whenever the two overlap: measured here as `expected 4 to be 3`,
     * which reads exactly like a double-count bug in the query and is not one.
     */
    expect(after.pending).toBeGreaterThanOrEqual(before.pending + 1);
    expect(after.failed).toBeGreaterThanOrEqual(before.failed + 1);
    expect(after.oldestUnprocessedAt).not.toBeNull();
    expect(after.lagSeconds).toBeGreaterThanOrEqual(0);

    /**
     * What an inequality alone would not catch: `failed` is a SUBSET of
     * `pending` (both `filter` clauses run over the same scan, and every
     * `failed` row is also counted as pending), so a filter mixed up between the
     * two would show up here even though both counts grew.
     */
    expect(after.failed).toBeLessThanOrEqual(after.pending);
  });
});
