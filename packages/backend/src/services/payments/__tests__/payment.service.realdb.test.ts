/**
 * The payment service against a REAL Postgres database — the payment, its ledger,
 * and the orders it funds.
 *
 * ## Why none of it can be mocked here
 *
 * Every property under test lives in the gap between the payment aggregate and
 * the orders it moves:
 *
 *  - a duplicate provider event books ONE ledger transaction and causes ONE
 *    order transition (#45 acceptance 3). The first half is held by a
 *    compare-and-swap on `payments`, the second by the one on `orders`; mocking
 *    either turns the test into an assertion about the mock;
 *  - a failed payment leaves the reservation alone (#45 acceptance 4) — which is
 *    a statement about what did NOT happen to a real inventory level;
 *  - an external payment is visible and books no cash (#45 acceptance 5), which
 *    is a claim about the contents of two tables.
 *
 * The payment reaches the order through the outbox handler rather than in the
 * same transaction, so what these tests actually pin is that the handoff
 * completes — the one thing a mocked payment service cannot tell you.
 *
 * ## Isolation: every fixture is unique per test, and nothing is deleted
 *
 * `vitest.pg.globalSetup.ts` creates ONE throwaway database for the whole suite
 * and vitest runs files in parallel, so a wholesale delete between tests would
 * take another file's rows with it — and the ledger is append-only, so clearing
 * it would need a TABLE-level TRUNCATE, which is worse. Instead each test seeds
 * its own seller, buyer and listing under freshly generated ids, and every
 * assertion is scoped to them. That is the stronger form anyway: a `salesCount`
 * of 1 means this test's seller sold once, not that the table happened to be
 * empty when it ran.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { ledgerEntries, ledgerTransactions } from '../../../db/schema/ledger.js';
import { paymentAttempts, payments } from '../../../db/schema/payments.js';
import { listings } from '../../../db/schema/catalog.js';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { insertVariants, findVariantById } from '../../../db/catalog/variantRepository.js';
import {
  findOrderById,
  insertOrder,
  nextOrderNumber,
} from '../../../db/orders/orderRepository.js';
import {
  ensureSellerProfile,
  findSellerProfile,
} from '../../../db/buyers/sellerProfileRepository.js';
import { reserve } from '../../inventory.service.js';
import {
  ensurePayment,
  applyPaymentStatus,
  applyProviderEvent,
  tracePayment,
} from '../payment.service.js';
import { SyntheticPaymentProvider } from '../synthetic-provider.js';

/** Grand total of one seeded order, in FAIR minor units. */
const ORDER_TOTAL = 300_000_000;
/** Stock seeded on the variant every order reserves from. */
const SEEDED_AVAILABLE = 10;
/** Units each seeded order has reserved — held in `inventory_committed`. */
const RESERVED_QTY = 2;

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/** A FAIR `DualMoney` whose two sides are equal — no conversion in play. */
function fair(amount: number) {
  return {
    shop: { amount, currency: 'FAIR' },
    presentment: { amount, currency: 'FAIR' },
  } as const;
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
): Promise<{ orderId: string; variantId: string }> {
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
      priceCurrency: 'FAIR',
      inventoryTracked: true,
      inventoryAvailable: SEEDED_AVAILABLE,
      position: 0,
      optionValues: [],
    },
  ]);

  // A real reservation, taken the way checkout takes one — so the "a failed
  // payment releases nothing" assertion is measuring a reservation the system
  // made, not two numbers a fixture typed in.
  await reserve(variant.id, RESERVED_QTY);

  // `transition('paid')` bumps this counter; without the row there is nothing
  // for the duplicate-event test to count.
  await ensureSellerProfile(who.seller);

  const order = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
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
        unitPrice: fair(ORDER_TOTAL),
        quantity: RESERVED_QTY,
        lineTotal: fair(ORDER_TOTAL),
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
    shippingCost: fair(0),
    totals: {
      subtotal: fair(ORDER_TOTAL),
      discountTotal: fair(0),
      shipping: fair(0),
      tax: fair(0),
      grandTotal: fair(ORDER_TOTAL),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    checkoutGroupId,
    statusHistory: [{ status: 'pending_payment', at: new Date(), byOxyUserId: who.buyer }],
    appliedDiscounts: [],
    taxLines: [],
  });

  return { orderId: order.id, variantId: variant.id };
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
    const who = actors();
    const checkoutGroupId = uuidv7();
    const { orderId } = await seedOrder(checkoutGroupId, who);
    const provider = new SyntheticPaymentProvider({ eventSecret: 'duplicate-test' });

    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
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
    const order = await findOrderById(orderId);
    expect(order?.status).toBe('paid');
    expect(order?.statusHistory.filter((event) => event.status === 'paid')).toHaveLength(1);
    expect(order?.paymentStatus).toBe('paid');
    expect(order?.paymentId).toBe(payment.id);
    expect(order?.paymentProvider).toBe('mock');

    // And the seller's sales counter moved exactly once — the side effect that
    // would betray a second transition even if the history somehow did not.
    const seller = await findSellerProfile(who.seller);
    expect(seller?.salesCount).toBe(1);
  });

  it('refuses an out-of-order event that would walk the payment backwards', async () => {
    const who = actors();
    const checkoutGroupId = uuidv7();
    await seedOrder(checkoutGroupId, who);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
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
    const who = actors();
    const checkoutGroupId = uuidv7();
    const { orderId, variantId } = await seedOrder(checkoutGroupId, who);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
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
    const variant = await findVariantById(variantId);
    expect(variant?.inventoryAvailable).toBe(SEEDED_AVAILABLE - RESERVED_QTY);
    expect(variant?.inventoryCommitted).toBe(RESERVED_QTY);

    // The order is untouched and still cancellable — which is what the sweep
    // will do, releasing the stock through the ORDER transition that owns it.
    const order = await findOrderById(orderId);
    expect(order?.status).toBe('pending_payment');

    const { transition } = await import('../../order.service.js');
    if (!order) throw new Error('order vanished');
    await transition(order, 'cancelled', { note: 'reservation expired' });

    const released = await findVariantById(variantId);
    expect(released?.inventoryAvailable).toBe(SEEDED_AVAILABLE);
    expect(released?.inventoryCommitted).toBe(0);

    // No accounting at all for a payment that never took money.
    expect((await counts(payment.id)).transactions).toBe(0);
  });

  it('records the failure as an attempt, with the message REDACTED', async () => {
    const who = actors();
    const checkoutGroupId = uuidv7();
    await seedOrder(checkoutGroupId, who);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
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
    const who = actors();
    const checkoutGroupId = `ext:shopify:${uuidv7()}`;
    const { orderId } = await seedOrder(checkoutGroupId, who);

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
    const who = actors();
    const checkoutGroupId = `ext:shopify:${uuidv7()}`;
    const { orderId } = await seedOrder(checkoutGroupId, who);

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
    const who = actors();
    const sharedGroup = `ext:shopify:${uuidv7()}`;
    const shopA = await seedOrder(sharedGroup, who);
    const shopB = await seedOrder(sharedGroup, who);

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
    const who = actors();
    const checkoutGroupId = uuidv7();
    await seedOrder(checkoutGroupId, who);
    const first = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
    });
    const second = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
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
    const who = actors();
    const checkoutGroupId = uuidv7();
    const first = await seedOrder(checkoutGroupId, who);
    const second = await seedOrder(checkoutGroupId, who);

    const { mockPay } = await import('../../order.service.js');
    const { resetMockPaymentProvider } = await import('../registry.js');
    resetMockPaymentProvider();

    const dto = await mockPay(who.buyer, first.orderId);
    expect(dto.status).toBe('paid');

    // The SIBLING is paid too, from one payment.
    const sibling = await findOrderById(second.orderId);
    expect(sibling?.status).toBe('paid');
    expect(sibling?.paymentProvider).toBe('mock');
    expect(sibling?.paymentId).toBe(dto.payment.paymentId);

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
    const who = actors();
    const checkoutGroupId = uuidv7();
    const { orderId } = await seedOrder(checkoutGroupId, who);
    const { mockPay } = await import('../../order.service.js');
    const { resetMockPaymentProvider } = await import('../registry.js');
    resetMockPaymentProvider();

    await mockPay(who.buyer, orderId);
    await mockPay(who.buyer, orderId);

    const trace = await tracePayment({ byCheckoutGroupId: checkoutGroupId });
    expect(trace).toBeDefined();
    if (!trace) throw new Error('unreachable');
    expect((await counts(trace.payment.id)).transactions).toBe(1);

    const order = await findOrderById(orderId);
    expect(order?.statusHistory.filter((event) => event.status === 'paid')).toHaveLength(1);
  });
});

describe('the trace answers from every handle, and from none of the forbidden ones', () => {
  it('finds the same payment by id, checkout group, order and provider object', async () => {
    const who = actors();
    const checkoutGroupId = uuidv7();
    const { orderId } = await seedOrder(checkoutGroupId, who);
    const payment = await ensurePayment({
      provider: 'mock',
      checkoutGroupId,
      presentment: { amount: ORDER_TOTAL, currency: 'FAIR' },
      buyerOxyUserId: who.buyer,
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
