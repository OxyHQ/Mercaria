/**
 * The #126 retail-fulfilment writes, against a REAL Postgres server.
 *
 * Everything here is a guarantee a mocked drizzle call cannot express. A mocked
 * `insert` accepts a statement the server rejects outright, and every one of
 * the properties below is a CHECK, a partial unique index, a trigger or a
 * `FOR UPDATE` — none of which exists without a server:
 *
 *  - the over-allocation guard really serializes, so two concurrent split
 *    dispatches against one customer line produce one winner rather than two
 *    (#126 fulfilment mapping 8);
 *  - a REPLACEMENT allocation is outside that cap, and a CANCELLED intent
 *    releases its claim — the two cases that make the cap usable rather than a
 *    permanent ceiling;
 *  - the reconciliation reader reports the LOST half as well as the duplicate
 *    half, which a reader built on an inner join cannot;
 *  - the chosen mode and the Moovo transport are write-once, and the
 *    contractual half of an intent is frozen;
 *  - the role snapshot and the promise trail refuse UPDATE, and refuse DELETE
 *    while their order exists;
 *  - an unknown estimate has nowhere to store a window (#126 rule 10) and a
 *    supplier cannot author the accepted promise (#126 rule 5);
 *  - an inbound source reference resolves to exactly one intent and to nothing
 *    else (#126 privacy 9);
 *  - the seven state axes derive from real rows without borrowing each other's
 *    evidence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  findOrderById,
  insertOrder,
  nextOrderNumber,
  type NewOrder,
} from '../../db/orders/orderRepository.js';
import {
  retailFulfilmentIntents,
  retailOrderRoleSnapshots,
  retailDeliveryPromises,
  supplierAccounts,
  supplierAgreements,
  suppliers,
  retailProcurementIntents,
} from '../../db/schema/index.js';
import {
  RetailAllocationExceedsOrderedQuantity,
  attachMoovoTransport,
  chooseRetailFulfilmentMode,
  findRetailFulfilmentIntentBySourceReference,
  findRetailOrderRoleSnapshot,
  insertRetailDeliveryPromise,
  insertRetailFulfilmentIntents,
  insertRetailOrderRoleSnapshot,
  listOrderItemIdsInPosition,
  listRetailFulfilmentIntents,
  readRetailLineAllocationReconciliation,
  setRetailFulfilmentIntentStatus,
} from '../../db/retailFulfilment/retailFulfilmentRepository.js';
import { notApplicableFeeSnapshot } from '../fees/order-fees.service.js';
import { readRetailDeliveryPromiseView } from '../retail-fulfilment/delivery-promise.service.js';
import { deriveRetailFulfilmentStates } from '../retail-fulfilment/state-separation.js';

let db: Database;
const CURRENCY: CurrencyCode = 'FAIR';

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

function dual(amount: number) {
  return {
    shop: { amount, currency: CURRENCY },
    presentment: { amount, currency: CURRENCY },
  } as const;
}

/** A `mercaria_retail` order with `lineQuantities.length` customer lines. */
async function makeRetailOrder(lineQuantities: readonly number[]): Promise<string> {
  const doc: NewOrder = {
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${uuidv7()}`,
    // ADR 0004 D1's biconditional: a `platform` order carries neither owner.
    sellerType: 'platform',
    commercialRole: 'mercaria_retail',
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
      subtotal: dual(1000),
      discountTotal: dual(0),
      shipping: dual(0),
      tax: dual(0),
      grandTotal: dual(1000),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    checkoutGroupId: uuidv7(),
    items: lineQuantities.map((quantity, index) => ({
      listingId: `listing-${uuidv7()}`,
      variantId: `variant-${uuidv7()}`,
      title: `Retail line ${index}`,
      variantTitle: 'Default Title',
      optionValues: [],
      unitPrice: dual(500),
      quantity,
      lineTotal: dual(500 * quantity),
    })),
    statusHistory: [{ status: 'pending_payment', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
    // #88's `mercaria_retail` mode: a NULL fee, never a zero.
    feeSnapshot: notApplicableFeeSnapshot('mercaria_retail'),
  };
  const order = await insertOrder(doc);
  return order.id;
}

/** A supplier, an account, an approved agreement and one procurement intent. */
async function makeProcurementIntent(
  orderId: string,
  options: { moovoLabelDispatchPermitted?: boolean; dropshipRightsGranted?: boolean } = {},
): Promise<{ procurementIntentId: string; agreementId: string; supplierId: string }> {
  const [supplier] = await db
    .insert(suppliers)
    .values({ supplierType: 'wholesaler', canonicalName: `Supplier ${uuidv7()}` })
    .returning({ id: suppliers.id });
  if (!supplier) throw new Error('supplier insert returned no row');

  const [account] = await db
    .insert(supplierAccounts)
    .values({
      supplierId: supplier.id,
      provider: 'fixture',
      environment: 'test',
      providerAccountId: `acct-${uuidv7()}`,
    })
    .returning({ id: supplierAccounts.id });
  if (!account) throw new Error('supplier account insert returned no row');

  const operator = `operator-${uuidv7()}`;
  const [agreement] = await db
    .insert(supplierAgreements)
    .values({
      supplierId: supplier.id,
      version: 1,
      approvalState: 'approved',
      effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
      dropshipRightsGranted: options.dropshipRightsGranted ?? true,
      moovoLabelDispatchPermitted: options.moovoLabelDispatchPermitted ?? false,
      dataProcessingTermsAccepted: true,
      evidenceLocation: 'vault://fixture',
      reviewedByOxyUserId: operator,
      approvedAt: new Date('2026-01-02T00:00:00.000Z'),
      approvedByOxyUserId: operator,
    })
    .returning({ id: supplierAgreements.id });
  if (!agreement) throw new Error('agreement insert returned no row');

  const [intent] = await db
    .insert(retailProcurementIntents)
    .values({
      orderId,
      checkoutGroupId: uuidv7(),
      supplierId: supplier.id,
      supplierAccountId: account.id,
      agreementId: agreement.id,
      supplierCostAmount: 800,
      supplierCostCurrency: CURRENCY,
      buyerLockedTotalAmount: 1000,
      buyerLockedTotalCurrency: CURRENCY,
    })
    .returning({ id: retailProcurementIntents.id });
  if (!intent) throw new Error('procurement intent insert returned no row');

  return {
    procurementIntentId: intent.id,
    agreementId: agreement.id,
    supplierId: supplier.id,
  };
}

/**
 * Assert a statement is refused by a NAMED constraint.
 *
 * postgres.js puts the driver error under `cause` and the thrown message is a
 * generic "Failed query: …", so `rejects.toThrow(/name/)` passes on ANY failure
 * — a typo in a column, a missing fixture, a dropped connection. That is the
 * vacuous shape this repository refuses; reading `constraint_name` off the
 * driver error is what makes a case pass only when the constraint it names is
 * the one that fired. Borrowed verbatim from `guest-portal.realdb.test.ts`.
 */
async function expectConstraintViolation(
  run: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected ${constraintName} to refuse the statement`).toBeDefined();
  const cause = (raised as { cause?: { constraint_name?: string } }).cause;
  const named = cause?.constraint_name ?? (raised as { constraint_name?: string }).constraint_name;
  expect(named).toBe(constraintName);
}

/**
 * Assert a statement is refused by a TRIGGER, whose message is the only handle
 * it has — a trigger raises a plain exception with no constraint name.
 */
async function expectTriggerRefusal(run: () => Promise<unknown>, match: RegExp): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected a trigger matching ${String(match)} to refuse the statement`).toBeDefined();
  const cause = (raised as { cause?: { message?: string } }).cause;
  const message = cause?.message ?? (raised as { message?: string }).message ?? '';
  expect(message).toMatch(match);
}

describe('the line-allocation cap', () => {
  it('refuses an allocation that would exceed the ordered quantity', async () => {
    const orderId = await makeRetailOrder([3]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const first = await makeProcurementIntent(orderId);
    const second = await makeProcurementIntent(orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');

    await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: first.procurementIntentId,
          permittedFulfilmentMode: 'supplier_controlled',
          allocations: [{ orderItemId: itemId, quantity: 2 }],
        },
      ]),
    );

    await expect(
      db.transaction(async (tx) =>
        insertRetailFulfilmentIntents(tx, [
          {
            orderId,
            procurementIntentId: second.procurementIntentId,
            permittedFulfilmentMode: 'supplier_controlled',
            allocations: [{ orderItemId: itemId, quantity: 2 }],
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(RetailAllocationExceedsOrderedQuantity);
  });

  it('lets exactly ONE of two INTERLEAVED allocations win', async () => {
    // The property `FOR UPDATE` exists for, and it needs a BARRIER rather than
    // two promises started together: `Promise.allSettled` over two transactions
    // does not reliably interleave them, so the naive version passes with the
    // lock REMOVED — measured, on this file, before this rewrite. That is the
    // vacuous shape this repository refuses, so the overlap is forced here.
    //
    // A inserts and then HOLDS its transaction open. B then starts, and its
    // read of the same order item must block on A's lock; when A commits, B
    // sees the committed allocation and refuses. Without the lock B reads the
    // pre-insert sum of zero, finds room for the whole line, and one customer
    // line is fulfilled twice — a total that looks correct to every later
    // reader.
    const orderId = await makeRetailOrder([2]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const first = await makeProcurementIntent(orderId);
    const second = await makeProcurementIntent(orderId);

    let signalInserted: () => void = () => undefined;
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const attempt = (procurementIntentId: string, hold: boolean) =>
      db.transaction(async (tx) => {
        const rows = await insertRetailFulfilmentIntents(tx, [
          {
            orderId,
            procurementIntentId,
            permittedFulfilmentMode: 'supplier_controlled',
            allocations: [{ orderItemId: itemId, quantity: 2 }],
          },
        ]);
        if (hold) {
          signalInserted();
          await held;
        }
        return rows;
      });

    const a = attempt(first.procurementIntentId, true);
    await inserted;
    const b = attempt(second.procurementIntentId, false);
    // Give B time to reach the lock before A commits. If it has not yet, the
    // test is no weaker — B then reads AFTER the commit and refuses anyway.
    setTimeout(releaseFirst, 250);

    const outcomes = await Promise.allSettled([a, b]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const reconciliation = await readRetailLineAllocationReconciliation(orderId);
    expect(reconciliation).toEqual([{ orderItemId: itemId, ordered: 2, allocated: 2 }]);
  });

  it('refuses two intents in ONE batch that together over-allocate', async () => {
    // Each is individually correct against the committed sum; only accumulating
    // the batch's own requests catches it. A per-intent check would write both.
    const orderId = await makeRetailOrder([2]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const first = await makeProcurementIntent(orderId);
    const second = await makeProcurementIntent(orderId);

    await expect(
      db.transaction(async (tx) =>
        insertRetailFulfilmentIntents(tx, [
          {
            orderId,
            procurementIntentId: first.procurementIntentId,
            permittedFulfilmentMode: 'supplier_controlled',
            allocations: [{ orderItemId: itemId, quantity: 2 }],
          },
          {
            orderId,
            procurementIntentId: second.procurementIntentId,
            permittedFulfilmentMode: 'supplier_controlled',
            allocations: [{ orderItemId: itemId, quantity: 1 }],
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(RetailAllocationExceedsOrderedQuantity);

    expect(await listRetailFulfilmentIntents(orderId)).toHaveLength(0);
  });

  it('lets a REPLACEMENT re-ship units the cap already counts', async () => {
    const orderId = await makeRetailOrder([1]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const procurement = await makeProcurementIntent(orderId);

    const [original] = await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: procurement.procurementIntentId,
          permittedFulfilmentMode: 'supplier_controlled',
          allocations: [{ orderItemId: itemId, quantity: 1 }],
        },
      ]),
    );
    if (!original) throw new Error('the original intent was not written');

    // A parcel was lost. The replacement re-ships the SAME unit, so counting it
    // toward the cap would refuse it — and raising the cap to admit it would
    // make a genuine double-ship invisible.
    const [replacement] = await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: procurement.procurementIntentId,
          permittedFulfilmentMode: 'supplier_controlled',
          supersedesIntentId: original.id,
          allocations: [{ orderItemId: itemId, quantity: 1 }],
        },
      ]),
    );
    expect(replacement?.intentKind).toBe('replacement');

    const reconciliation = await readRetailLineAllocationReconciliation(orderId);
    expect(reconciliation).toEqual([{ orderItemId: itemId, ordered: 1, allocated: 1 }]);
  });

  it('releases a cancelled intent’s claim, so the line can be re-allocated', async () => {
    const orderId = await makeRetailOrder([1]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const first = await makeProcurementIntent(orderId);
    const second = await makeProcurementIntent(orderId);

    const [original] = await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: first.procurementIntentId,
          permittedFulfilmentMode: 'supplier_controlled',
          allocations: [{ orderItemId: itemId, quantity: 1 }],
        },
      ]),
    );
    if (!original) throw new Error('the original intent was not written');

    await setRetailFulfilmentIntentStatus({
      id: original.id,
      status: 'cancelled',
      reason: 'supplier could not source it',
    });

    // Re-sourcing from a different supplier must now be possible. If a
    // cancelled intent kept its claim, a buyer whose first supplier failed
    // could never be fulfilled at all.
    await expect(
      db.transaction(async (tx) =>
        insertRetailFulfilmentIntents(tx, [
          {
            orderId,
            procurementIntentId: second.procurementIntentId,
            permittedFulfilmentMode: 'supplier_controlled',
            allocations: [{ orderItemId: itemId, quantity: 1 }],
          },
        ]),
      ),
    ).resolves.toHaveLength(1);
  });

  it('reports a line with NO allocation, which an inner join could not', async () => {
    const orderId = await makeRetailOrder([2, 3]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const [firstItem, secondItem] = items;
    if (!firstItem || !secondItem) throw new Error('the fixture order has too few items');
    const procurement = await makeProcurementIntent(orderId);

    await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: procurement.procurementIntentId,
          permittedFulfilmentMode: 'supplier_controlled',
          allocations: [{ orderItemId: firstItem.id, quantity: 2 }],
        },
      ]),
    );

    const reconciliation = await readRetailLineAllocationReconciliation(orderId);
    expect(reconciliation).toEqual([
      { orderItemId: firstItem.id, ordered: 2, allocated: 2 },
      // The LOST half of #126 mapping 8: a line nobody is fulfilling, visible
      // as a shortfall rather than absent from the report entirely.
      { orderItemId: secondItem.id, ordered: 3, allocated: 0 },
    ]);
  });
});

describe('the fulfilment intent’s immutable half', () => {
  async function makeIntent(permitted: 'either' | 'supplier_controlled' = 'either') {
    const orderId = await makeRetailOrder([1]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const procurement = await makeProcurementIntent(orderId);
    const [intent] = await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: procurement.procurementIntentId,
          permittedFulfilmentMode: permitted,
          allocations: [{ orderItemId: itemId, quantity: 1 }],
        },
      ]),
    );
    if (!intent) throw new Error('the intent was not written');
    return { orderId, intent };
  }

  it('mints a deterministic source reference from the row id', async () => {
    const { intent } = await makeIntent();
    expect(intent.moovoSourceReference).toBe(`mercaria:retail-fulfilment:${intent.id}`);
  });

  it('resolves an inbound source reference to exactly one intent, and nothing else', async () => {
    const { intent } = await makeIntent();
    const other = await makeIntent();
    const found = await findRetailFulfilmentIntentBySourceReference(intent.moovoSourceReference);
    expect(found?.id).toBe(intent.id);
    expect(found?.id).not.toBe(other.intent.id);

    // #126 privacy 9. A reference Mercaria did not mint reaches nothing —
    // there is no prefix match and no fallback to a list.
    expect(await findRetailFulfilmentIntentBySourceReference('mercaria:retail-fulfilment:')).toBe(
      undefined,
    );
    expect(await findRetailFulfilmentIntentBySourceReference('anything-else')).toBe(undefined);
  });

  it('writes the chosen mode ONCE and refuses a second value', async () => {
    const { intent } = await makeIntent();
    expect((await chooseRetailFulfilmentMode({ id: intent.id, mode: 'supplier_controlled' }))?.fulfilmentMode)
      .toBe('supplier_controlled');
    // The CAS answers `undefined`, and the trigger refuses even a direct write.
    expect(await chooseRetailFulfilmentMode({ id: intent.id, mode: 'moovo_controlled' })).toBe(
      undefined,
    );
    await expectTriggerRefusal(
      () =>
        db
          .update(retailFulfilmentIntents)
          .set({ fulfilmentMode: 'moovo_controlled' })
          .where(eq(retailFulfilmentIntents.id, intent.id)),
      /write-once/,
    );
  });

  it('refuses a mode the agreement did not permit', async () => {
    const { intent } = await makeIntent('supplier_controlled');
    await expectConstraintViolation(
      () =>
        db
          .update(retailFulfilmentIntents)
          .set({ fulfilmentMode: 'moovo_controlled' })
          .where(eq(retailFulfilmentIntents.id, intent.id)),
      'retail_fulfilment_intents_mode_permitted_check',
    );
  });

  it('attaches a Moovo transport ONCE, and only after a mode is chosen', async () => {
    const { intent } = await makeIntent();
    // The shape CHECK: a transport reference with no mode says a transport
    // exists and not what kind, which have opposite operator remedies.
    await expectConstraintViolation(
      () =>
        attachMoovoTransport({
          id: intent.id,
          transportRequestId: 'mvo-1',
          registeredAt: new Date(),
        }),
      'retail_fulfilment_intents_moovo_shape_check',
    );

    await chooseRetailFulfilmentMode({ id: intent.id, mode: 'supplier_controlled' });
    expect(
      (
        await attachMoovoTransport({
          id: intent.id,
          transportRequestId: 'mvo-1',
          registeredAt: new Date(),
        })
      )?.moovoTransportRequestId,
    ).toBe('mvo-1');
    expect(
      await attachMoovoTransport({
        id: intent.id,
        transportRequestId: 'mvo-2',
        registeredAt: new Date(),
      }),
    ).toBe(undefined);
    await expectTriggerRefusal(
      () =>
        db
          .update(retailFulfilmentIntents)
          .set({ moovoTransportRequestId: 'mvo-2' })
          .where(eq(retailFulfilmentIntents.id, intent.id)),
      /write-once/,
    );
  });

  it('freezes the contractual half', async () => {
    const { intent } = await makeIntent();
    await expectTriggerRefusal(
      () =>
        db
          .update(retailFulfilmentIntents)
          .set({ permittedFulfilmentMode: 'moovo_controlled' })
          .where(eq(retailFulfilmentIntents.id, intent.id)),
      /frozen/,
    );
  });

  it('permits only ONE original intent per procurement intent', async () => {
    const orderId = await makeRetailOrder([2]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const procurement = await makeProcurementIntent(orderId);
    const write = () =>
      db.transaction(async (tx) =>
        insertRetailFulfilmentIntents(tx, [
          {
            orderId,
            procurementIntentId: procurement.procurementIntentId,
            permittedFulfilmentMode: 'supplier_controlled',
            allocations: [{ orderItemId: itemId, quantity: 1 }],
          },
        ]),
      );
    await write();
    await expectConstraintViolation(write, 'retail_fulfilment_intents_procurement_original_key');
  });
});

describe('the order-role snapshot', () => {
  async function makeSnapshot() {
    const orderId = await makeRetailOrder([1]);
    const snapshot = await insertRetailOrderRoleSnapshot(db, {
      orderId,
      sellerLegalEntityName: 'Mercaria SL',
      sellerLegalEntityCountry: 'ES',
      supplierFulfilmentDisclosureKey: 'retail.supplier_fulfilled.v1',
      supplierFulfilmentDisclosureVersion: 1,
      customerTermsVersion: '2026-08-10.1',
      cancellationWindowHours: 24,
      withdrawalWindowDays: 14,
      returnWindowDays: 30,
      warrantyMonths: 36,
    });
    return { orderId, snapshot };
  }

  it('is readable back and names Mercaria as seller of record', async () => {
    const { orderId } = await makeSnapshot();
    const stored = await findRetailOrderRoleSnapshot(orderId);
    expect(stored?.sellerOfRecord).toBe('mercaria');
    expect(stored?.withdrawalWindowDays).toBe(14);
    expect(stored?.warrantyMonths).toBe(36);
  });

  it('refuses UPDATE outright', async () => {
    const { snapshot } = await makeSnapshot();
    await expectTriggerRefusal(
      () =>
        db
          .update(retailOrderRoleSnapshots)
          .set({ returnWindowDays: 7 })
          .where(eq(retailOrderRoleSnapshots.id, snapshot.id)),
      /immutable/,
    );
  });

  it('refuses DELETE while the order exists', async () => {
    const { snapshot } = await makeSnapshot();
    await expectTriggerRefusal(
      () => db.delete(retailOrderRoleSnapshots).where(eq(retailOrderRoleSnapshots.id, snapshot.id)),
      /cannot be deleted while order/,
    );
  });

  it('refuses a zero withdrawal window — a statutory right recorded as absent', async () => {
    const orderId = await makeRetailOrder([1]);
    await expectConstraintViolation(
      () =>
        insertRetailOrderRoleSnapshot(db, {
          orderId,
          sellerLegalEntityName: 'Mercaria SL',
          sellerLegalEntityCountry: 'ES',
          supplierFulfilmentDisclosureKey: 'retail.supplier_fulfilled.v1',
          supplierFulfilmentDisclosureVersion: 1,
          customerTermsVersion: '2026-08-10.1',
          cancellationWindowHours: 24,
          withdrawalWindowDays: 0,
          returnWindowDays: 30,
          warrantyMonths: 36,
        }),
      'retail_order_role_snapshots_windows_check',
    );
  });

  it('refuses an empty selling entity, which is what an unconfigured deployment writes', async () => {
    const orderId = await makeRetailOrder([1]);
    await expectConstraintViolation(
      () =>
        insertRetailOrderRoleSnapshot(db, {
          orderId,
          sellerLegalEntityName: '   ',
          sellerLegalEntityCountry: 'ES',
          supplierFulfilmentDisclosureKey: 'retail.supplier_fulfilled.v1',
          supplierFulfilmentDisclosureVersion: 1,
          customerTermsVersion: '2026-08-10.1',
          cancellationWindowHours: 24,
          withdrawalWindowDays: 14,
          returnWindowDays: 30,
          warrantyMonths: 36,
        }),
      'retail_order_role_snapshots_entity_check',
    );
  });
});

describe('the delivery-promise trail', () => {
  const PLACED = new Date('2026-08-10T10:00:00.000Z');

  it('keeps accepted and current separate, and marks a stale estimate', async () => {
    const orderId = await makeRetailOrder([1]);
    await insertRetailDeliveryPromise(db, {
      orderId,
      promiseKind: 'accepted_at_checkout',
      source: 'mercaria_checkout',
      outcome: 'observed',
      basis: 'guaranteed',
      latestAt: new Date('2026-08-17T10:00:00.000Z'),
      observedAt: PLACED,
    });
    await insertRetailDeliveryPromise(db, {
      orderId,
      promiseKind: 'supplier_dispatch',
      source: 'supplier_adapter',
      outcome: 'observed',
      basis: 'advisory',
      latestAt: new Date('2026-08-20T10:00:00.000Z'),
      observedAt: new Date('2026-08-11T10:00:00.000Z'),
    });

    const view = await readRetailDeliveryPromiseView(
      orderId,
      new Date('2026-08-12T10:00:00.000Z'),
    );
    expect(view.accepted).toMatchObject({ basis: 'guaranteed', kind: 'accepted_at_checkout' });
    // The current estimate is LATER than the promise and is reported as its own
    // value — a surface showing only one of them would tell a buyer either that
    // nothing changed or that they were always promised the 20th.
    expect(view.current).toMatchObject({ basis: 'advisory', kind: 'supplier_dispatch' });
    expect(view.current?.latestAt).toBe('2026-08-20T10:00:00.000Z');
    expect(view.current?.stale).toBe(true);
  });

  it('reports a refresh failure beside the estimate it could not renew', async () => {
    const orderId = await makeRetailOrder([1]);
    await insertRetailDeliveryPromise(db, {
      orderId,
      promiseKind: 'logistics_estimate',
      source: 'moovo_logistics',
      outcome: 'observed',
      basis: 'advisory',
      latestAt: new Date('2026-08-18T10:00:00.000Z'),
      observedAt: PLACED,
    });
    await insertRetailDeliveryPromise(db, {
      orderId,
      promiseKind: 'logistics_estimate',
      source: 'moovo_logistics',
      outcome: 'refresh_failed',
      failureReason: 'provider_unreachable',
      observedAt: new Date('2026-08-11T10:00:00.000Z'),
    });

    const view = await readRetailDeliveryPromiseView(orderId, new Date('2026-08-11T11:00:00.000Z'));
    // Both. A view showing only the newest OBSERVED estimate would be silently
    // confident about a figure whose refresh has been failing.
    expect(view.current?.latestAt).toBe('2026-08-18T10:00:00.000Z');
    expect(view.lastRefreshFailure).toEqual({
      reason: 'provider_unreachable',
      observedAt: '2026-08-11T10:00:00.000Z',
    });
  });

  it('gives an unknown estimate nowhere to store a window (#126 rule 10)', async () => {
    const orderId = await makeRetailOrder([1]);
    await expectConstraintViolation(
      () =>
        insertRetailDeliveryPromise(db, {
          orderId,
          promiseKind: 'logistics_estimate',
          source: 'moovo_logistics',
          outcome: 'unknown',
          latestAt: new Date('2026-08-18T10:00:00.000Z'),
          observedAt: PLACED,
        }),
      'retail_delivery_promises_observed_shape_check',
    );
  });

  it('refuses a supplier-authored accepted promise (#126 rule 5)', async () => {
    const orderId = await makeRetailOrder([1]);
    await expectConstraintViolation(
      () =>
        insertRetailDeliveryPromise(db, {
          orderId,
          promiseKind: 'accepted_at_checkout',
          source: 'supplier_adapter',
          outcome: 'observed',
          basis: 'guaranteed',
          latestAt: new Date('2026-08-18T10:00:00.000Z'),
          observedAt: PLACED,
        }),
      'retail_delivery_promises_accepted_shape_check',
    );
  });

  it('permits exactly one accepted promise per order', async () => {
    const orderId = await makeRetailOrder([1]);
    const write = () =>
      insertRetailDeliveryPromise(db, {
        orderId,
        promiseKind: 'accepted_at_checkout',
        source: 'mercaria_checkout',
        outcome: 'observed',
        basis: 'guaranteed',
        latestAt: new Date('2026-08-18T10:00:00.000Z'),
        observedAt: PLACED,
      });
    await write();
    await expectConstraintViolation(write, 'retail_delivery_promises_accepted_key');
  });

  it('is append-only', async () => {
    const orderId = await makeRetailOrder([1]);
    const row = await insertRetailDeliveryPromise(db, {
      orderId,
      promiseKind: 'accepted_at_checkout',
      source: 'mercaria_checkout',
      outcome: 'observed',
      basis: 'guaranteed',
      latestAt: new Date('2026-08-18T10:00:00.000Z'),
      observedAt: PLACED,
    });
    await expectTriggerRefusal(
      () =>
        db
          .update(retailDeliveryPromises)
          .set({ latestAt: new Date('2026-09-01T10:00:00.000Z') })
          .where(eq(retailDeliveryPromises.id, row.id)),
      /append-only/,
    );
  });
});

describe('the seven state axes, from real rows', () => {
  it('reads each axis from its own evidence and leaves the rest unknown', async () => {
    const orderId = await makeRetailOrder([1]);
    const items = await listOrderItemIdsInPosition(db, orderId);
    const itemId = items[0]?.id;
    if (!itemId) throw new Error('the fixture order has no items');
    const procurement = await makeProcurementIntent(orderId);
    const [intent] = await db.transaction(async (tx) =>
      insertRetailFulfilmentIntents(tx, [
        {
          orderId,
          procurementIntentId: procurement.procurementIntentId,
          permittedFulfilmentMode: 'supplier_controlled',
          allocations: [{ orderItemId: itemId, quantity: 1 }],
        },
      ]),
    );
    if (!intent) throw new Error('the intent was not written');

    const order = await findOrderById(orderId);
    if (!order) throw new Error('the fixture order disappeared');

    const view = deriveRetailFulfilmentStates({
      orderStatus: order.status,
      orderPaymentStatus: order.paymentStatus,
      // A supplier has ACCEPTED. The transport axis must stay unknown: #126
      // state-separation example 1, driven from rows rather than fixtures.
      procurementStatus: 'accepted',
      preparationStatus: intent.status,
      now: new Date(),
    });
    expect(view.supplier_procurement).toMatchObject({ known: true, state: 'accepted' });
    expect(view.preparation_fulfilment).toMatchObject({ known: true, state: 'planned' });
    expect(view.transport_projection.known).toBe(false);
    expect(view.return_transport.known).toBe(false);
    expect(view.refund_reconciliation.known).toBe(false);
  });
});
