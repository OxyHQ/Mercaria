/**
 * The fee domain against a REAL Postgres database (#88).
 *
 * Every property here is a property of the SERVER, not of any caller: the
 * immutability trigger on published schedule versions, the one-active-per-key
 * partial unique index, the append-only triggers on snapshots and acceptances,
 * and the CHECKs that shape a snapshot row by its result. A mocked insert
 * accepts any statement, including one the server rejects outright — which is
 * exactly the class of guarantee this file pins.
 *
 * Isolation follows the payment realdb suites: every fixture is freshly minted
 * per test under unique keys, and nothing is deleted (the snapshot tables are
 * append-only, so nothing COULD be).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import { feeSchedules, orderFeeSnapshots } from '../../schema/fees.js';
import { listings } from '../../schema/catalog.js';
import { eq } from 'drizzle-orm';
import {
  activateFeeSchedule,
  findFeeScheduleAcceptance,
  insertFeeSchedule,
  insertFeeScheduleAcceptance,
  listActiveFeeSchedules,
  retireFeeSchedule,
  type NewFeeSchedule,
} from '../feeScheduleRepository.js';
import { findOrderFeeSnapshot } from '../orderFeeSnapshotRepository.js';
import { insertVariants } from '../../catalog/variantRepository.js';
import {
  insertOrder,
  nextOrderNumber,
  type NewOrder,
  type NewOrderFeeSnapshot,
} from '../../orders/orderRepository.js';
import { planConnectedMarketplaceFee } from '../../../services/fees/order-fees.service.js';
import { findOrdersInCheckoutGroup } from '../../../services/payments/order-linkage.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * A draft version under a freshly minted key, so tests never collide.
 *
 * ALWAYS currency-scoped, and each test scopes to a currency no other suite
 * prices in: the throwaway database is shared by parallel test FILES, and an
 * unscoped ACTIVE schedule left behind here would start matching the real
 * checkouts `checkout.stripe.realdb.test.ts` runs in EUR — changing their
 * ledger assertions from another file. Scope is the isolation, not cleanup.
 */
function draft(
  eligibleCurrency: NonNullable<NewFeeSchedule['eligibleCurrency']>,
  overrides: Partial<NewFeeSchedule> = {},
): NewFeeSchedule {
  return {
    scheduleKey: `sched-${uuidv7()}`,
    version: 1,
    name: 'Test schedule',
    merchantSummary: 'A test schedule.',
    effectiveStart: new Date('2026-01-01T00:00:00Z'),
    eligibleCurrency,
    percentageBps: 1_000,
    termsVersion: 'terms-v1',
    createdByOxyUserId: 'operator-1',
    ...overrides,
  };
}

/** Seed one P2P order (with a real listing/variant) carrying `feeSnapshot`. */
async function seedOrderWithSnapshot(
  feeSnapshot: NewOrderFeeSnapshot | undefined,
  input: { totalMinor?: number; seller?: string } = {},
): Promise<{ orderId: string; checkoutGroupId: string }> {
  const totalMinor = input.totalMinor ?? 4_000;
  const seller = input.seller ?? `seller-${uuidv7()}`;
  const [listing] = await db
    .insert(listings)
    .values({ ownerType: 'user', oxyUserId: seller, title: 'Fee thing', description: '', condition: 'new', conditionAssertion: 'seller_declared' })
    .returning({ id: listings.id });
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: totalMinor,
      priceCurrency: 'EUR',
      inventoryTracked: false,
      inventoryAvailable: 0,
      position: 0,
      optionValues: [],
    },
  ]);
  const money = (amount: number) => ({
    shop: { amount, currency: 'EUR' as const },
    presentment: { amount, currency: 'EUR' as const },
  });
  const checkoutGroupId = uuidv7();
  const doc: NewOrder = {
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${uuidv7()}`,
    sellerType: 'user',
    commercialRole: 'connected_marketplace',
    sellerOxyUserId: seller,
    items: [
      {
        listingId: listing.id,
        variantId: variant.id,
        title: 'Fee thing',
        variantTitle: 'Default',
        optionValues: [],
        unitPrice: money(totalMinor),
        quantity: 1,
        lineTotal: money(totalMinor),
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
    shippingLabel: 'Standard',
    shippingCost: money(0),
    totals: {
      subtotal: money(totalMinor),
      discountTotal: money(0),
      shipping: money(0),
      tax: money(0),
      grandTotal: money(totalMinor),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    checkoutGroupId,
    statusHistory: [{ status: 'pending_payment', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
    ...(feeSnapshot ? { feeSnapshot } : {}),
  };
  const order = await insertOrder(doc);
  return { orderId: order.id, checkoutGroupId };
}

/**
 * Assert a write is refused BY POSTGRES, matching the server's own words.
 *
 * drizzle wraps the driver error in a `Failed query: …` message and keeps the
 * PostgresError as `cause`, so the trigger's RAISE text and a violated
 * constraint's name are only reachable there. Matching the top-level message
 * would pass on ANY failed insert — a vacuous assertion wearing a precise one's
 * clothes — so this digs the real text out and fails loudly when the promise
 * resolves.
 */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (err) {
    failure = err;
  }
  expect(failure, `expected a rejection matching ${String(pattern)}`).toBeDefined();
  const cause = (failure as { cause?: { message?: string; constraint_name?: string } }).cause;
  const text = [
    (failure as Error).message,
    cause?.message ?? '',
    cause?.constraint_name ?? '',
  ].join(' ');
  expect(text).toMatch(pattern);
}

/** A valid `calculated` snapshot for a 4,000 EUR single-line order. */
function calculatedSnapshot(feeMinor: number, basisMinor = 4_000): NewOrderFeeSnapshot {
  return {
    commercialMode: 'connected_marketplace',
    result: 'calculated',
    scheduleKey: 'test-key',
    scheduleVersion: 1,
    basis: 'discounted_item_subtotal',
    basisAmount: { amount: basisMinor, currency: 'EUR' },
    percentageBps: 1_000,
    fee: { amount: feeMinor, currency: 'EUR' },
    roundingAdjustmentMinor: 0,
    scopeSellerType: 'user',
    scopeCurrency: 'EUR',
    lineAllocationsMinor: [feeMinor],
  };
}

describe('fee schedule versions are immutable once active', () => {
  it('activates a draft with its audit, then refuses every economic edit', async () => {
    const row = await insertFeeSchedule(db, draft('SEK'));
    expect(row.status).toBe('draft');

    // A draft IS editable — the policy is still being written.
    await db.update(feeSchedules).set({ percentageBps: 500 }).where(eq(feeSchedules.id, row.id));

    const active = await activateFeeSchedule(db, { id: row.id, approvedByOxyUserId: 'operator-2' });
    expect(active?.status).toBe('active');
    expect(active?.approvedByOxyUserId).toBe('operator-2');
    expect(active?.activatedAt).toBeInstanceOf(Date);

    // The trigger, not the repository: a direct UPDATE of an economic column is
    // refused by the server itself.
    await expectPgRejection(db.update(feeSchedules).set({ percentageBps: 9_000 }).where(eq(feeSchedules.id, row.id)), /immutable/);
    await expectPgRejection(db.update(feeSchedules).set({ termsVersion: 'sneaky' }).where(eq(feeSchedules.id, row.id)), /immutable/);

    // …and a published version cannot be deleted at all.
    await expectPgRejection(db.delete(feeSchedules).where(eq(feeSchedules.id, row.id)), /never deleted/);
  });

  it('activating a second version supersedes the first — one active per key, enforced', async () => {
    const scheduleKey = `sched-${uuidv7()}`;
    const v1 = await insertFeeSchedule(db, draft('NOK', { scheduleKey, version: 1 }));
    await activateFeeSchedule(db, { id: v1.id, approvedByOxyUserId: 'op' });

    const v2 = await insertFeeSchedule(db, draft('NOK', { scheduleKey, version: 2, percentageBps: 500 }));
    const activated = await activateFeeSchedule(db, { id: v2.id, approvedByOxyUserId: 'op' });
    expect(activated?.status).toBe('active');

    const [v1After] = await db.select().from(feeSchedules).where(eq(feeSchedules.id, v1.id));
    expect(v1After.status).toBe('superseded');

    // The index itself: writing a second active row for the key directly is
    // refused by the server, whatever code path tries it.
    await expectPgRejection(db
        .update(feeSchedules)
        .set({ status: 'active' })
        .where(eq(feeSchedules.id, v1.id)), /fee_schedules_one_active_per_key|duplicate key/);

    // Selection reads exactly one version for the key.
    const activeNow = (await listActiveFeeSchedules(db, new Date('2026-06-01T00:00:00Z'))).filter(
      (schedule) => schedule.scheduleKey === scheduleKey,
    );
    expect(activeNow).toHaveLength(1);
    expect(activeNow[0].version).toBe(2);
  });

  it('activation is a CAS: a non-draft target reports nothing-to-do and supersedes nothing', async () => {
    const scheduleKey = `sched-${uuidv7()}`;
    const v1 = await insertFeeSchedule(db, draft('NOK', { scheduleKey, version: 1 }));
    await activateFeeSchedule(db, { id: v1.id, approvedByOxyUserId: 'op' });

    // Activating the already-active row again: no-op, and v1 is STILL active.
    expect(await activateFeeSchedule(db, { id: v1.id, approvedByOxyUserId: 'op2' })).toBeUndefined();
    const [after] = await db.select().from(feeSchedules).where(eq(feeSchedules.id, v1.id));
    expect(after.status).toBe('active');
    expect(after.approvedByOxyUserId).toBe('op');
  });

  it('retire withdraws an active version without a replacement', async () => {
    const row = await insertFeeSchedule(db, draft('SEK'));
    await activateFeeSchedule(db, { id: row.id, approvedByOxyUserId: 'op' });
    const retired = await retireFeeSchedule(db, row.id);
    expect(retired?.status).toBe('retired');
    const stillListed = await listActiveFeeSchedules(db, new Date('2026-06-01T00:00:00Z'));
    expect(stillListed.find((schedule) => schedule.id === row.id)).toBeUndefined();
  });
});

describe('acceptances are one per owner per version, append-only', () => {
  it('converges a replayed accept on the existing row', async () => {
    const scheduleKey = `sched-${uuidv7()}`;
    const ownerId = `store-${uuidv7()}`;
    const input = {
      scheduleKey,
      scheduleVersion: 1,
      termsVersion: 'terms-v1',
      ownerType: 'store' as const,
      ownerId,
      acceptedByOxyUserId: 'owner-user',
    };
    const first = await insertFeeScheduleAcceptance(db, input);
    expect(first.created).toBe(true);
    const second = await insertFeeScheduleAcceptance(db, input);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);

    const found = await findFeeScheduleAcceptance(db, {
      ownerType: 'store',
      ownerId,
      scheduleKey,
      scheduleVersion: 1,
    });
    expect(found?.id).toBe(first.row.id);
  });
});

describe('order fee snapshots persist with the order and are append-only', () => {
  it('persists a calculated snapshot, its line allocations, and refuses edits forever', async () => {
    const { orderId } = await seedOrderWithSnapshot(calculatedSnapshot(400));
    const snapshot = await findOrderFeeSnapshot(orderId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.result).toBe('calculated');
    expect(snapshot?.feeAmount).toBe(400);
    expect(snapshot?.feeCurrency).toBe('EUR');
    expect(snapshot?.lines).toHaveLength(1);
    expect(snapshot?.lines[0].amountMinor).toBe(400);

    // The append-only trigger — an UPDATE that would change a placed order's
    // fee is refused by the server, and so is a DELETE.
    await expectPgRejection(db
        .update(orderFeeSnapshots)
        .set({ feeAmount: 0 })
        .where(eq(orderFeeSnapshots.orderId, orderId)), /append-only/);
    await expectPgRejection(db.delete(orderFeeSnapshots).where(eq(orderFeeSnapshots.orderId, orderId)), /append-only/);
  });

  it('projects the snapshot fee into the payment domain through order-linkage', async () => {
    const withFee = await seedOrderWithSnapshot(calculatedSnapshot(400));
    const [linked] = await findOrdersInCheckoutGroup(withFee.checkoutGroupId);
    expect(linked.marketplaceFeePresentmentMinor).toBe(400);

    // No snapshot at all (POS / connector / pre-#88): fee zero, not an error.
    const without = await seedOrderWithSnapshot(undefined);
    const [linkedWithout] = await findOrdersInCheckoutGroup(without.checkoutGroupId);
    expect(linkedWithout.marketplaceFeePresentmentMinor).toBe(0);
  });

  it('stores mercaria_retail as an explicit not-applicable with a NULL fee', async () => {
    const { orderId } = await seedOrderWithSnapshot({
      commercialMode: 'mercaria_retail',
      result: 'not_applicable',
    });
    const snapshot = await findOrderFeeSnapshot(orderId);
    expect(snapshot?.result).toBe('not_applicable');
    // NULL, never zero: the CHECK below is what makes the distinction durable.
    expect(snapshot?.feeAmount).toBeNull();
    expect(snapshot?.scheduleKey).toBeNull();

    // …and the settlement projection deducts nothing for it.
    const [linked] = await findOrdersInCheckoutGroup(
      (await seedOrderWithSnapshot({ commercialMode: 'mercaria_retail', result: 'not_applicable' }))
        .checkoutGroupId,
    );
    expect(linked.marketplaceFeePresentmentMinor).toBe(0);
  });

  it('the CHECKs refuse the shapes the boundary forbids', async () => {
    // A mercaria_retail "zero fee" — the row rule 12 exists to prevent.
    await expectPgRejection(seedOrderWithSnapshot({
        ...calculatedSnapshot(0),
        commercialMode: 'mercaria_retail',
      }), /order_fee_snapshots_mode_result_check/);

    // A calculated result that names no schedule.
    await expectPgRejection(seedOrderWithSnapshot({
        ...calculatedSnapshot(400),
        scheduleKey: undefined,
        scheduleVersion: undefined,
      }), /order_fee_snapshots_schedule_named_check/);

    // A not-applicable row smuggling a fee amount.
    await expectPgRejection(seedOrderWithSnapshot({
        commercialMode: 'external_referral',
        result: 'not_applicable',
        fee: { amount: 100, currency: 'EUR' },
      }), /order_fee_snapshots_fee_presence_check/);

    // A fee exceeding its own basis.
    await expectPgRejection(seedOrderWithSnapshot(calculatedSnapshot(4_100)), /order_fee_snapshots_fee_within_basis_check/);
  });
});

describe('planConnectedMarketplaceFee against real schedules', () => {
  it('uses the version effective at pricing time; a later version changes only later orders', async () => {
    const scheduleKey = `sched-${uuidv7()}`;
    // Scope v1 to a currency nothing else in this suite uses, so a concurrent
    // test's schedules can never make selection ambiguous.
    const currency = 'PLN' as const;
    const v1 = await insertFeeSchedule(
      db,
      draft(currency, { scheduleKey, version: 1, percentageBps: 1_000 }),
    );
    await activateFeeSchedule(db, { id: v1.id, approvedByOxyUserId: 'op' });

    const context1 = { at: new Date(), schedules: await listActiveFeeSchedules(db, new Date()) };
    const plan1 = await planConnectedMarketplaceFee({
      context: context1,
      sellerType: 'user',
      sellerOwnerId: 'seller-x',
      currency,
      lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }],
    });
    expect(plan1.result).toBe('calculated');
    expect(plan1.scheduleVersion).toBe(1);
    expect(plan1.fee?.amount).toBe(400);

    // Publish v2 at half the rate. A NEW pricing pass selects it; the earlier
    // plan (and any order that snapshotted it) still says v1 — the snapshot is
    // data, not a reference.
    const v2 = await insertFeeSchedule(
      db,
      draft(currency, { scheduleKey, version: 2, percentageBps: 500 }),
    );
    await activateFeeSchedule(db, { id: v2.id, approvedByOxyUserId: 'op' });

    const context2 = { at: new Date(), schedules: await listActiveFeeSchedules(db, new Date()) };
    const plan2 = await planConnectedMarketplaceFee({
      context: context2,
      sellerType: 'user',
      sellerOwnerId: 'seller-x',
      currency,
      lines: [{ lineTotalMinor: 4_000, discountMinor: 0 }],
    });
    expect(plan2.scheduleVersion).toBe(2);
    expect(plan2.fee?.amount).toBe(200);
    expect(plan1.scheduleVersion).toBe(1);
    expect(plan1.fee?.amount).toBe(400);
  });

  it('stamps the seller’s accepted terms version onto the snapshot plan', async () => {
    const scheduleKey = `sched-${uuidv7()}`;
    const currency = 'DKK' as const;
    const sellerOwnerId = `seller-${uuidv7()}`;
    const row = await insertFeeSchedule(
      db,
      draft(currency, { scheduleKey, version: 1, termsVersion: 'terms-7' }),
    );
    await activateFeeSchedule(db, { id: row.id, approvedByOxyUserId: 'op' });
    await insertFeeScheduleAcceptance(db, {
      scheduleKey,
      scheduleVersion: 1,
      termsVersion: 'terms-7',
      ownerType: 'user',
      ownerId: sellerOwnerId,
      acceptedByOxyUserId: sellerOwnerId,
    });

    const context = { at: new Date(), schedules: await listActiveFeeSchedules(db, new Date()) };
    const plan = await planConnectedMarketplaceFee({
      context,
      sellerType: 'user',
      sellerOwnerId,
      currency,
      lines: [{ lineTotalMinor: 1_000, discountMinor: 0 }],
    });
    expect(plan.termsVersionAccepted).toBe('terms-7');
  });

  it('carries no buyer identity, guest token or payment-method field, in any mode', async () => {
    // The snapshot rule made checkable: whatever the mode, the plan's key set
    // contains nothing buyer-shaped. This is a vacuity-proof scan — the
    // forbidden list is asserted against a plan that HAS keys.
    const context = { at: new Date(), schedules: [] };
    const plan = await planConnectedMarketplaceFee({
      context,
      sellerType: 'user',
      sellerOwnerId: 'seller-x',
      currency: 'EUR',
      lines: [{ lineTotalMinor: 1_000, discountMinor: 0 }],
    });
    const keys = Object.keys(plan).map((key) => key.toLowerCase());
    expect(keys.length).toBeGreaterThan(5);
    const forbidden = ['buyer', 'guest', 'claim', 'email', 'phone', 'customer', 'card', 'token', 'session'];
    for (const key of keys) {
      for (const fragment of forbidden) {
        expect(key).not.toContain(fragment);
      }
    }
  });
});
