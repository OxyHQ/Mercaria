/**
 * The Stripe ingress across BOTH real stores — Postgres for the event, the
 * payment and its ledger, MongoDB for the orders it funds.
 *
 * ## Why neither store can be mocked here
 *
 * Every property under test lives in the gap between the two, or inside a
 * constraint no mock has:
 *
 *  - a redelivered event is deduped by a UNIQUE index with `NULLS NOT
 *    DISTINCT`, which is the one thing a mocked `insert` cannot refuse;
 *  - "one ledger transaction, one outbox event, one order transition" from a
 *    duplicated or reordered sequence is held by a Postgres compare-and-swap on
 *    one side and a Mongo one on the other;
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
import mongoose, { Types } from 'mongoose';
import Stripe from 'stripe';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../../db/postgres.js';

const mongoUri = process.env.MERCARIA_TEST_MONGODB_URI;

const PLATFORM_SECRET = 'whsec_realdb_platform_not_a_real_one';
const CONNECT_SECRET = 'whsec_realdb_connect_not_a_real_one';

/** Attempts after which a retryable failure dead-letters. Small so the test is fast. */
const MAX_ATTEMPTS = 2;

const BUYER = 'oxy-user-stripe-buyer';
const SELLER = 'oxy-user-stripe-seller';
/** Grand total of one seeded order, in EUR minor units. */
const ORDER_TOTAL = 4_500;
const SEEDED_AVAILABLE = 10;
const RESERVED_QTY = 1;

/**
 * The fake Stripe client's state, created in a hoisted block so the `vi.mock`
 * factory below can close over it — a factory is hoisted above every `const` in
 * this file and would otherwise reference an uninitialised binding.
 */
const stripeApi = vi.hoisted(() => ({
  /** PaymentIntent id → the object `retrieve` should answer with. */
  intents: new Map<string, { id: string; status: string; metadata: Record<string, string> }>(),
  /** Every retrieve this test provoked, so a re-read can be ASSERTED, not assumed. */
  retrieved: [] as string[],
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
}));

let db: Database;
let closePostgres: typeof import('../../../../db/postgres.js').closePostgres;
let Order: typeof import('../../../../models/order.js').Order;
let ProductVariant: typeof import('../../../../models/product-variant.js').ProductVariant;
let SellerProfile: typeof import('../../../../models/seller-profile.js').SellerProfile;
let ensurePayment: typeof import('../../payment.service.js').ensurePayment;
let applyPaymentStatus: typeof import('../../payment.service.js').applyPaymentStatus;
let ingestStripeDelivery: typeof import('../ingress.js').ingestStripeDelivery;
let drainStripeEvents: typeof import('../event-processor.js').drainStripeEvents;
let replayProviderEvent: typeof import('../event-processor.js').replayProviderEvent;
let stripeWebhookStats: typeof import('../event-processor.js').stripeWebhookStats;
let schema: typeof import('../../../../db/schema/payments.js');
let ledgerSchema: typeof import('../../../../db/schema/ledger.js');

beforeAll(async () => {
  if (!mongoUri) {
    throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  }

  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.STRIPE_EVENT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);

  await mongoose.connect(mongoUri, { dbName: 'mercaria-stripe-ingress-test' });

  const postgres = await import('../../../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  ({ Order } = await import('../../../../models/order.js'));
  ({ ProductVariant } = await import('../../../../models/product-variant.js'));
  ({ SellerProfile } = await import('../../../../models/seller-profile.js'));
  ({ ensurePayment, applyPaymentStatus } = await import('../../payment.service.js'));
  ({ ingestStripeDelivery } = await import('../ingress.js'));
  ({ drainStripeEvents, replayProviderEvent, stripeWebhookStats } = await import(
    '../event-processor.js'
  ));
  schema = await import('../../../../db/schema/payments.js');
  ledgerSchema = await import('../../../../db/schema/ledger.js');

  await Order.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await closePostgres();
});

beforeEach(async () => {
  stripeApi.intents.clear();
  stripeApi.retrieved.length = 0;
  // Mongo fixtures are per-file (this file has its own `dbName`) and can be
  // cleared wholesale. The POSTGRES side deliberately is not — see the header.
  await Promise.all([
    Order.deleteMany({}),
    ProductVariant.deleteMany({}),
    SellerProfile.deleteMany({}),
  ]);
});

/** A EUR `DualMoney` whose two sides are equal — no conversion in play. */
function eur(amount: number) {
  return { shop: { amount, currency: 'EUR' }, presentment: { amount, currency: 'EUR' } };
}

/** Seed one `pending_payment` P2P order with a real reserved variant. */
async function seedOrder(checkoutGroupId: string): Promise<string> {
  const listingId = new Types.ObjectId().toString();
  const variant = await ProductVariant.create({
    listingId,
    title: 'Default',
    optionValues: [],
    price: { amount: ORDER_TOTAL, currency: 'EUR' },
    inventory: {
      tracked: true,
      available: SEEDED_AVAILABLE - RESERVED_QTY,
      committed: RESERVED_QTY,
    },
  });

  const order = await Order.create({
    orderNumber: `MRC-${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0')}`,
    buyerOxyUserId: BUYER,
    sellerType: 'user',
    sellerOxyUserId: SELLER,
    items: [
      {
        listingId,
        variantId: String(variant._id),
        title: 'A thing',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: eur(ORDER_TOTAL),
        quantity: RESERVED_QTY,
        lineTotal: eur(ORDER_TOTAL),
      },
    ],
    shippingAddressSnapshot: {
      recipientName: 'Buyer',
      line1: '1 Street',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shipping: { method: 'standard', label: 'Standard shipping', cost: eur(0), trackingNumber: null },
    totals: {
      subtotal: eur(ORDER_TOTAL),
      discountTotal: eur(0),
      shipping: eur(0),
      tax: eur(0),
      grandTotal: eur(ORDER_TOTAL),
    },
    status: 'pending_payment',
    statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: BUYER }],
    payment: { status: 'unpaid' },
    checkoutGroupId,
  });

  return String(order._id);
}

/** A checkout group, its order and its Stripe payment, ready to be told about. */
async function seedPayment(input: { intentId: string; status?: 'created' | 'canceled' }): Promise<{
  paymentId: string;
  orderId: string;
  checkoutGroupId: string;
}> {
  const checkoutGroupId = new Types.ObjectId().toString();
  const orderId = await seedOrder(checkoutGroupId);
  const payment = await ensurePayment({
    provider: 'stripe',
    checkoutGroupId,
    presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
    buyerOxyUserId: BUYER,
    providerObjectId: input.intentId,
  });
  if (input.status === 'canceled') {
    await applyPaymentStatus({ paymentId: payment.id, next: 'canceled' });
  }
  return { paymentId: payment.id, orderId, checkoutGroupId };
}

/** Register what the fake Stripe API answers for an intent. */
function registerIntent(id: string, status: string, paymentId: string): void {
  stripeApi.intents.set(id, { id, status, metadata: { paymentId } });
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
    expect(rows[0]?.objectIds).toEqual({ paymentIntent: intentId });
    // Platform scope carries no connected account, which is what makes the
    // unique index's NULLS NOT DISTINCT load-bearing.
    expect(rows[0]?.providerAccountId).toBeNull();

    // The payload is a SUMMARY, not the event. The buyer-identifying fields a
    // real Stripe event carries must not survive into a table operators read.
    const summary = rows[0]?.payloadSummary as { data?: { object?: Record<string, unknown> } };
    expect(summary.data?.object).toMatchObject({ id: intentId, status: 'succeeded' });

    expect(await counts(paymentId)).toEqual({ transactions: 1, entries: 2, outbox: 1 });

    const order = await Order.findById(orderId).lean<{
      status: string;
      statusHistory: { status: string }[];
    } | null>();
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
    expect(await counts(paymentId)).toEqual({ transactions: 1, entries: 2, outbox: 1 });
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
    expect(await counts(paymentId)).toEqual({ transactions: 1, entries: 2, outbox: 1 });
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
    expect(await counts(paymentId)).toEqual({ transactions: 1, entries: 2, outbox: 1 });
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
    expect(await counts(paymentId)).toEqual({ transactions: 1, entries: 2, outbox: 1 });

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
    const order = await Order.findById(orderId).lean<{ status: string } | null>();
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
  it('a connect-scope account event is stored, processed and marked deferred to #46', async () => {
    const payload = JSON.stringify({
      id: 'evt_account_seam',
      object: 'event',
      api_version: '2026-07-29.dahlia',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: 'account.updated',
      account: 'acct_seam_1',
      data: { object: { id: 'acct_seam_1', object: 'account' } },
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

    const [row] = await storedEvents('evt_account_seam');
    expect(row?.status).toBe('processed');
    // The connected account is stored — it is HALF the dedupe key, and the
    // reason platform-scope rows need NULLS NOT DISTINCT to dedupe at all.
    expect(row?.providerAccountId).toBe('acct_seam_1');
    /**
     * The seam marker. Marking a deferral `processed` and saying nothing else
     * would make it indistinguishable from real handling in the operator trace,
     * and the first person to notice would be a seller asking why their account
     * never went live.
     */
    expect(row?.processingNote).toContain('deferred: #46');
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
    const checkoutGroupId = new Types.ObjectId().toString();
    const orderId = await seedOrder(checkoutGroupId);
    const payment = await ensurePayment({
      provider: 'stripe',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'EUR' },
      buyerOxyUserId: BUYER,
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
    expect(await counts(payment.id)).toEqual({ transactions: 1, entries: 2, outbox: 1 });
    const order = await Order.findById(orderId).lean<{ status: string } | null>();
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
    expect(await counts(paymentId)).toEqual({ transactions: 1, entries: 2, outbox: 1 });
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
