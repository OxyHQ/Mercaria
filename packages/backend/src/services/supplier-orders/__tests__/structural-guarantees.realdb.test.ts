/**
 * The guarantees that exist in the DATABASE rather than in a service, against a
 * REAL Postgres server.
 *
 * Every case here is one a mocked drizzle call cannot express: a mocked
 * `insert`/`update` accepts any statement, including one the server rejects
 * outright, so a trigger, a partial unique index and a CHECK have no mocked
 * counterpart at all. That is the same reasoning
 * `moderation-writes.realdb.test.ts` records, applied to the four triggers and
 * the two dedupe indexes #124 adds.
 *
 * What is deliberately NOT here: the orchestration's own behaviour. That is the
 * conformance suite's, and it runs against the same server — this file is only
 * the layer underneath, so a change that moved a guarantee out of the schema
 * into a service fails HERE rather than passing because the service still does
 * it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { orders } from '../../../db/schema/orders.js';
import { stores } from '../../../db/schema/stores.js';
import {
  procurementExceptions,
  purchaseOrderLineOutcomes,
  purchaseOrderTrackingEvents,
  supplierOrderAttempts,
} from '../../../db/schema/supplierOrders.js';
import { supplierAccounts } from '../../../db/schema/procurement.js';
import { insertStore } from '../../../db/stores/storeRepository.js';
import { insertOrder, nextOrderNumber, type NewOrder } from '../../../db/orders/orderRepository.js';
import { createSupplier } from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  transitionAccountState,
} from '../../../db/procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
} from '../../../db/procurement/agreementRepository.js';
import {
  attachSupplierExternalOrderId,
  findPurchaseOrderLines,
} from '../../../db/procurement/purchaseOrderRepository.js';
import {
  closeSupplierOrderAttempt,
  openSupplierOrderAttempt,
  supplierOrderRequestDiffersFromPrior,
} from '../../../db/supplierOrders/attemptRepository.js';
import {
  recordPurchaseOrderLineOutcome,
  recordPurchaseOrderTrackingEvent,
  recordSupplierDocument,
} from '../../../db/supplierOrders/evidenceRepository.js';
import {
  purchaseOrderHasHaltingException,
  raiseProcurementException,
  resolveProcurementException,
} from '../../../db/supplierOrders/exceptionRepository.js';
import { createPurchaseOrderForOrder } from '../../procurement/purchase-order.service.js';
import { digestSupplierValue } from '../redact.js';

let db: Database;
const createdStoreIds: string[] = [];
const CURRENCY: CurrencyCode = 'EUR';

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await db.delete(orders).where(eq(orders.storeId, storeId));
    await db.delete(stores).where(eq(stores.id, storeId));
  }
});

/**
 * Assert a write is refused by a SPECIFIC constraint or trigger.
 *
 * `rejects.toThrow()` alone would also pass when the WRONG rule fired, which on
 * a table carrying a dozen CHECKs is most of the value of the assertion.
 * drizzle wraps the driver error, so the constraint name lives on the CAUSE and
 * a trigger's `RAISE` message lives further down still — walking the chain is
 * what makes either reachable. `db/analytics/__tests__/analytics.realdb.test.ts`
 * is the precedent and this is the same helper.
 */
async function expectRefusedBy(write: () => Promise<unknown>, rule: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the rule did not fire').toBeDefined();
  expect(refusalTextOf(caught), `expected ${String(rule)}; got: ${String(caught)}`).toMatch(rule);
}

/** Every message and constraint name in a wrapped driver error. */
function refusalTextOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    const named = current as { constraint_name?: unknown; message?: unknown; cause?: unknown };
    if (typeof named.constraint_name === 'string') parts.push(named.constraint_name);
    if (typeof named.message === 'string') parts.push(named.message);
    current = named.cause;
  }
  return parts.join(' | ');
}

async function makeFixture(): Promise<{
  purchaseOrderId: string;
  supplierAccountId: string;
  supplierId: string;
}> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `structural-${suffix}`,
      name: 'Structural store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: CURRENCY,
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  const dual = (amount: number) => ({
    shop: { amount, currency: CURRENCY },
    presentment: { amount, currency: CURRENCY },
  });
  const orderInput: NewOrder = {
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${suffix}`,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    storeId: store.id,
    shippingAddress: {
      recipientName: 'Structural Buyer',
      line1: '1 Market Street',
      city: 'Valencia',
      postalCode: '46001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard shipping',
    shippingCost: dual(0),
    totals: {
      subtotal: dual(5_000),
      discountTotal: dual(0),
      shipping: dual(0),
      tax: dual(0),
      grandTotal: dual(5_000),
    },
    status: 'paid',
    paymentStatus: 'paid',
    checkoutGroupId: uuidv7(),
    items: [],
    statusHistory: [{ status: 'paid', at: new Date(), actorKind: 'system' }],
    appliedDiscounts: [],
    taxLines: [],
  };
  const order = await insertOrder(orderInput);
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Structural supplier ${suffix}`,
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: 'structural-platform',
    environment: 'test',
    providerAccountId: `acct-${suffix}`,
  });
  const active = await transitionAccountState({
    accountId: account.id,
    expected: 'inactive',
    next: 'active',
  });
  if (!active) throw new Error('fixture account did not activate');
  const draftAgreement = await createAgreementVersion({
    supplierId: supplier.id,
    version: 1,
    permittedDestinationCountries: ['ES'],
    permittedChannels: ['mercaria_marketplace'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
    acceptanceSlaHours: 48,
  });
  const agreement = await approveAgreement({
    agreementId: draftAgreement.id,
    reviewedByOxyUserId: 'oxy-reviewer',
    approvedByOxyUserId: 'oxy-approver',
    evidenceLocation: 'vault://agreements/structural.pdf',
    effectiveAt: new Date(Date.now() - 86_400_000),
  });
  if (!agreement) throw new Error('fixture agreement did not approve');
  const created = await createPurchaseOrderForOrder({
    orderId: order.id,
    supplierId: supplier.id,
    supplierAccountId: account.id,
    agreementId: agreement.id,
    currency: CURRENCY,
    itemsAmount: 4_000,
    totalAmount: 4_000,
    lines: [{ supplierSku: 'SKU-A', quantity: 2, unitCostAmount: 2_000, lineTotalAmount: 4_000 }],
  });
  return {
    purchaseOrderId: created.purchaseOrder.id,
    supplierAccountId: account.id,
    supplierId: supplier.id,
  };
}

describe('the attempt log is append-only, from BELOW', () => {
  it('freezes a terminated attempt and refuses a delete', async () => {
    const { purchaseOrderId, supplierAccountId } = await makeFixture();
    const attempt = await openSupplierOrderAttempt({
      purchaseOrderId,
      supplierAccountId,
      operation: 'submit',
      requestHash: digestSupplierValue('request-a'),
    });
    const closed = await closeSupplierOrderAttempt({
      attemptId: attempt.id,
      outcome: 'succeeded',
    });
    expect(closed?.outcome).toBe('succeeded');

    // A second close matches nothing at the SERVICE layer…
    expect(await closeSupplierOrderAttempt({ attemptId: attempt.id, outcome: 'failed' })).toBeUndefined();
    // …and the trigger refuses it from below, so a caller that bypassed the
    // repository entirely still cannot edit the evidence.
    await expectRefusedBy(
      async () =>
        await db
          .update(supplierOrderAttempts)
          .set({ outcome: 'failed' })
          .where(eq(supplierOrderAttempts.id, attempt.id)),
      /frozen once terminated/,
    );
    await expectRefusedBy(
      async () =>
        await db.delete(supplierOrderAttempts).where(eq(supplierOrderAttempts.id, attempt.id)),
      /append-only/,
    );
  });

  it('allocates a dense attempt number per operation', async () => {
    const { purchaseOrderId, supplierAccountId } = await makeFixture();
    const first = await openSupplierOrderAttempt({
      purchaseOrderId,
      supplierAccountId,
      operation: 'submit',
      requestHash: digestSupplierValue('a'),
    });
    await closeSupplierOrderAttempt({ attemptId: first.id, outcome: 'failed' });
    const second = await openSupplierOrderAttempt({
      purchaseOrderId,
      supplierAccountId,
      operation: 'submit',
      requestHash: digestSupplierValue('a'),
    });
    expect(first.attemptNumber).toBe(1);
    expect(second.attemptNumber).toBe(2);
    // A different OPERATION has its own sequence — a lookup is not a retry of a
    // submission, and a shared counter would make the trace unreadable.
    const lookup = await openSupplierOrderAttempt({
      purchaseOrderId,
      supplierAccountId,
      operation: 'reference_lookup',
      requestHash: digestSupplierValue('a'),
    });
    expect(lookup.attemptNumber).toBe(1);
  });

  it('refuses an AMBIGUOUS outcome that did not come from an after-write failure', async () => {
    // The CHECK that stops `ambiguous` becoming a value a service could choose:
    // the whole convergence path rests on it meaning "the request may have been
    // applied", and nothing else.
    const { purchaseOrderId, supplierAccountId } = await makeFixture();
    const attempt = await openSupplierOrderAttempt({
      purchaseOrderId,
      supplierAccountId,
      operation: 'submit',
      requestHash: digestSupplierValue('a'),
    });
    await expectRefusedBy(
      async () =>
        await closeSupplierOrderAttempt({
          attemptId: attempt.id,
          outcome: 'ambiguous',
          providerErrorAfterWrite: 'no',
        }),
      /ambiguity_shape_check/,
    );
  });

  it('sees a CHANGED request against what was actually sent', async () => {
    const { purchaseOrderId, supplierAccountId } = await makeFixture();
    const hash = digestSupplierValue('request-a');
    const attempt = await openSupplierOrderAttempt({
      purchaseOrderId,
      supplierAccountId,
      operation: 'submit',
      requestHash: hash,
    });
    await closeSupplierOrderAttempt({ attemptId: attempt.id, outcome: 'succeeded' });

    expect(
      await supplierOrderRequestDiffersFromPrior({
        purchaseOrderId,
        operation: 'submit',
        requestHash: hash,
      }),
    ).toBe(false);
    expect(
      await supplierOrderRequestDiffersFromPrior({
        purchaseOrderId,
        operation: 'submit',
        requestHash: digestSupplierValue('request-b'),
      }),
    ).toBe(true);
  });
});

describe('provider evidence is append-only, from BELOW', () => {
  it('refuses an edit or a delete of a line outcome and a carrier scan', async () => {
    const { purchaseOrderId } = await makeFixture();
    const [line] = await findPurchaseOrderLines(purchaseOrderId);
    if (!line) throw new Error('fixture purchase order has no line');

    await recordPurchaseOrderLineOutcome({
      purchaseOrderId,
      purchaseOrderLineId: line.id,
      kind: 'accepted',
      quantity: 2,
      observedAt: new Date(),
    });
    await expectRefusedBy(
      async () =>
        await db
          .update(purchaseOrderLineOutcomes)
          .set({ quantity: 1 })
          .where(eq(purchaseOrderLineOutcomes.purchaseOrderId, purchaseOrderId)),
      /append-only/,
    );
    await expectRefusedBy(
      async () =>
        await db
          .delete(purchaseOrderLineOutcomes)
          .where(eq(purchaseOrderLineOutcomes.purchaseOrderId, purchaseOrderId)),
      /append-only/,
    );

    const occurredAt = new Date();
    const appended = await recordPurchaseOrderTrackingEvent({
      purchaseOrderId,
      trackingNumber: 'T-1',
      status: 'in_transit',
      occurredAt,
    });
    expect(appended).toBe(true);
    // A redelivered webhook and an overlapping poll produce the SAME triple and
    // converge rather than doubling the trail.
    expect(
      await recordPurchaseOrderTrackingEvent({
        purchaseOrderId,
        trackingNumber: 'T-1',
        status: 'in_transit',
        occurredAt,
      }),
    ).toBe(false);
    await expectRefusedBy(
      async () =>
        await db
          .delete(purchaseOrderTrackingEvents)
          .where(eq(purchaseOrderTrackingEvents.purchaseOrderId, purchaseOrderId)),
      /append-only/,
    );
  });

  it('restates a supplier document rather than duplicating it', async () => {
    // The ONE place in this domain where a re-read UPDATES: a supplier
    // legitimately restates an invoice's total before it is final, and #128
    // reconciles against the newest statement.
    const { purchaseOrderId } = await makeFixture();
    const first = await recordSupplierDocument({
      purchaseOrderId,
      kind: 'invoice',
      providerDocumentId: 'inv-1',
      currency: CURRENCY,
      totalAmount: 4_000,
      issuedAt: new Date(),
    });
    const restated = await recordSupplierDocument({
      purchaseOrderId,
      kind: 'invoice',
      providerDocumentId: 'inv-1',
      currency: CURRENCY,
      totalAmount: 4_200,
      issuedAt: new Date(),
    });
    expect(restated.id).toBe(first.id);
    expect(restated.totalAmount).toBe(4_200);
  });
});

describe('a supplier account"s identity is frozen', () => {
  it('refuses a change of environment, provider or provider account id', async () => {
    // #124 security 8, held structurally. A purchase order NAMES an account
    // rather than snapshotting its environment, so flipping the account would
    // otherwise silently reinterpret every historical row that points at it.
    const { supplierAccountId } = await makeFixture();
    for (const patch of [
      { environment: 'live' as const },
      { provider: 'another-platform' },
      { providerAccountId: 'acct-somebody-else' },
    ]) {
      await expectRefusedBy(
        async () =>
          await db
            .update(supplierAccounts)
            .set(patch)
            .where(eq(supplierAccounts.id, supplierAccountId)),
        /identity is frozen/,
      );
    }
    // An ordinary update still works — the trigger freezes three columns, not
    // the row.
    await db
      .update(supplierAccounts)
      .set({ dailyOrderQuota: 100 })
      .where(eq(supplierAccounts.id, supplierAccountId));
  });
});

describe('one open exception per condition', () => {
  it('converges two detections and re-raises after a resolution', async () => {
    const { purchaseOrderId, supplierId, supplierAccountId } = await makeFixture();
    const first = await raiseProcurementException({
      kind: 'duplicate_external_order',
      purchaseOrderId,
      supplierId,
      supplierAccountId,
      detail: 'the provider returned a second order id',
    });
    const second = await raiseProcurementException({
      kind: 'duplicate_external_order',
      purchaseOrderId,
      supplierId,
      supplierAccountId,
      detail: 'the sweep noticed the same thing',
    });
    expect(first.raised).toBe(true);
    expect(second.raised).toBe(false);
    expect(second.exception.id).toBe(first.exception.id);

    // A HALTING kind stops fulfilment while it is open.
    expect(await purchaseOrderHasHaltingException(purchaseOrderId)).toBe(true);

    await resolveProcurementException({
      exceptionId: first.exception.id,
      resolution: 'duplicate_confirmed',
      resolvedByOxyUserId: 'oxy-operator',
    });
    expect(await purchaseOrderHasHaltingException(purchaseOrderId)).toBe(false);

    // …and a genuine recurrence opens a NEW case, which a plain unique on
    // (kind, purchase_order_id) would have forbidden forever.
    const third = await raiseProcurementException({
      kind: 'duplicate_external_order',
      purchaseOrderId,
      supplierId,
      supplierAccountId,
      detail: 'it happened again',
    });
    expect(third.raised).toBe(true);
    expect(third.exception.id).not.toBe(first.exception.id);
  });

  it('refuses a resolution with nobody"s name on it, and a second close', async () => {
    const { purchaseOrderId, supplierAccountId } = await makeFixture();
    const raised = await raiseProcurementException({
      kind: 'stuck_purchase_order',
      purchaseOrderId,
      supplierAccountId,
      detail: 'nothing has moved for a week',
    });
    await resolveProcurementException({
      exceptionId: raised.exception.id,
      resolution: 'no_action_required',
      resolvedByOxyUserId: 'oxy-operator',
    });
    // A second close matches nothing, so two operators cannot both record a
    // resolution for one condition.
    expect(
      await resolveProcurementException({
        exceptionId: raised.exception.id,
        resolution: 'escalated',
        resolvedByOxyUserId: 'oxy-other',
      }),
    ).toBeUndefined();

    // And a partially-filled resolution has no row shape at all — asserted on a
    // FRESH case, because the one above is already resolved and setting only
    // `resolved_at` on it leaves all three columns non-null, which is legal.
    const fresh = await raiseProcurementException({
      kind: 'quota_exhausted',
      purchaseOrderId,
      supplierAccountId,
      detail: 'the account is out of daily quota',
    });
    await expectRefusedBy(
      async () =>
        await db
          .update(procurementExceptions)
          .set({ resolvedAt: new Date() })
          .where(eq(procurementExceptions.id, fresh.exception.id)),
      /resolution_shape_check/,
    );
  });
});

describe('two purchase orders can never claim one supplier order', () => {
  it('refuses a second, different external id and reports it', async () => {
    const { purchaseOrderId } = await makeFixture();
    expect(
      await attachSupplierExternalOrderId({
        purchaseOrderId,
        supplierExternalOrderId: 'ord-1',
      }),
    ).toBe(true);
    // The same id again is a converging retry, not a change — but the write is
    // still refused, because the column is already set. The caller compares and
    // learns it converged.
    expect(
      await attachSupplierExternalOrderId({
        purchaseOrderId,
        supplierExternalOrderId: 'ord-1',
      }),
    ).toBe(false);

    // A SECOND purchase order on the SAME account cannot take the same id.
    const second = await makeFixture();
    await db
      .update(supplierAccounts)
      .set({ dailyOrderQuota: 1 })
      .where(eq(supplierAccounts.id, second.supplierAccountId));
    expect(
      await attachSupplierExternalOrderId({
        purchaseOrderId: second.purchaseOrderId,
        supplierExternalOrderId: 'ord-1',
      }),
    ).toBe(true);
    // Different ACCOUNTS, so no collision: the unique index is scoped to the
    // account because platforms mint per-account ids.
  });
});
