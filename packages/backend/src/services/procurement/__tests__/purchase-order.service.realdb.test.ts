/**
 * The purchase-order lifecycle against a REAL Postgres database and a REAL
 * customer order — the seam, the state machine, the separate cancellation
 * events and the two projections.
 *
 * What only this file covers:
 *
 *  - creation goes through the order-linkage seam and snapshots the REDACTED
 *    destination off the real order row;
 *  - the agreement gates fail closed BEFORE any write (destination outside
 *    scope; rights not granted — #118 acceptance 3 and 6);
 *  - customer cancellation and supplier cancellation are SEPARATE recorded
 *    events converging through `cancel_requested` (#118 consistency rule 8);
 *  - the customer-facing and operator projections carry exactly what their
 *    audiences may see (#118 consistency rules 9 and 10).
 */

import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { orders } from '../../../db/schema/orders.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { insertStore } from '../../../db/stores/storeRepository.js';
import {
  insertOrder,
  nextOrderNumber,
  type NewOrder,
} from '../../../db/orders/orderRepository.js';
import { createSupplier } from '../../../db/procurement/supplierRepository.js';
import {
  createSupplierAccount,
  transitionAccountState,
} from '../../../db/procurement/supplierAccountRepository.js';
import {
  approveAgreement,
  createAgreementVersion,
  type NewAgreementVersion,
} from '../../../db/procurement/agreementRepository.js';
import {
  findPurchaseOrderById,
  findPurchaseOrderShipments,
  findPurchaseOrderTransitions,
} from '../../../db/procurement/purchaseOrderRepository.js';
import { mergeSuppliers } from '../supplier.service.js';
import {
  applySupplierAcceptance,
  applySupplierCancellationConfirmed,
  applySupplierCancellationDeclined,
  applySupplierRejection,
  assertLegalPurchaseOrderTransition,
  createPurchaseOrderForOrder,
  derivePurchaseOrderIdempotencyKey,
  expirePurchaseOrder,
  markPurchaseOrderDelivered,
  projectPurchaseOrderFulfilment,
  projectPurchaseOrderOperatorView,
  recordSupplierShipment,
  requestPurchaseOrderCancellation,
  submitPurchaseOrder,
  type PurchaseOrderDraftInput,
} from '../purchase-order.service.js';

let db: Database;

const CURRENCY: CurrencyCode = 'EUR';

/** Store ids created by a test, dropped after it so the shared database stays clean. */
const createdStoreIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await db.delete(orders).where(eq(orders.storeId, storeId));
    await deleteTestStores(db, [storeId]);
  }
});

/** A `DualMoney` where shop == presentment (a same-currency order). */
function dual(amount: number) {
  return {
    shop: { amount, currency: CURRENCY },
    presentment: { amount, currency: CURRENCY },
  } as const;
}

/** A real customer order shipping to ES, minimal but complete. */
async function makeOrder(): Promise<string> {
  const suffix = uuidv7();
  const store = await insertStore(
    {
      handle: `procurement-${suffix}`,
      name: 'Procurement store',
      description: '',
      brandColor: '#123456',
      defaultCurrency: CURRENCY,
    },
    [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
  );
  createdStoreIds.push(store.id);
  const input: NewOrder = {
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${suffix}`,
    sellerType: 'store',
    commercialRole: 'connected_marketplace',
    storeId: store.id,
    shippingAddress: {
      recipientName: 'Retail Buyer',
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
  const order = await insertOrder(input);
  return order.id;
}

/** The whole supply side: supplier, active account, approved agreement. */
async function makeSupplySide(agreementOverrides: Partial<NewAgreementVersion> = {}) {
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `PO supplier ${uuidv7()}`,
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: 'test-platform',
    environment: 'test',
    providerAccountId: `acct-${uuidv7()}`,
  });
  const active = await transitionAccountState({
    accountId: account.id,
    expected: 'inactive',
    next: 'active',
  });
  if (!active) throw new Error('fixture account did not activate');
  const draft = await createAgreementVersion({
    supplierId: supplier.id,
    version: 1,
    permittedDestinationCountries: ['ES'],
    permittedChannels: ['mercaria_marketplace'],
    resaleRightsGranted: true,
    dropshipRightsGranted: true,
    blindDropshipVerified: true,
    dataProcessingTermsAccepted: true,
    acceptanceSlaHours: 48,
    ...agreementOverrides,
  });
  const agreement = await approveAgreement({
    agreementId: draft.id,
    reviewedByOxyUserId: 'oxy-reviewer',
    approvedByOxyUserId: 'oxy-approver',
    evidenceLocation: 'vault://agreements/po.pdf',
    effectiveAt: new Date(Date.now() - 86_400_000),
  });
  if (!agreement) throw new Error('fixture agreement did not approve');
  return { supplier, account: active, agreement };
}

function draftInput(
  orderId: string,
  ids: { supplierId: string; supplierAccountId: string; agreementId: string },
): PurchaseOrderDraftInput {
  return {
    orderId,
    ...ids,
    currency: CURRENCY,
    itemsAmount: 4_000,
    shippingAmount: 400,
    totalAmount: 4_400,
    lines: [
      { supplierSku: 'SKU-A', quantity: 2, unitCostAmount: 2_000, lineTotalAmount: 4_000 },
    ],
  };
}

describe('creation through the seam', () => {
  it('snapshots the redacted destination off the REAL order and converges on retry', async () => {
    const orderId = await makeOrder();
    const { supplier, account, agreement } = await makeSupplySide();
    const input = draftInput(orderId, {
      supplierId: supplier.id,
      supplierAccountId: account.id,
      agreementId: agreement.id,
    });

    const first = await createPurchaseOrderForOrder(input);
    expect(first.created).toBe(true);
    expect(first.purchaseOrder.status).toBe('draft');
    expect(first.purchaseOrder.idempotencyKey).toBe(
      derivePurchaseOrderIdempotencyKey(orderId, supplier.id),
    );
    // The destination came off the order's shipping snapshot, redacted by shape.
    expect(first.purchaseOrder.destinationRecipientName).toBe('Retail Buyer');
    expect(first.purchaseOrder.destinationCountry).toBe('ES');

    // One customer order, one supplier, ONE purchase order — however often the
    // orchestrator retries.
    const second = await createPurchaseOrderForOrder(input);
    expect(second.created).toBe(false);
    expect(second.purchaseOrder.id).toBe(first.purchaseOrder.id);
  });

  it('fails closed when the agreement does not permit the order destination', async () => {
    const orderId = await makeOrder();
    const { supplier, account, agreement } = await makeSupplySide({
      permittedDestinationCountries: ['FR'],
    });
    await expect(
      createPurchaseOrderForOrder(
        draftInput(orderId, {
          supplierId: supplier.id,
          supplierAccountId: account.id,
          agreementId: agreement.id,
        }),
      ),
    ).rejects.toThrow(/does not permit destination ES/);
  });

  it('fails closed when the agreement does not grant retail dropship (#118 acceptance 3)', async () => {
    const orderId = await makeOrder();
    const { supplier, account, agreement } = await makeSupplySide({
      // A catalog-only agreement: real, approved — and NOT a dropship grant.
      dropshipRightsGranted: false,
    });
    await expect(
      createPurchaseOrderForOrder(
        draftInput(orderId, {
          supplierId: supplier.id,
          supplierAccountId: account.id,
          agreementId: agreement.id,
        }),
      ),
    ).rejects.toThrow(/does not grant retail dropship/);
  });
});

describe('the lifecycle, end to end', () => {
  it('submit → accept → ship (split) → deliver, with the SLA deadline stamped', async () => {
    const orderId = await makeOrder();
    const supply = await makeSupplySide();
    const { purchaseOrder } = await createPurchaseOrderForOrder(
      draftInput(orderId, {
        supplierId: supply.supplier.id,
        supplierAccountId: supply.account.id,
        agreementId: supply.agreement.id,
      }),
    );

    const submittedAt = new Date();
    const submitted = await submitPurchaseOrder(purchaseOrder.id, submittedAt);
    expect(submitted?.status).toBe('submitted');
    expect(submitted?.submissionAttempts).toBe(1);
    // The acceptance deadline is the agreement's SLA, snapshotted (48h).
    expect(submitted?.acceptanceDeadlineAt?.getTime()).toBe(
      submittedAt.getTime() + 48 * 3_600_000,
    );

    const accepted = await applySupplierAcceptance({
      purchaseOrderId: purchaseOrder.id,
      supplierExternalOrderId: `EXT-${uuidv7()}`,
    });
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.supplierExternalOrderId).toMatch(/^EXT-/);

    // Two parcels: the first moves the machine, the second only adds tracking.
    await recordSupplierShipment({
      purchaseOrderId: purchaseOrder.id,
      trackingNumber: 'TRACK-1',
      carrier: 'correos',
    });
    await recordSupplierShipment({
      purchaseOrderId: purchaseOrder.id,
      trackingNumber: 'TRACK-2',
    });
    const shipments = await findPurchaseOrderShipments(purchaseOrder.id);
    expect(shipments.map((shipment) => shipment.trackingNumber)).toEqual(['TRACK-1', 'TRACK-2']);

    const delivered = await markPurchaseOrderDelivered(purchaseOrder.id);
    expect(delivered?.status).toBe('delivered');

    // The customer-facing view, at the end: delivered, both parcels — and
    // structurally nothing else.
    const view = projectPurchaseOrderFulfilment(delivered ?? purchaseOrder, shipments);
    expect(view).toEqual({ state: 'delivered', trackingNumbers: ['TRACK-1', 'TRACK-2'] });
    expect(Object.keys(view).sort()).toEqual(['state', 'trackingNumbers']);
  });

  it('a rejection carries its NORMALIZED reason, and an expiry its timeout code', async () => {
    const orderId = await makeOrder();
    const supply = await makeSupplySide();
    const supplyIds = {
      supplierId: supply.supplier.id,
      supplierAccountId: supply.account.id,
      agreementId: supply.agreement.id,
    };
    const { purchaseOrder } = await createPurchaseOrderForOrder(draftInput(orderId, supplyIds));
    await submitPurchaseOrder(purchaseOrder.id);
    const rejected = await applySupplierRejection({
      purchaseOrderId: purchaseOrder.id,
      reasonCode: 'out_of_stock',
      supplierNote: 'Item discontinued by manufacturer',
    });
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.reasonCode).toBe('out_of_stock');

    // A rejected PO reads as `cancelled` to the customer — never as a supplier
    // detail (#118 consistency rule 9).
    expect(projectPurchaseOrderFulfilment(rejected ?? purchaseOrder, []).state).toBe('cancelled');

    // And an expiry on a SECOND order records the timeout code.
    const secondOrderId = await makeOrder();
    const second = await createPurchaseOrderForOrder(draftInput(secondOrderId, supplyIds));
    await submitPurchaseOrder(second.purchaseOrder.id);
    const expired = await expirePurchaseOrder(second.purchaseOrder.id);
    expect(expired?.status).toBe('expired');
    expect(expired?.reasonCode).toBe('acceptance_timeout');
  });

  it('refuses illegal edges as data, not as review', () => {
    expect(() => assertLegalPurchaseOrderTransition('delivered', 'submitted')).toThrow(
      /not a legal edge/,
    );
    expect(() => assertLegalPurchaseOrderTransition('draft', 'accepted')).toThrow(/not a legal edge/);
    expect(() => assertLegalPurchaseOrderTransition('rejected', 'accepted')).toThrow(
      /not a legal edge/,
    );
  });
});

describe('customer and supplier cancellation are SEPARATE events (#118 rule 8)', () => {
  it('customer asks, supplier confirms — two initiators in the trail', async () => {
    const orderId = await makeOrder();
    const supply = await makeSupplySide();
    const { purchaseOrder } = await createPurchaseOrderForOrder(
      draftInput(orderId, {
        supplierId: supply.supplier.id,
        supplierAccountId: supply.account.id,
        agreementId: supply.agreement.id,
      }),
    );
    await submitPurchaseOrder(purchaseOrder.id);

    const requested = await requestPurchaseOrderCancellation({
      purchaseOrderId: purchaseOrder.id,
      initiator: 'customer',
      byOxyUserId: 'oxy-buyer',
    });
    expect(requested?.status).toBe('cancel_requested');

    const cancelled = await applySupplierCancellationConfirmed({
      purchaseOrderId: purchaseOrder.id,
    });
    expect(cancelled?.status).toBe('cancelled');

    const trail = await findPurchaseOrderTransitions(purchaseOrder.id);
    const ask = trail.find((event) => event.status === 'cancel_requested');
    const confirm = trail.find((event) => event.status === 'cancelled');
    // WHO asked and WHO answered are structurally distinct rows.
    expect(ask?.initiator).toBe('customer');
    expect(ask?.reasonCode).toBe('customer_cancelled');
    expect(confirm?.initiator).toBe('supplier');
  });

  it('the supplier may DECLINE — too late, back to accepted, RMA path (#127)', async () => {
    const orderId = await makeOrder();
    const supply = await makeSupplySide();
    const { purchaseOrder } = await createPurchaseOrderForOrder(
      draftInput(orderId, {
        supplierId: supply.supplier.id,
        supplierAccountId: supply.account.id,
        agreementId: supply.agreement.id,
      }),
    );
    await submitPurchaseOrder(purchaseOrder.id);
    await applySupplierAcceptance({ purchaseOrderId: purchaseOrder.id });
    await requestPurchaseOrderCancellation({
      purchaseOrderId: purchaseOrder.id,
      initiator: 'customer',
    });

    const declined = await applySupplierCancellationDeclined({
      purchaseOrderId: purchaseOrder.id,
      supplierNote: 'Already handed to carrier',
    });
    expect(declined?.status).toBe('accepted');
  });
});

describe('merges cannot rewrite historical POs (#118 rule 6, at the service grain)', () => {
  it('a merged supplier’s PO keeps naming the tombstone', async () => {
    const orderId = await makeOrder();
    const supply = await makeSupplySide();
    const { purchaseOrder } = await createPurchaseOrderForOrder(
      draftInput(orderId, {
        supplierId: supply.supplier.id,
        supplierAccountId: supply.account.id,
        agreementId: supply.agreement.id,
      }),
    );

    const winner = await createSupplier({
      supplierType: 'wholesaler',
      canonicalName: `Winner ${uuidv7()}`,
    });
    const merged = await mergeSuppliers({
      winnerId: winner.id,
      loserId: supply.supplier.id,
    });
    expect(merged?.winnerId).toBe(winner.id);

    const po = await findPurchaseOrderById(purchaseOrder.id);
    expect(po?.supplierId).toBe(supply.supplier.id);
  });
});

describe('the operator projection isolates what it must (#118 rule 10)', () => {
  it('carries the PO’s own money and refs, and NO credential or destination copy', async () => {
    const orderId = await makeOrder();
    const supply = await makeSupplySide();
    const { purchaseOrder } = await createPurchaseOrderForOrder(
      draftInput(orderId, {
        supplierId: supply.supplier.id,
        supplierAccountId: supply.account.id,
        agreementId: supply.agreement.id,
      }),
    );
    const view = projectPurchaseOrderOperatorView(purchaseOrder);

    expect(view.totalAmount).toBe(4_400);
    expect(view.supplierAccountId).toBe(supply.account.id);

    const keys = Object.keys(view);
    expect(keys).not.toContain('credentialReference');
    // The destination snapshot is fulfilment data, not operator-queue data —
    // an operator who needs it opts into the row explicitly.
    expect(keys.filter((key) => key.startsWith('destination'))).toEqual([]);
  });
});
