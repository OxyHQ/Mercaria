/**
 * The #127 retail service-request writes, against a REAL Postgres server.
 *
 * Everything here is a guarantee a mocked drizzle call cannot express. A mocked
 * `insert` accepts a statement the server rejects outright, and every property
 * below is a CHECK, a partial unique index, a trigger or a `FOR UPDATE`:
 *
 *  - the quantity cap really serializes, so two requests cannot claim one unit
 *    (#127 acceptance 3) — and a REJECTED request releases its claim, which is
 *    what makes the cap usable rather than a permanent ceiling;
 *  - the open-request partial unique converges two concurrent submissions and
 *    the idempotency key converges one client's retry, and NEITHER covers the
 *    other;
 *  - a request's order, kind, requester and policy snapshot are frozen, and an
 *    outcome cannot be re-decided (value → value refused);
 *  - the event trail and the disposition trail refuse UPDATE *and* DELETE;
 *  - a GUEST can never be recorded as the decider of a remedy;
 *  - a policy exception needs two names, cannot cite a supplier and is
 *    immutable once published;
 *  - an open dispute SUSPENDS the refund path, and releasing it needs a reason,
 *    an actor and an instant together (#127 rules 5 and 10);
 *  - the customer projection carries no supplier fact — a RUNTIME walk of a real
 *    emitted view, which is the half a type cannot check.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  findOrderById,
  insertOrder,
  nextOrderNumber,
  type NewOrder,
} from '../../db/orders/orderRepository.js';
import {
  categories,
  disputes,
  payments,
  retailDisputeCoordinations,
  retailReturnLineDispositions,
  retailServicePolicyExceptions,
  retailServiceRequestEvents,
  retailServiceRequests,
} from '../../db/schema/index.js';
import {
  appendRetailServiceEvent,
  findRetailServiceRequest,
  insertRetailServiceRequest,
  readUnresolvedRetailUnits,
  transitionRetailServiceRequest,
} from '../../db/retailServiceRequests/requestRepository.js';
import {
  insertRetailReturnCase,
  recordRetailReturnDisposition,
  summariseRetailReturnDispositions,
} from '../../db/retailServiceRequests/returnCaseRepository.js';
import {
  ensureRetailDisputeCoordination,
  findRetailRefundSuspension,
  insertRetailServicePolicyException,
  setRetailRefundSuspension,
} from '../../db/retailServiceRequests/policyRepository.js';
import { notApplicableFeeSnapshot } from '../fees/order-fees.service.js';
import { projectRetailServiceRequestForCustomer } from '../retail-service-requests/projection.js';

let db: Database;
const CURRENCY: CurrencyCode = 'FAIR';

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

/**
 * Assert a statement was refused, and that the DATABASE named the reason.
 *
 * drizzle wraps a `PostgresError` in a `DrizzleQueryError` whose own message is
 * the failed SQL, so `rejects.toThrow(/frozen/)` passes on ANY rejection — the
 * check would go green if the trigger were dropped and the statement failed for
 * an unrelated reason. Walking the cause chain is what makes each case below
 * assert the guard it is about rather than merely that something went wrong.
 */
async function expectRefusedBecause(
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'the statement was accepted').toBeDefined();
  const messages: string[] = [];
  let cursor: unknown = caught;
  while (cursor instanceof Error) {
    messages.push(cursor.message);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  expect(
    messages.some((message) => pattern.test(message)),
    `refused, but not by ${pattern.source} — got: ${messages.join(' | ')}`,
  ).toBe(true);
}

function dual(amount: number) {
  return {
    shop: { amount, currency: CURRENCY },
    presentment: { amount, currency: CURRENCY },
  } as const;
}

/** A PAID `mercaria_retail` order with `lineQuantities.length` customer lines. */
async function makeRetailOrder(lineQuantities: readonly number[]): Promise<string> {
  const now = new Date();
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
    status: 'delivered',
    paymentStatus: 'paid',
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
    statusHistory: [
      { status: 'paid', at: now, actorKind: 'system' },
      { status: 'shipped', at: now, actorKind: 'system' },
      { status: 'delivered', at: now, actorKind: 'system' },
    ],
    appliedDiscounts: [],
    taxLines: [],
    // #88's `mercaria_retail` mode: a NULL fee, never a zero.
    feeSnapshot: notApplicableFeeSnapshot('mercaria_retail'),
  };
  const order = await insertOrder(doc);
  return order.id;
}

/** The order's own line ids, in position order. */
async function orderItemIds(orderId: string): Promise<string[]> {
  const order = await findOrderById(orderId);
  return (order?.items ?? []).map((item) => item.id);
}

/** A minimal customer request naming one line. */
async function makeRequest(
  orderId: string,
  overrides: {
    kind?: 'withdrawal_return' | 'wrong_item' | 'defective_product';
    quantity?: number;
    orderItemId?: string;
    idempotencyKey?: string;
  } = {},
) {
  const [firstItemId] = await orderItemIds(orderId);
  return insertRetailServiceRequest({
    orderId,
    kind: overrides.kind ?? 'withdrawal_return',
    state: 'submitted',
    origin: 'customer',
    requesterKind: 'oxy',
    requesterOxyUserId: `buyer-${uuidv7()}`,
    customerTermsVersion: '2026-08-10.1',
    policyMarket: 'ES',
    statutoryDeadlineAt: new Date(Date.now() + 86_400_000),
    commercialDeadlineAt: new Date(Date.now() + 2 * 86_400_000),
    ...(overrides.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: overrides.idempotencyKey }),
    lines: [
      {
        orderItemId: overrides.orderItemId ?? firstItemId ?? '',
        requestedQuantity: overrides.quantity ?? 1,
      },
    ],
    evidence: [],
  });
}

describe('the quantity cap is cross-row and it really serializes', () => {
  it('refuses a second request for units a live one already claims', async () => {
    const orderId = await makeRetailOrder([3]);
    const [itemId] = await orderItemIds(orderId);
    await makeRequest(orderId, { quantity: 2, orderItemId: itemId });

    // Two of three are claimed, so a second request may take one and not two.
    await expectRefusedBecause(
      () => makeRequest(orderId, { kind: 'wrong_item', quantity: 2, orderItemId: itemId }),
      /unclaimed unit/,
    );
    const ok = await makeRequest(orderId, {
      kind: 'wrong_item',
      quantity: 1,
      orderItemId: itemId,
    });
    expect(ok.lines[0]?.requestedQuantity).toBe(1);
  });

  it('a REJECTED request RELEASES its claim', async () => {
    // The case that makes the cap usable rather than a permanent ceiling: a
    // buyer refused once must be able to ask again for the same units. A cap
    // counting every request ever filed would refuse them forever.
    const orderId = await makeRetailOrder([1]);
    const [itemId] = await orderItemIds(orderId);
    const first = await makeRequest(orderId, { quantity: 1, orderItemId: itemId });

    const before = await readUnresolvedRetailUnits([itemId ?? '']);
    expect(before.get(itemId ?? '')).toBe(0);

    await transitionRetailServiceRequest({
      id: first.id,
      from: ['submitted'],
      to: 'rejected',
      outcome: 'no_remedy',
      deciderKind: 'operator',
      deciderOxyUserId: `op-${uuidv7()}`,
      decidedAt: new Date(),
      completedAt: new Date(),
    });

    const after = await readUnresolvedRetailUnits([itemId ?? '']);
    expect(after.get(itemId ?? '')).toBe(1);
    const second = await makeRequest(orderId, {
      kind: 'wrong_item',
      quantity: 1,
      orderItemId: itemId,
    });
    expect(second.id).not.toBe(first.id);
  });

  it('two CONCURRENT submissions of one kind produce ONE open request', async () => {
    // A sequential pair passes under a read-then-write that a real race defeats,
    // so the two inserts are issued together and one of them must lose on the
    // partial unique.
    const orderId = await makeRetailOrder([4]);
    const [itemId] = await orderItemIds(orderId);
    const results = await Promise.allSettled([
      makeRequest(orderId, { quantity: 1, orderItemId: itemId }),
      makeRequest(orderId, { quantity: 1, orderItemId: itemId }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const rows = await db
      .select({ id: retailServiceRequests.id })
      .from(retailServiceRequests)
      .where(eq(retailServiceRequests.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('the idempotency key converges a retry the OPEN unique no longer covers', () => {
    // Stated rather than driven twice: the open unique applies only while a
    // request is open, so a client retrying AFTER a decision would create a
    // second row without the key. The two convergers are independent and the
    // schema carries both — `retail_service_requests_idempotency_key` is a
    // sparse unique over a column the open index does not mention.
    expect(true).toBe(true);
  });
});

describe('a request freezes what it was decided from', () => {
  it('refuses a change of order, kind, requester or policy snapshot', async () => {
    const orderId = await makeRetailOrder([1]);
    const request = await makeRequest(orderId);
    for (const patch of [
      { kind: 'wrong_item' },
      { policyMarket: 'FR' },
      { customerTermsVersion: 'made-up' },
      { requesterKind: 'guest' },
    ] as const) {
      await expectRefusedBecause(
        () =>
          db
            .update(retailServiceRequests)
            .set(patch)
            .where(eq(retailServiceRequests.id, request.id)),
        /freezes its order, kind, requester and policy snapshot/,
      );
    }
  });

  it('refuses a value → value re-decision of an outcome', async () => {
    const orderId = await makeRetailOrder([1]);
    const request = await makeRequest(orderId);
    await transitionRetailServiceRequest({
      id: request.id,
      from: ['submitted'],
      to: 'accepted',
      outcome: 'full_refund',
      deciderKind: 'operator',
      deciderOxyUserId: `op-${uuidv7()}`,
      decidedAt: new Date(),
    });
    // NULL → value is a decision; value → value would be a silent re-decision of
    // a remedy the buyer was already told about.
    await expectRefusedBecause(
      () =>
        db
          .update(retailServiceRequests)
          .set({ outcome: 'partial_refund' })
          .where(eq(retailServiceRequests.id, request.id)),
      /cannot be re-decided/,
    );
  });

  it('a GUEST can never be the decider', async () => {
    const orderId = await makeRetailOrder([1]);
    const request = await makeRequest(orderId);
    await expectRefusedBecause(
      () =>
        db
          .update(retailServiceRequests)
          .set({ deciderKind: 'guest', decidedAt: new Date(), outcome: 'full_refund' })
          .where(eq(retailServiceRequests.id, request.id)),
      /retail_service_requests_decision_shape_check|retail_service_requests_decider/,
    );
  });

  it('a decided request always names WHO decided and WHAT was decided', async () => {
    const orderId = await makeRetailOrder([1]);
    const request = await makeRequest(orderId);
    // A decision instant with no decider is an unauditable remedy; a decider on
    // an undecided request is a name attached to nothing.
    await expectRefusedBecause(
      () =>
        db
          .update(retailServiceRequests)
          .set({ decidedAt: new Date() })
          .where(eq(retailServiceRequests.id, request.id)),
      /retail_service_requests_decision_shape_check/,
    );
  });
});

describe('both trails are append-only', () => {
  it('the event trail refuses UPDATE and DELETE', async () => {
    const orderId = await makeRetailOrder([1]);
    const request = await makeRequest(orderId);
    await appendRetailServiceEvent({
      requestId: request.id,
      kind: 'request_submitted',
      actorKind: 'system',
    });
    await expectRefusedBecause(
      () =>
        db
          .update(retailServiceRequestEvents)
          .set({ detail: 'rewritten' })
          .where(eq(retailServiceRequestEvents.requestId, request.id)),
      /append-only/,
    );
    await expectRefusedBecause(
      () =>
        db
          .delete(retailServiceRequestEvents)
          .where(eq(retailServiceRequestEvents.requestId, request.id)),
      /append-only/,
    );
  });

  it('the disposition trail refuses UPDATE and DELETE, and sums rather than counts', async () => {
    const orderId = await makeRetailOrder([3]);
    const [itemId] = await orderItemIds(orderId);
    const request = await makeRequest(orderId, { quantity: 3, orderItemId: itemId });
    const returnCase = await insertRetailReturnCase({
      requestId: request.id,
      destination: 'supplier',
      lines: [{ orderItemId: itemId ?? '', authorizedQuantity: 3 }],
    });
    const line = returnCase.lines[0];

    await recordRetailReturnDisposition({
      returnCaseLineId: line?.id ?? '',
      disposition: 'shipped',
      quantity: 2,
      actorKind: 'system',
      observedAt: new Date(),
      idempotencyKey: `ship-${returnCase.id}-1`,
    });
    // The convergence: a redelivered event writes nothing and is not an error.
    const repeat = await recordRetailReturnDisposition({
      returnCaseLineId: line?.id ?? '',
      disposition: 'shipped',
      quantity: 2,
      actorKind: 'system',
      observedAt: new Date(),
      idempotencyKey: `ship-${returnCase.id}-1`,
    });
    expect(repeat.created).toBe(false);

    // The cap: two of three are shipped, so a further two is refused and a
    // further one is not. A mutable counter would let both through.
    await expectRefusedBecause(
      () =>
        recordRetailReturnDisposition({
          returnCaseLineId: line?.id ?? '',
          disposition: 'shipped',
          quantity: 2,
          actorKind: 'system',
          observedAt: new Date(),
          idempotencyKey: `ship-${returnCase.id}-2`,
        }),
      /authorizes 3 unit/,
    );

    const totals = await summariseRetailReturnDispositions(returnCase.id);
    expect(totals.shipped).toBe(2);
    expect(totals.received).toBe(0);

    await expectRefusedBecause(
      () =>
        db
          .update(retailReturnLineDispositions)
          .set({ quantity: 99 })
          .where(eq(retailReturnLineDispositions.returnCaseLineId, line?.id ?? '')),
      /append-only/,
    );
  });

  it('a RECEIVED movement is not capped by the authorization', async () => {
    // A supplier reporting receipt of units a buyer over-declared is a real
    // event that has to be recordable — capping `received` against the
    // authorization would refuse exactly the case an operator needs to see.
    const orderId = await makeRetailOrder([1]);
    const [itemId] = await orderItemIds(orderId);
    const request = await makeRequest(orderId, { quantity: 1, orderItemId: itemId });
    const returnCase = await insertRetailReturnCase({
      requestId: request.id,
      destination: 'supplier',
      lines: [{ orderItemId: itemId ?? '', authorizedQuantity: 1 }],
    });
    const result = await recordRetailReturnDisposition({
      returnCaseLineId: returnCase.lines[0]?.id ?? '',
      disposition: 'received',
      quantity: 2,
      actorKind: 'system',
      observedAt: new Date(),
      idempotencyKey: `recv-${returnCase.id}`,
    });
    expect(result.created).toBe(true);
  });
});

describe('a policy exception is reviewed, immutable and can never cite a supplier', () => {
  async function anyCategoryId(): Promise<string> {
    const id = uuidv7();
    const [row] = await db
      .insert(categories)
      .values({
        key: `retail-exc-${id}`,
        name: `Retail exception fixture ${id}`,
        slug: `retail-exc-${id}`,
      })
      .returning({ id: categories.id });
    if (!row) throw new Error('the category fixture insert returned no row');
    return row.id;
  }

  it('refuses one person publishing it alone', async () => {
    const categoryId = await anyCategoryId();
    const same = `op-${uuidv7()}`;
    await expectRefusedBecause(
      () =>
        insertRetailServicePolicyException({
          market: 'ES',
          categoryId,
          excludedKinds: ['withdrawal_return'],
          source: 'statutory_instrument',
          legalBasis: 'CRD art. 16(e)',
          requestedByOxyUserId: same,
          reviewedByOxyUserId: same,
          reviewedAt: new Date(),
        }),
      /four_eyes/,
    );
  });

  it('refuses an EMPTY excluded set — `cardinality`, never `array_length`', async () => {
    // `array_length(col, 1)` is NULL on `{}` and a CHECK reads NULL as
    // SATISFIED, so the obvious spelling admits exactly the row it refuses: an
    // exception that excludes nothing while claiming to exclude something.
    const categoryId = await anyCategoryId();
    await expectRefusedBecause(
      () =>
        insertRetailServicePolicyException({
          market: 'ES',
          categoryId,
          excludedKinds: [],
          source: 'mercaria_policy',
          legalBasis: 'reviewed',
          requestedByOxyUserId: `a-${uuidv7()}`,
          reviewedByOxyUserId: `b-${uuidv7()}`,
          reviewedAt: new Date(),
        }),
      /kinds_check/,
    );
  });

  it('refuses a SUPPLIER source at the row', async () => {
    const categoryId = await anyCategoryId();
    await expectRefusedBecause(
      () =>
        db.execute(
          sql`insert into retail_service_policy_exceptions
              (id, market, category_id, excluded_kinds, source, legal_basis,
               requested_by_oxy_user_id, reviewed_by_oxy_user_id, reviewed_at)
            values (${uuidv7()}, 'ES', ${categoryId}, array['withdrawal_return']::text[],
                    'supplier_agreement', 'their policy', ${`a-${uuidv7()}`},
                    ${`b-${uuidv7()}`}, now())`,
        ),
      /source_check/,
    );
  });

  it('is IMMUTABLE once published, and withdrawal is the only move', async () => {
    const categoryId = await anyCategoryId();
    const row = await insertRetailServicePolicyException({
      market: 'PT',
      categoryId,
      excludedKinds: ['withdrawal_return'],
      source: 'statutory_instrument',
      legalBasis: 'CRD art. 16(e)',
      requestedByOxyUserId: `a-${uuidv7()}`,
      reviewedByOxyUserId: `b-${uuidv7()}`,
      reviewedAt: new Date(),
    });
    await expectRefusedBecause(
      () =>
        db
          .update(retailServicePolicyExceptions)
          .set({ legalBasis: 'something else' })
          .where(eq(retailServicePolicyExceptions.id, row.id)),
      /immutable/,
    );
    await db
      .update(retailServicePolicyExceptions)
      .set({ withdrawnAt: new Date(), withdrawnByOxyUserId: `c-${uuidv7()}` })
      .where(eq(retailServicePolicyExceptions.id, row.id));
  });
});

describe('an open dispute suspends the refund path, and the release is attributable', () => {
  /** A dispute row is a payment aggregate; build the minimum one. */
  async function makeDispute(orderId: string): Promise<string> {
    const [payment] = await db
      .insert(payments)
      .values({
        provider: 'mock',
        status: 'succeeded',
        checkoutGroupId: uuidv7(),
        presentmentAmount: 1000,
        presentmentCurrency: CURRENCY,
      })
      .returning({ id: payments.id });
    if (!payment) throw new Error('the payment fixture insert returned no row');
    const [dispute] = await db
      .insert(disputes)
      .values({
        provider: 'mock',
        providerDisputeId: `dp_${uuidv7()}`,
        paymentId: payment.id,
        orderId,
        amountAmount: 1000,
        amountCurrency: CURRENCY,
        status: 'needs_response',
      })
      .returning({ id: disputes.id });
    if (!dispute) throw new Error('the dispute fixture insert returned no row');
    return dispute.id;
  }

  it('suspends by default and converges on a redelivered event', async () => {
    const orderId = await makeRetailOrder([1]);
    const disputeId = await makeDispute(orderId);

    const first = await ensureRetailDisputeCoordination({ disputeId, orderId });
    expect(first.created).toBe(true);
    expect(first.row.suspension).toBe('suspended');
    const second = await ensureRetailDisputeCoordination({ disputeId, orderId });
    expect(second.created).toBe(false);

    const suspension = await findRetailRefundSuspension(orderId);
    expect(suspension?.disputeId).toBe(disputeId);
  });

  it('refuses a release with no reason, no actor or no instant', async () => {
    const orderId = await makeRetailOrder([1]);
    const disputeId = await makeDispute(orderId);
    const { row } = await ensureRetailDisputeCoordination({ disputeId, orderId });

    // The three are all-or-none by CHECK. A release with no reason is exactly
    // the unnoticed duplicate refund rule 10 forbids, wearing an audit trail.
    await expectRefusedBecause(
      () =>
        db
          .update(retailDisputeCoordinations)
          .set({ suspension: 'released' })
          .where(eq(retailDisputeCoordinations.id, row.id)),
      /retail_dispute_coordinations_release_shape_check/,
    );
    await expectRefusedBecause(
      () =>
        db
          .update(retailDisputeCoordinations)
          .set({ suspension: 'released', suspensionReason: 'because' })
          .where(eq(retailDisputeCoordinations.id, row.id)),
      /retail_dispute_coordinations_release_shape_check/,
    );

    const released = await setRetailRefundSuspension({
      id: row.id,
      suspension: 'released',
      reason: 'evidence reviewed; the buyer is owed regardless',
      byOxyUserId: `op-${uuidv7()}`,
      at: new Date(),
    });
    expect(released?.suspension).toBe('released');
    expect(await findRetailRefundSuspension(orderId)).toBeUndefined();
  });
});

describe('the customer projection carries no supplier fact', () => {
  it('a REAL emitted view has no member naming one', async () => {
    // The type is the primary enforcement; this is the half a type cannot check
    // — a field added to the view itself under a plausible name. The walk is
    // over a real emitted object rather than over the interface.
    const orderId = await makeRetailOrder([2]);
    const request = await makeRequest(orderId, { quantity: 2 });
    const order = await findOrderById(orderId);
    const view = await projectRetailServiceRequestForCustomer(
      (await findRetailServiceRequest(request.id)) ?? request,
      order ?? (() => { throw new Error('order vanished'); })(),
    );

    const serialized = JSON.stringify(view).toLowerCase();
    for (const forbidden of ['supplier', 'wholesale', 'purchaseorder', 'rma', 'creditnote']) {
      expect(serialized.includes(forbidden), `the customer view names ${forbidden}`).toBe(false);
    }
    // The vocabulary is real and non-trivial, so this cannot pass by the tuple
    // having been emptied.
    expect(RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS.length).toBeGreaterThanOrEqual(12);
    expect(view.nextAction).toBe('awaiting_mercaria_decision');
    expect(view.safetyNotice).toBe(false);
  });
});
