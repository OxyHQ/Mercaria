/**
 * The commerce repositories, against a REAL Postgres database.
 *
 * The mocked service tests next door are right for what they check — which
 * status may follow which, how a net refund amount is prorated — and are blind to
 * everything below, totally: a mocked repository accepts any argument and returns
 * whatever the test says, so a guard that does not guard, a race that both
 * callers win, and an aggregate that sums nothing all look identical to a passing
 * suite.
 *
 * Every block here covers something only a server can answer:
 *
 *  - the order CAS really is one, so two concurrent transitions produce exactly
 *    one winner rather than two sets of inventory side-effects;
 *  - `redeemDiscountCode` refuses the second redemption at a `totalMax`, which
 *    the SHORTER `UPDATE … WHERE (subquery) < max` translation of Mongo's `$expr`
 *    does NOT (see the repository header) — this is the assertion that tells the
 *    two implementations apart, and nothing else can;
 *  - `orders_idempotency_key_key` rejects the duplicate a replayed checkout
 *    submits, and the convergence read finds the survivor;
 *  - the customer upsert settles two concurrent FIRST orders on one row with
 *    `orderCount = 2`, rather than one overwriting the other;
 *  - the two refund aggregates answer their two different questions;
 *  - `date_trunc` buckets across a month boundary, which a serialized Mongo
 *    pipeline assertion could never have shown;
 *  - both sequences format and ascend.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isUniqueViolation, uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { customers, locations, stores } from '../schema/stores.js';
import { orders, refunds } from '../schema/orders.js';
import { discounts } from '../schema/merchandising.js';
import { insertStore } from '../stores/storeRepository.js';
import { insertVariants } from '../catalog/variantRepository.js';
import {
  findOrderByIdempotencyKey,
  findOrderById,
  insertOrder,
  nextOrderNumber,
  sumPaidRevenue,
  sumPaidRevenueByBucket,
  findTopProducts,
  transitionOrderStatus,
  type NewOrder,
} from '../orders/orderRepository.js';
import {
  insertRefund,
  nextRmaNumber,
  sumRefundedQuantities,
  sumRestockedQuantities,
} from '../orders/refundRepository.js';
import { insertDiscount, redeemDiscountCode } from '../merchandising/discountRepository.js';
import { upsertCustomerOnPaid } from '../stores/customerRepository.js';

let db: Database;

/** Store ids created by a test, dropped after it so the shared database stays clean. */
const createdStoreIds: string[] = [];

/** The settlement currency used throughout — FAIR needs no FX provider. */
const CURRENCY: CurrencyCode = 'FAIR';

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    // `refunds.order_id` is RESTRICT — a refund without its order is an
    // unexplained outbound payment — so the refunds go before the orders. The
    // orders and listings are RESTRICT from the store, so both go before it.
    await db.delete(refunds).where(eq(refunds.storeId, storeId));
    await db.delete(orders).where(eq(orders.storeId, storeId));
    await db.delete(listings).where(eq(listings.storeId, storeId));
    await db.delete(discounts).where(eq(discounts.storeId, storeId));
    await db.delete(customers).where(eq(customers.storeId, storeId));
    await db.delete(locations).where(eq(locations.storeId, storeId));
    await db.delete(stores).where(eq(stores.id, storeId));
  }
});

/** Create a store and register it for cleanup. */
async function makeStore(): Promise<string> {
  // The WHOLE uuid, not a prefix: v7 is time-ordered, so two ids minted in the
  // same millisecond share their leading characters and a truncated suffix
  // collides with `stores_handle_key` — the constraint working, in the wrong test.
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `commerce-${suffix}`,
      name: 'Commerce store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: CURRENCY,
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  return store.id;
}

/** A listing with one variant on it, for the order lines. */
async function makeVariant(storeId: string): Promise<{ listingId: string; variantId: string }> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId,
      title: 'Commerce product',
      description: '',
      condition: 'new',
    })
    .returning({ id: listings.id });

  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default Title',
      priceAmount: 1000,
      priceCurrency: CURRENCY,
      inventoryTracked: true,
      inventoryAvailable: 10,
      position: 0,
      optionValues: [],
    },
  ]);

  return { listingId: listing.id, variantId: variant.id };
}

/** A `DualMoney` where shop == presentment (a same-currency order). */
function dual(amount: number) {
  return {
    shop: { amount, currency: CURRENCY },
    presentment: { amount, currency: CURRENCY },
  } as const;
}

/** A whole order, ready to insert. */
async function orderInput(
  storeId: string,
  overrides: Partial<NewOrder> & { lines?: NewOrder['items'] } = {},
): Promise<NewOrder> {
  const grandTotal = overrides.totals?.grandTotal.shop.amount ?? 2000;
  return {
    orderNumber: await nextOrderNumber(),
    buyerOxyUserId: `buyer-${uuidv7()}`,
    sellerType: 'store',
    storeId,
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: dual(0),
    totals: {
      subtotal: dual(grandTotal),
      discountTotal: dual(0),
      shipping: dual(0),
      tax: dual(0),
      grandTotal: dual(grandTotal),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    paymentProvider: 'oxy_pay',
    checkoutGroupId: uuidv7(),
    items: overrides.lines ?? [],
    statusHistory: [{ status: 'pending_payment', at: new Date() }],
    appliedDiscounts: [],
    taxLines: [],
    ...overrides,
  };
}

describe('the order status CAS', () => {
  it('lets exactly ONE of two concurrent transitions win', async () => {
    const storeId = await makeStore();
    const order = await insertOrder(await orderInput(storeId));

    // The Mongo form made the guard and the mutation one operation, which is what
    // stopped a buyer's cancel racing the expiry sweep from running the inventory
    // side-effects twice. The Postgres form has to have the same property: the row
    // is locked for the statement, so the loser's predicate is re-checked against
    // the winner's write and matches nothing.
    const [first, second] = await Promise.all([
      transitionOrderStatus(order.id, 'pending_payment', 'paid', { paymentStatus: 'paid' }, {
        status: 'paid',
        at: new Date(),
      }),
      transitionOrderStatus(order.id, 'pending_payment', 'paid', { paymentStatus: 'paid' }, {
        status: 'paid',
        at: new Date(),
      }),
    ]);

    const winners = [first, second].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.order.status).toBe('paid');

    // And the trail carries ONE event for the move, not two — the loser must not
    // have appended anything either.
    const persisted = await findOrderById(order.id);
    expect(persisted?.statusHistory.filter((event) => event.status === 'paid')).toHaveLength(1);
  });

  it('refuses a transition whose expected status is already gone', async () => {
    // The vacuity guard for the block above: a CAS that let everything through
    // would satisfy "exactly one winner" only by accident of timing.
    const storeId = await makeStore();
    const order = await insertOrder(await orderInput(storeId));

    await transitionOrderStatus(order.id, 'pending_payment', 'paid', {}, {
      status: 'paid',
      at: new Date(),
    });
    const stale = await transitionOrderStatus(order.id, 'pending_payment', 'cancelled', {}, {
      status: 'cancelled',
      at: new Date(),
    });

    expect(stale).toBeNull();
    expect((await findOrderById(order.id))?.status).toBe('paid');
  });
});

describe('discount redemption against a total-usage ceiling', () => {
  /** A code-method discount capped at `totalMax`, with one code already used. */
  async function makeCappedDiscount(storeId: string, totalMax: number, alreadyUsed: number) {
    const code = `CAP${uuidv7().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const discount = await insertDiscount(storeId, {
      title: 'Capped',
      method: 'code',
      valueType: 'percentage',
      value: 1000,
      appliesTo: { scope: 'order' },
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
      startsAt: new Date(0),
      isActive: true,
      usageLimits: { totalMax },
      codes: [code],
    });
    if (alreadyUsed > 0) {
      await db.execute(
        sql`update discount_codes set usage_count = ${alreadyUsed} where discount_id = ${discount.id}`,
      );
    }
    return code;
  }

  /** The summed usage across a code's discount. */
  async function usageOf(code: string): Promise<number> {
    const [row] = await db.execute<{ total: number }>(
      sql`select coalesce(sum(c2.usage_count), 0)::int as total
          from discount_codes c
          join discount_codes c2 on c2.discount_id = c.discount_id
          where c.code = ${code}`,
    );
    return Number(row?.total ?? 0);
  }

  it('lets exactly ONE of two concurrent redemptions through at totalMax - 1', async () => {
    /**
     * The assertion this whole file exists for. Mongo enforced the ceiling with
     * an `$expr` inside the same `updateOne`, which is safe there because the
     * document is re-read under the write lock. The obvious Postgres translation
     * — a subquery in `UPDATE … WHERE` — is NOT: READ COMMITTED evaluates it
     * against the statement's own snapshot and explicitly does not re-read OTHER
     * rows during an EvalPlanQual recheck, so both redemptions see the
     * pre-increment sum and both pass.
     *
     * `redeemDiscountCode` therefore locks the parent discount first and counts in
     * a SEPARATE statement, which takes a fresh snapshot after the wait. Nothing
     * but two genuinely concurrent calls against a real server can tell the two
     * implementations apart.
     */
    const storeId = await makeStore();
    const code = await makeCappedDiscount(storeId, 3, 2);

    const [first, second] = await Promise.all([redeemDiscountCode(code), redeemDiscountCode(code)]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await usageOf(code)).toBe(3);
  });

  it('refuses a redemption once the ceiling is already reached', async () => {
    const storeId = await makeStore();
    const code = await makeCappedDiscount(storeId, 2, 2);

    expect(await redeemDiscountCode(code)).toBe(false);
    expect(await usageOf(code)).toBe(2);
  });

  it('counts every redemption of an UNCAPPED discount', async () => {
    // The vacuity guard: a guard that refused everything would satisfy both
    // assertions above and silently stop counting redemptions altogether.
    const storeId = await makeStore();
    const code = await makeCappedDiscount(storeId, 0, 0);
    await db.execute(
      sql`update discounts set usage_limits_total_max = null where store_id = ${storeId}`,
    );

    expect(await redeemDiscountCode(code)).toBe(true);
    expect(await redeemDiscountCode(code)).toBe(true);
    expect(await usageOf(code)).toBe(2);
  });
});

describe('checkout idempotency', () => {
  it('rejects the duplicate a replayed checkout submits, and the survivor is findable', async () => {
    const storeId = await makeStore();
    const idempotencyKey = `idem-${uuidv7()}`;

    const first = await insertOrder(await orderInput(storeId, { idempotencyKey }));

    let caught: unknown;
    try {
      await insertOrder(await orderInput(storeId, { idempotencyKey }));
    } catch (error) {
      caught = error;
    }

    // The NAMED index. `checkout.service` converges only for this one, because
    // converging for SOME other unique violation would return another buyer's
    // orders.
    expect(isUniqueViolation(caught, 'orders_idempotency_key_key')).toBe(true);

    const converged = await findOrderByIdempotencyKey(idempotencyKey);
    expect(converged?.id).toBe(first.id);
  });

  it('writes the order and its children atomically', async () => {
    // A half-written order is not a degraded record, it is a charge with no
    // lines: hydration would serve it with an empty `items`, every report would
    // count its revenue, and no refund could be computed against it.
    const storeId = await makeStore();
    const { listingId, variantId } = await makeVariant(storeId);

    const order = await insertOrder(
      await orderInput(storeId, {
        lines: [
          {
            listingId,
            variantId,
            title: 'Commerce product',
            variantTitle: 'Default Title',
            optionValues: [{ name: 'Size', value: 'M' }],
            unitPrice: dual(1000),
            quantity: 2,
            lineTotal: dual(2000),
          },
        ],
        appliedDiscounts: [
          {
            discountId: uuidv7(),
            title: 'Welcome',
            valueType: 'percentage',
            amount: { amount: 100, currency: CURRENCY },
            target: 'order',
          },
        ],
        taxLines: [{ name: 'VAT', rateBps: 2100, amount: { amount: 210, currency: CURRENCY } }],
      }),
    );

    const persisted = await findOrderById(order.id);
    expect(persisted?.items).toHaveLength(1);
    expect(persisted?.items[0].optionValues).toEqual([
      expect.objectContaining({ name: 'Size', value: 'M' }),
    ]);
    expect(persisted?.appliedDiscounts).toHaveLength(1);
    expect(persisted?.taxLines).toHaveLength(1);
    expect(persisted?.statusHistory).toHaveLength(1);
  });
});

describe('the customer upsert on a paid order', () => {
  it('settles two concurrent FIRST orders on ONE row with orderCount 2', async () => {
    /**
     * Two orders of the same buyer paid at once. `ON CONFLICT … DO UPDATE` has to
     * make the second an increment of the first rather than an insert that loses
     * the race, and the increment has to read the EXISTING row rather than
     * `excluded` — reading `excluded` would set the count to the proposed 1 twice.
     */
    const storeId = await makeStore();
    const buyer = `buyer-${uuidv7()}`;

    await Promise.all([
      upsertCustomerOnPaid(storeId, buyer, { amount: 1500, currency: CURRENCY }),
      upsertCustomerOnPaid(storeId, buyer, { amount: 2500, currency: CURRENCY }),
    ]);

    const rows = await db
      .select({
        id: customers.id,
        orderCount: customers.statsOrderCount,
        totalSpent: customers.statsTotalSpentAmount,
      })
      .from(customers)
      .where(eq(customers.storeId, storeId));

    expect(rows).toHaveLength(1);
    expect(rows[0].orderCount).toBe(2);
    expect(rows[0].totalSpent).toBe(4000);
  });
});

describe('the two refund aggregates', () => {
  it('counts every refunded unit, but only the RESTOCKED ones for the shelf', async () => {
    /**
     * The distinction the order cancel path depends on. A refund that returned a
     * buyer's money without taking the goods back contributes to "may this line
     * be refunded again" and NOT to "what does a later cancel still owe the
     * shelf" — collapsing the two would restock a unit nobody ever received.
     */
    const storeId = await makeStore();
    const { listingId, variantId } = await makeVariant(storeId);
    const order = await insertOrder(
      await orderInput(storeId, {
        lines: [
          {
            listingId,
            variantId,
            title: 'Commerce product',
            variantTitle: 'Default Title',
            optionValues: [],
            unitPrice: dual(1000),
            quantity: 3,
            lineTotal: dual(3000),
          },
        ],
      }),
    );

    // Two partial refunds of one unit each: the first put its unit back on the
    // shelf, the second returned money only.
    for (const restock of [true, false]) {
      await insertRefund({
        orderId: order.id,
        storeId,
        type: 'refund',
        status: 'refunded',
        totalRefunded: dual(1000),
        lineItems: [{ variantId, quantity: 1, amount: dual(1000), restock }],
      });
    }

    expect((await sumRefundedQuantities(order.id)).get(variantId)).toBe(2);
    expect((await sumRestockedQuantities(order.id)).get(variantId)).toBe(1);
  });
});

describe('the sales report', () => {
  it('buckets by month across a boundary, and sums only the store shop currency', async () => {
    const storeId = await makeStore();
    const { listingId, variantId } = await makeVariant(storeId);

    /** A paid order settled at `paidAt`, worth `amount`, in `currency`. */
    const paidOrder = async (
      paidAt: Date,
      amount: number,
      currency: CurrencyCode,
    ): Promise<void> => {
      await insertOrder(
        await orderInput(storeId, {
          status: 'paid',
          paymentStatus: 'paid',
          paymentPaidAt: paidAt,
          totals: {
            subtotal: {
              shop: { amount, currency },
              presentment: { amount, currency },
            },
            discountTotal: { shop: { amount: 0, currency }, presentment: { amount: 0, currency } },
            shipping: { shop: { amount: 0, currency }, presentment: { amount: 0, currency } },
            tax: { shop: { amount: 0, currency }, presentment: { amount: 0, currency } },
            grandTotal: {
              shop: { amount, currency },
              presentment: { amount, currency },
            },
          },
          shippingCost: { shop: { amount: 0, currency }, presentment: { amount: 0, currency } },
          lines: [
            {
              listingId,
              variantId,
              title: 'Commerce product',
              variantTitle: 'Default Title',
              optionValues: [],
              unitPrice: { shop: { amount, currency }, presentment: { amount, currency } },
              quantity: 1,
              lineTotal: { shop: { amount, currency }, presentment: { amount, currency } },
            },
          ],
        }),
      );
    };

    // Two sales either side of a month boundary, plus one an hour before the end
    // of June so the June bucket really aggregates rather than merely existing.
    // The instants are UTC and `date_trunc` truncates a `timestamptz` in the
    // SESSION time zone — these are far enough from midnight that the assertion
    // does not depend on which zone the server runs in.
    await paidOrder(new Date('2026-06-15T12:00:00.000Z'), 1000, CURRENCY);
    await paidOrder(new Date('2026-06-20T12:00:00.000Z'), 1500, CURRENCY);
    await paidOrder(new Date('2026-07-10T12:00:00.000Z'), 700, CURRENCY);
    // A EUR sale in the same window, which the store does not settle in.
    await paidOrder(new Date('2026-07-11T12:00:00.000Z'), 9999, 'EUR');

    const buckets = await sumPaidRevenueByBucket(
      storeId,
      CURRENCY,
      { from: new Date('2026-06-01T00:00:00.000Z'), to: new Date('2026-07-31T23:59:59.000Z') },
      'month',
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[0].orders).toBe(2);
    expect(buckets[0].revenue).toBe(2500);
    expect(buckets[1].orders).toBe(1);
    // 700 and NOT 10_699: the EUR sale is excluded by a predicate on a real
    // column, which is the whole reason the money stayed flat rather than jsonb.
    expect(buckets[1].revenue).toBe(700);

    const total = await sumPaidRevenue(storeId, CURRENCY);
    expect(total.paidOrderCount).toBe(3);
    expect(total.revenue).toBe(3200);

    const top = await findTopProducts(
      storeId,
      CURRENCY,
      { from: new Date('2026-06-01T00:00:00.000Z'), to: new Date('2026-07-31T23:59:59.000Z') },
      10,
    );
    expect(top).toHaveLength(1);
    expect(top[0].listingId).toBe(listingId);
    expect(top[0].unitsSold).toBe(3);
    expect(top[0].revenue).toBe(3200);
  });
});

describe('the printed sequences', () => {
  it('formats and ascends, and the two never share a counter', async () => {
    const firstOrder = await nextOrderNumber();
    const firstRma = await nextRmaNumber();
    const secondOrder = await nextOrderNumber();
    const secondRma = await nextRmaNumber();

    expect(firstOrder).toMatch(/^MRC-\d{6}$/);
    expect(firstRma).toMatch(/^RMA-\d{6}$/);

    const seq = (formatted: string): number => Number(formatted.slice(4));
    expect(seq(secondOrder)).toBe(seq(firstOrder) + 1);
    expect(seq(secondRma)).toBe(seq(firstRma) + 1);
  });
});
