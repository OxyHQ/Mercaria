/**
 * The payment service across BOTH real stores — Postgres for the payment and its
 * ledger, MongoDB for the orders it funds.
 *
 * ## Why both, and why neither can be mocked here
 *
 * Every property under test lives in the gap between the two:
 *
 *  - a duplicate provider event books ONE ledger transaction and causes ONE
 *    order transition (#45 acceptance 3). The first half is held by a Postgres
 *    compare-and-swap and the second by a Mongo one; mocking either turns the
 *    test into an assertion about the mock;
 *  - a failed payment leaves the reservation alone (#45 acceptance 4) — which is
 *    a statement about what did NOT happen to a real inventory level;
 *  - an external payment is visible and books no cash (#45 acceptance 5), which
 *    is a claim about the contents of two tables.
 *
 * A replica SET for Mongo, because `order.service.transition` is a
 * `findOneAndUpdate` compare-and-swap and the inventory writes beside it are
 * what the duplicate-event test is really probing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Types } from 'mongoose';
import { sql } from 'drizzle-orm';
import { ledgerEntries, ledgerTransactions } from '../../../db/schema/ledger.js';
import { paymentAttempts, payments } from '../../../db/schema/payments.js';
import type { Database } from '../../../db/postgres.js';

const uri = process.env.MERCARIA_TEST_MONGODB_URI;

/** The buyer of every order below. */
const BUYER = 'oxy-user-buyer';
/** The P2P seller of every order below. */
const SELLER = 'oxy-user-seller';
/** Grand total of one seeded order, in FAIR minor units. */
const ORDER_TOTAL = 300_000_000;
/** Stock seeded on the variant every order reserves from. */
const SEEDED_AVAILABLE = 10;
/** Units each seeded order has reserved — held in `inventory.committed`. */
const RESERVED_QTY = 2;

let db: Database;
let closePostgres: typeof import('../../../db/postgres.js').closePostgres;
let Order: typeof import('../../../models/order.js').Order;
let ProductVariant: typeof import('../../../models/product-variant.js').ProductVariant;
let SellerProfile: typeof import('../../../models/seller-profile.js').SellerProfile;
let ensurePayment: typeof import('../payment.service.js').ensurePayment;
let applyPaymentStatus: typeof import('../payment.service.js').applyPaymentStatus;
let applyProviderEvent: typeof import('../payment.service.js').applyProviderEvent;
let tracePayment: typeof import('../payment.service.js').tracePayment;
let SyntheticPaymentProvider: typeof import('../synthetic-provider.js').SyntheticPaymentProvider;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  await mongoose.connect(uri, { dbName: 'mercaria-payment-service-test' });

  const postgres = await import('../../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  ({ Order } = await import('../../../models/order.js'));
  ({ ProductVariant } = await import('../../../models/product-variant.js'));
  ({ SellerProfile } = await import('../../../models/seller-profile.js'));
  ({ ensurePayment, applyPaymentStatus, applyProviderEvent, tracePayment } = await import(
    '../payment.service.js'
  ));
  ({ SyntheticPaymentProvider } = await import('../synthetic-provider.js'));

  await Order.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await closePostgres();
});

beforeEach(async () => {
  // Mongo fixtures are per-file (this file has its own `dbName`) and can be
  // cleared wholesale. The POSTGRES side deliberately is not: the ledger is
  // append-only, so emptying it needs TRUNCATE — a TABLE-level statement — and
  // vitest runs files in parallel against ONE throwaway database, so a truncate
  // here takes another file's rows with it. It did: the POS sale's payment
  // vanished mid-transaction the first time this file ran beside it, and the
  // failure reproduced only under concurrency.
  //
  // Every Postgres assertion below is therefore scoped to the payment the test
  // itself created, which is the stronger form anyway.
  await Promise.all([
    Order.deleteMany({}),
    ProductVariant.deleteMany({}),
    SellerProfile.deleteMany({}),
  ]);
});

/** A FAIR `DualMoney` whose two sides are equal — no conversion in play. */
function fair(amount: number) {
  return {
    shop: { amount, currency: 'FAIR' },
    presentment: { amount, currency: 'FAIR' },
  };
}

/** Seed one `pending_payment` P2P order with a real reserved variant. */
async function seedOrder(checkoutGroupId: string): Promise<{ orderId: string; variantId: string }> {
  const listingId = new Types.ObjectId().toString();
  const variant = await ProductVariant.create({
    listingId,
    title: 'Default',
    optionValues: [],
    price: { amount: ORDER_TOTAL, currency: 'FAIR' },
    inventory: { tracked: true, available: SEEDED_AVAILABLE - RESERVED_QTY, committed: RESERVED_QTY },
  });
  const variantId = String(variant._id);

  const order = await Order.create({
    orderNumber: `MRC-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`,
    buyerOxyUserId: BUYER,
    sellerType: 'user',
    sellerOxyUserId: SELLER,
    items: [
      {
        listingId,
        variantId,
        title: 'A thing',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: fair(ORDER_TOTAL),
        quantity: RESERVED_QTY,
        lineTotal: fair(ORDER_TOTAL),
      },
    ],
    shippingAddressSnapshot: {
      recipientName: 'Buyer',
      line1: '1 Street',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shipping: { method: 'standard', label: 'Standard shipping', cost: fair(0), trackingNumber: null },
    totals: {
      subtotal: fair(ORDER_TOTAL),
      discountTotal: fair(0),
      shipping: fair(0),
      tax: fair(0),
      grandTotal: fair(ORDER_TOTAL),
    },
    status: 'pending_payment',
    statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: BUYER }],
    payment: { status: 'unpaid' },
    checkoutGroupId,
  });

  return { orderId: String(order._id), variantId };
}

/** What ONE payment wrote: its ledger transactions, their entries and its attempts. */
async function counts(
  paymentId: string,
): Promise<{ transactions: number; entries: number; attempts: number }> {
  const [[t], [e], [a]] = await Promise.all([
    db
      .select({ n: sql<string>`count(*)` })
      .from(ledgerTransactions)
      .where(sql`${ledgerTransactions.paymentId} = ${paymentId}`),
    db
      .select({ n: sql<string>`count(*)` })
      .from(ledgerEntries)
      .where(
        sql`${ledgerEntries.transactionId} in (select ${ledgerTransactions.id} from ${ledgerTransactions} where ${ledgerTransactions.paymentId} = ${paymentId})`,
      ),
    db
      .select({ n: sql<string>`count(*)` })
      .from(paymentAttempts)
      .where(sql`${paymentAttempts.paymentId} = ${paymentId}`),
  ]);
  return { transactions: Number(t?.n ?? 0), entries: Number(e?.n ?? 0), attempts: Number(a?.n ?? 0) };
}

describe('a duplicate success converges on ONE state', () => {
  it('books one ledger transaction and makes one order transition, from two identical events', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    const { orderId } = await seedOrder(checkoutGroupId);
    const provider = new SyntheticPaymentProvider({ eventSecret: 'duplicate-test' });

    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });
    const created = await provider.createPayment({
      paymentId: payment.id,
      checkoutGroupId,
      amount: { amount: ORDER_TOTAL, currency: 'FAIR' },
      orderIds: [orderId],
      idempotencyKey: `pi:${payment.id}`,
      metadata: {},
    });
    // The provider object has to be on the payment before an event can be
    // correlated back to it — that lookup is by (provider, providerObjectId).
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'processing',
      providerObjectId: created.providerObjectId,
    });

    const signed = provider.signEvent(
      provider.buildEvent({
        paymentId: payment.id,
        providerObjectId: created.providerObjectId,
        status: 'succeeded',
      }),
    );

    const first = await applyProviderEvent(await provider.verifyEvent(signed));
    expect(first).toMatchObject({ duplicate: false, applied: true });

    // The SAME delivery again — byte-identical, including its event id.
    const second = await applyProviderEvent(await provider.verifyEvent(signed));
    expect(second.duplicate).toBe(true);
    expect(second.applied).toBe(false);

    // ONE ledger transaction, with the two legs a zero-fee zero-commission
    // charge produces. A second would be a doubled receivable to the seller.
    const after = await counts(payment.id);
    expect(after.transactions).toBe(1);
    expect(after.entries).toBe(2);

    // ONE order transition: the status history has exactly one `paid` entry.
    const order = await Order.findById(orderId).lean<{
      status: string;
      statusHistory: { status: string }[];
      payment: { status: string; paymentId?: string; provider?: string };
    } | null>();
    expect(order?.status).toBe('paid');
    expect(order?.statusHistory.filter((event) => event.status === 'paid')).toHaveLength(1);
    expect(order?.payment.status).toBe('paid');
    expect(order?.payment.paymentId).toBe(payment.id);
    expect(order?.payment.provider).toBe('mock');

    // And the seller's sales counter moved exactly once — the side effect that
    // would betray a second transition even if the history somehow did not.
    const seller = await SellerProfile.findOne({ oxyUserId: SELLER }).lean<{
      salesCount: number;
    } | null>();
    expect(seller?.salesCount).toBe(1);
  });

  it('refuses an out-of-order event that would walk the payment backwards', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    await seedOrder(checkoutGroupId);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });

    await applyPaymentStatus({ paymentId: payment.id, next: 'succeeded' });
    const stale = await applyPaymentStatus({ paymentId: payment.id, next: 'processing' });

    // `processing` is not reachable from `succeeded`, so the compare-and-swap
    // matches nothing and everything downstream of it is skipped.
    expect(stale.changed).toBe(false);
    expect(stale.payment.status).toBe('succeeded');
    expect((await counts(payment.id)).transactions).toBe(1);
  });
});

describe('a failed payment leaks no reservation', () => {
  it('leaves the order pending_payment and cancellable, and the stock reserved', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    const { orderId, variantId } = await seedOrder(checkoutGroupId);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });

    const failed = await applyPaymentStatus({
      paymentId: payment.id,
      next: 'failed',
      providerEventId: 'evt_declined_1',
      errorCode: 'card_declined',
      errorMessage: 'The card was declined for buyer@example.com',
    });
    expect(failed.changed).toBe(true);

    // The inventory is EXACTLY as it was. A payment failure releasing stock
    // would be a second releaser beside the reservation sweep, and two things
    // releasing one reservation is how available goes negative.
    const variant = await ProductVariant.findById(variantId).lean<{
      inventory: { available: number; committed: number };
    } | null>();
    expect(variant?.inventory.available).toBe(SEEDED_AVAILABLE - RESERVED_QTY);
    expect(variant?.inventory.committed).toBe(RESERVED_QTY);

    // The order is untouched and still cancellable — which is what the sweep
    // will do, releasing the stock through the ORDER transition that owns it.
    const order = await Order.findById(orderId);
    expect(order?.status).toBe('pending_payment');

    const { transition } = await import('../../order.service.js');
    if (!order) throw new Error('order vanished');
    await transition(order, 'cancelled', { note: 'reservation expired' });

    const released = await ProductVariant.findById(variantId).lean<{
      inventory: { available: number; committed: number };
    } | null>();
    expect(released?.inventory.available).toBe(SEEDED_AVAILABLE);
    expect(released?.inventory.committed).toBe(0);

    // No accounting at all for a payment that never took money.
    expect((await counts(payment.id)).transactions).toBe(0);
  });

  it('records the failure as an attempt, with the message REDACTED', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    await seedOrder(checkoutGroupId);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'failed',
      providerEventId: 'evt_declined_2',
      errorCode: 'card_declined',
      errorMessage: 'Declined for buyer@example.com on card 4242424242424242',
    });

    const trace = await tracePayment({ byPaymentId: payment.id });
    const attempt = trace?.attempts.at(-1);
    expect(attempt?.status).toBe('failed');
    expect(attempt?.errorCode).toBe('card_declined');
    // The audit trail survives the failure (#45 acceptance 4) and carries no
    // buyer contact value and no card number with it (#45 invariant 9).
    expect(attempt?.errorMessage).not.toContain('buyer@example.com');
    expect(attempt?.errorMessage).not.toContain('4242424242424242');
    expect(attempt?.errorMessage).toContain('Declined');
  });
});

describe('an external payment is visible and books no cash', () => {
  it('records the payment, links the order, and writes no ledger entry', async () => {
    const checkoutGroupId = 'ext:shopify:1001';
    const { orderId } = await seedOrder(checkoutGroupId);

    const payment = await ensurePayment({
      provider: 'external',
      checkoutGroupId,
      orderId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      linkOrders: false,
    });
    expect(payment.provider).toBe('external');
    expect(payment.orderId).toBe(orderId);

    // Visible: a trace finds it from the ORDER, which is how an operator would.
    const { linkPaymentToOrder } = await import('../order-linkage.js');
    await linkPaymentToOrder({ orderId, paymentId: payment.id, provider: 'external' });
    const trace = await tracePayment({ byOrderId: orderId });
    expect(trace?.payment.id).toBe(payment.id);

    // …and no cash. ADR 0001 D12: no Mercaria money moved, so no entry exists to
    // describe money moving.
    expect(trace?.ledger).toHaveLength(0);
    expect((await counts(payment.id)).transactions).toBe(0);
  });

  it('converges on ONE payment when the same external order is imported twice', async () => {
    const checkoutGroupId = 'ext:shopify:1002';
    const { orderId } = await seedOrder(checkoutGroupId);

    const first = await ensurePayment({
      provider: 'external',
      checkoutGroupId,
      orderId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      linkOrders: false,
    });
    const second = await ensurePayment({
      provider: 'external',
      checkoutGroupId,
      orderId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      linkOrders: false,
    });
    expect(second.id).toBe(first.id);
  });

  it('lets two connected shops import orders with the SAME external id', async () => {
    // The synthetic `ext:` checkout group is NOT unique across connections —
    // two Shopify shops can each have an order 1003. Uniqueness on the group
    // would make the second shop's import fail; uniqueness on the ORDER does not.
    const sharedGroup = 'ext:shopify:1003';
    const shopA = await seedOrder(sharedGroup);
    const shopB = await seedOrder(sharedGroup);

    const paymentA = await ensurePayment({
      provider: 'external',
      checkoutGroupId: sharedGroup,
      orderId: shopA.orderId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      linkOrders: false,
    });
    const paymentB = await ensurePayment({
      provider: 'external',
      checkoutGroupId: sharedGroup,
      orderId: shopB.orderId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      linkOrders: false,
    });
    expect(paymentB.id).not.toBe(paymentA.id);
  });
});

describe('one payment per checkout group, for native rails', () => {
  it('converges a replayed checkout on the payment it already opened', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    await seedOrder(checkoutGroupId);
    const first = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });
    const second = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });
    expect(second.id).toBe(first.id);

    const [{ n }] = await db
      .select({ n: sql<string>`count(*)` })
      .from(payments)
      .where(sql`${payments.checkoutGroupId} = ${checkoutGroupId}`);
    expect(Number(n)).toBe(1);
  });
});

describe('the dev mockPay seam runs the whole real path', () => {
  it('pays EVERY order of a multi-seller checkout group, through the adapter', async () => {
    // ADR 0001 D4 makes funding atomic at the GROUP level, so a dev seam that
    // paid one order of a group would be the only path in the system able to
    // produce a state the real one cannot — which makes it useless for
    // exercising the real one. This is also the only coverage `mockPay` has ever
    // had; it previously called `transition` directly and did nothing else.
    const checkoutGroupId = new Types.ObjectId().toString();
    const first = await seedOrder(checkoutGroupId);
    const second = await seedOrder(checkoutGroupId);

    const { mockPay } = await import('../../order.service.js');
    const { resetMockPaymentProvider } = await import('../registry.js');
    resetMockPaymentProvider();

    const dto = await mockPay(BUYER, first.orderId);
    expect(dto.status).toBe('paid');

    // The SIBLING is paid too, from one payment.
    const sibling = await Order.findById(second.orderId).lean<{
      status: string;
      payment: { status: string; provider?: string; paymentId?: string };
    } | null>();
    expect(sibling?.status).toBe('paid');
    expect(sibling?.payment.provider).toBe('mock');
    expect(sibling?.payment.paymentId).toBe(dto.payment.paymentId);

    // One payment, charged for the SUM of both orders' presentment totals, with
    // a provider object id from the adapter rather than an invented one.
    const trace = await tracePayment({ byCheckoutGroupId: checkoutGroupId });
    expect(trace?.payment.presentmentAmount).toBe(ORDER_TOTAL * 2);
    expect(trace?.payment.status).toBe('succeeded');
    expect(trace?.payment.providerObjectId).toMatch(/^mock_pi_/);
    expect(trace?.orderIds).toHaveLength(2);

    // `mock` DOES book: one charge, split per seller order. THREE legs —
    // clearing in, and one payable out per order — because a zero fee and a zero
    // commission omit their legs rather than booking zeros.
    expect(trace?.ledger).toHaveLength(1);
    expect(trace?.ledger[0]?.entries).toHaveLength(3);
    const total = (trace?.ledger[0]?.entries ?? []).reduce(
      (sum, entry) => sum + entry.amountMinor,
      0n,
    );
    expect(total).toBe(0n);
  });

  it('is idempotent: paying the same order twice leaves one payment and one charge', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    const { orderId } = await seedOrder(checkoutGroupId);
    const { mockPay } = await import('../../order.service.js');
    const { resetMockPaymentProvider } = await import('../registry.js');
    resetMockPaymentProvider();

    await mockPay(BUYER, orderId);
    await mockPay(BUYER, orderId);

    const trace = await tracePayment({ byCheckoutGroupId: checkoutGroupId });
    expect(trace).toBeDefined();
    if (!trace) throw new Error('unreachable');
    expect((await counts(trace.payment.id)).transactions).toBe(1);

    const order = await Order.findById(orderId).lean<{
      statusHistory: { status: string }[];
    } | null>();
    expect(order?.statusHistory.filter((event) => event.status === 'paid')).toHaveLength(1);
  });
});

describe('the trace answers from every handle, and from none of the forbidden ones', () => {
  it('finds the same payment by id, checkout group, order and provider object', async () => {
    const checkoutGroupId = new Types.ObjectId().toString();
    const { orderId } = await seedOrder(checkoutGroupId);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: BUYER,
    });
    await applyPaymentStatus({
      paymentId: payment.id,
      next: 'succeeded',
      providerObjectId: 'mock_pi_trace',
    });

    const byId = await tracePayment({ byPaymentId: payment.id });
    const byGroup = await tracePayment({ byCheckoutGroupId: checkoutGroupId });
    const byOrder = await tracePayment({ byOrderId: orderId });
    const byObject = await tracePayment({
      byProviderObjectId: { provider: 'mock', providerObjectId: 'mock_pi_trace' },
    });

    for (const trace of [byId, byGroup, byOrder, byObject]) {
      expect(trace?.payment.id).toBe(payment.id);
    }
    // The trace carries the whole story: the attempts, the accounting and the
    // orders it funds.
    expect(byId?.attempts.length).toBeGreaterThan(0);
    expect(byId?.ledger).toHaveLength(1);
    expect(byId?.orderIds).toEqual([orderId]);
  });
});
