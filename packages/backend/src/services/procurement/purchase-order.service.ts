/**
 * The purchase-order lifecycle: creation from a customer order, the ADR 0004
 * D9.2 state machine, and the two projections that cross toward other
 * audiences.
 *
 * ## What this service deliberately does NOT do
 *
 * It never touches an order's status, a payment, the ledger or inventory.
 * Supplier acceptance is a PROCUREMENT fact — the order moving to `processing`
 * on all-POs-accepted is #124's orchestration, driven from the outbox, and
 * payment truth stays webhook-driven in its own domain (#118 consistency
 * rules 4–5). Nothing in `services/procurement/` imports
 * `services/payments/`, and a static test pins that.
 *
 * ## Idempotency
 *
 * `derivePurchaseOrderIdempotencyKey` is ADR 0004 D4 step 4's deterministic id
 * (`po:<orderId>:<supplierId>`) — one PO per supplier per customer order, and
 * every replay converges on it through the repository's claim.
 */

import type {
  CurrencyCode,
  PurchaseOrderFulfilmentState,
  PurchaseOrderFulfilmentView,
  PurchaseOrderReasonCode,
  PurchaseOrderStatus,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import {
  findAgreementById,
  type SupplierAgreementRecord,
} from '../../db/procurement/agreementRepository.js';
import { findSupplierAccountById } from '../../db/procurement/supplierAccountRepository.js';
import {
  createPurchaseOrder,
  findPurchaseOrderById,
  recordPurchaseOrderShipment,
  transitionPurchaseOrder,
  type CreatePurchaseOrderResult,
  type NewPurchaseOrderLine,
  type PurchaseOrderRecord,
  type PurchaseOrderShipmentRecord,
} from '../../db/procurement/purchaseOrderRepository.js';
import {
  agreementGrantsRetailDropship,
  agreementPermitsDestination,
  isAgreementActive,
} from './agreement-scope.js';
import { findProcurementLinkedOrder } from './order-linkage.js';

/**
 * The legal edges of the PO machine — ADR 0004 D9.2's diagram as data.
 * Terminal states map to the empty list.
 */
export const PURCHASE_ORDER_LEGAL_TRANSITIONS: Readonly<
  Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]>
> = {
  draft: ['submitted'],
  submitted: ['accepted', 'rejected', 'expired', 'cancel_requested'],
  accepted: ['shipped', 'cancel_requested'],
  cancel_requested: ['cancelled', 'accepted'],
  shipped: ['delivered'],
  delivered: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

/** Throw on an edge the machine does not have. */
export function assertLegalPurchaseOrderTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): void {
  if (!PURCHASE_ORDER_LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`purchase order transition ${from} -> ${to} is not a legal edge (ADR 0004 D9.2)`);
  }
}

/** ADR 0004 D4 step 4: the deterministic per-(order, supplier) key. */
export function derivePurchaseOrderIdempotencyKey(orderId: string, supplierId: string): string {
  return `po:${orderId}:${supplierId}`;
}

/** One supplier split of one customer order — what #124's orchestration hands over. */
export interface PurchaseOrderDraftInput {
  orderId: string;
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  currency: CurrencyCode;
  itemsAmount: number;
  shippingAmount?: number;
  taxAmount?: number;
  dutyAmount?: number;
  totalAmount: number;
  quoteRef?: string;
  lines: NewPurchaseOrderLine[];
}

/**
 * Create the DRAFT purchase order for one supplier's share of a customer
 * order — idempotently, so the caller may retry forever.
 *
 * Fails closed BEFORE any write when the supply side is not in order: the
 * account must belong to the supplier, the agreement must belong to the
 * supplier, be in active scope, grant retail dropship, and permit the order's
 * destination country. The destination snapshot comes from the order-linkage
 * seam — the fulfilment-only projection, never the order row.
 */
export async function createPurchaseOrderForOrder(
  input: PurchaseOrderDraftInput,
): Promise<CreatePurchaseOrderResult> {
  for (const [name, amount] of [
    ['itemsAmount', input.itemsAmount],
    ['shippingAmount', input.shippingAmount ?? 0],
    ['taxAmount', input.taxAmount ?? 0],
    ['dutyAmount', input.dutyAmount ?? 0],
    ['totalAmount', input.totalAmount],
  ] as const) {
    assertSafeMoneyAmount(amount, `purchase order ${name}`);
  }
  for (const line of input.lines) {
    assertSafeMoneyAmount(line.unitCostAmount, 'purchase order line unit cost');
    assertSafeMoneyAmount(line.lineTotalAmount, 'purchase order line total');
  }

  const order = await findProcurementLinkedOrder(input.orderId);
  if (!order) {
    throw new Error(`createPurchaseOrderForOrder: order ${input.orderId} not found`);
  }

  const account = await findSupplierAccountById(input.supplierAccountId);
  if (!account || account.supplierId !== input.supplierId) {
    throw new Error(
      'createPurchaseOrderForOrder refuses a supplier/account mismatch: the account does not ' +
        'belong to the supplier this purchase order names',
    );
  }
  if (account.state !== 'active') {
    throw new Error('createPurchaseOrderForOrder refuses an inactive or kill-switched account');
  }

  const agreement = await requireGoverningAgreement(input.agreementId, input.supplierId);
  if (!agreementPermitsDestination(agreement, order.destination.country)) {
    throw new Error(
      `createPurchaseOrderForOrder: agreement ${agreement.id} does not permit destination ` +
        `${order.destination.country} — no retail eligibility outside the active scope`,
    );
  }

  return await createPurchaseOrder({
    supplierId: input.supplierId,
    supplierAccountId: input.supplierAccountId,
    agreementId: input.agreementId,
    orderId: order.id,
    ...(order.checkoutGroupId ? { checkoutGroupId: order.checkoutGroupId } : {}),
    idempotencyKey: derivePurchaseOrderIdempotencyKey(order.id, input.supplierId),
    currency: input.currency,
    itemsAmount: input.itemsAmount,
    ...(input.shippingAmount !== undefined ? { shippingAmount: input.shippingAmount } : {}),
    ...(input.taxAmount !== undefined ? { taxAmount: input.taxAmount } : {}),
    ...(input.dutyAmount !== undefined ? { dutyAmount: input.dutyAmount } : {}),
    totalAmount: input.totalAmount,
    destination: order.destination,
    ...(input.quoteRef ? { quoteRef: input.quoteRef } : {}),
    lines: input.lines,
  });
}

/** The active-scope + rights gate `createPurchaseOrderForOrder` runs. */
async function requireGoverningAgreement(
  agreementId: string,
  supplierId: string,
  at: Date = new Date(),
): Promise<SupplierAgreementRecord> {
  const agreement = await findAgreementById(agreementId);
  if (!agreement || agreement.supplierId !== supplierId) {
    throw new Error(
      'createPurchaseOrderForOrder refuses a supplier/agreement mismatch: the agreement was ' +
        'not signed by the supplier this purchase order names',
    );
  }
  if (!isAgreementActive(agreement, at)) {
    throw new Error(
      `createPurchaseOrderForOrder: agreement ${agreementId} is not in active scope — ` +
        'unapproved, not yet effective, or expired',
    );
  }
  if (!agreementGrantsRetailDropship(agreement)) {
    throw new Error(
      `createPurchaseOrderForOrder: agreement ${agreementId} does not grant retail dropship ` +
        '(resale + dropship + verified blind fulfilment + data-processing terms)',
    );
  }
  return agreement;
}

/**
 * Submit the draft to the supplier's rail: `draft → submitted`, stamping the
 * acceptance deadline from the governing agreement's SLA (ADR 0004 concern 5)
 * and counting the attempt. Returns `undefined` when the draft is gone — the
 * caller lost a race or is replaying, and the trail says which.
 */
export async function submitPurchaseOrder(
  purchaseOrderId: string,
  at: Date = new Date(),
): Promise<PurchaseOrderRecord | undefined> {
  const po = await findPurchaseOrderById(purchaseOrderId);
  if (!po) return undefined;
  if (po.status !== 'draft') return undefined;
  assertLegalPurchaseOrderTransition('draft', 'submitted');
  const agreement = await findAgreementById(po.agreementId);
  const slaHours = agreement?.acceptanceSlaHours ?? 48;
  return await transitionPurchaseOrder({
    purchaseOrderId,
    expected: 'draft',
    next: 'submitted',
    initiator: 'system',
    at,
    patch: {
      submittedAt: at,
      acceptanceDeadlineAt: new Date(at.getTime() + slaHours * 3_600_000),
      incrementSubmissionAttempts: true,
      lastSubmissionError: null,
    },
  });
}

/** The supplier accepted — a PROCUREMENT fact only; nothing here marks anything paid. */
export async function applySupplierAcceptance(input: {
  purchaseOrderId: string;
  supplierExternalOrderId?: string;
  allocatedAt?: Date;
  supplierNote?: string;
  at?: Date;
}): Promise<PurchaseOrderRecord | undefined> {
  const at = input.at ?? new Date();
  assertLegalPurchaseOrderTransition('submitted', 'accepted');
  return await transitionPurchaseOrder({
    purchaseOrderId: input.purchaseOrderId,
    expected: 'submitted',
    next: 'accepted',
    initiator: 'supplier',
    ...(input.supplierNote ? { supplierNote: input.supplierNote } : {}),
    at,
    patch: {
      acceptedAt: at,
      ...(input.supplierExternalOrderId
        ? { supplierExternalOrderId: input.supplierExternalOrderId }
        : {}),
      ...(input.allocatedAt ? { allocatedAt: input.allocatedAt } : {}),
    },
  });
}

/** The supplier refused — with a NORMALIZED reason, never just their prose. */
export async function applySupplierRejection(input: {
  purchaseOrderId: string;
  reasonCode: PurchaseOrderReasonCode;
  supplierNote?: string;
  at?: Date;
}): Promise<PurchaseOrderRecord | undefined> {
  const at = input.at ?? new Date();
  assertLegalPurchaseOrderTransition('submitted', 'rejected');
  return await transitionPurchaseOrder({
    purchaseOrderId: input.purchaseOrderId,
    expected: 'submitted',
    next: 'rejected',
    initiator: 'supplier',
    reasonCode: input.reasonCode,
    ...(input.supplierNote ? { supplierNote: input.supplierNote } : {}),
    at,
    patch: { reasonCode: input.reasonCode, cancelledAt: at },
  });
}

/** The acceptance deadline passed — the timeout sweep's transition (ADR 0004 concern 5). */
export async function expirePurchaseOrder(
  purchaseOrderId: string,
  at: Date = new Date(),
): Promise<PurchaseOrderRecord | undefined> {
  assertLegalPurchaseOrderTransition('submitted', 'expired');
  return await transitionPurchaseOrder({
    purchaseOrderId,
    expected: 'submitted',
    next: 'expired',
    initiator: 'system',
    reasonCode: 'acceptance_timeout',
    at,
    patch: { reasonCode: 'acceptance_timeout', cancelledAt: at },
  });
}

/**
 * Someone on MERCARIA's side asked to cancel — the customer, an operator, or
 * the rollback runbook. A SEPARATE event from the supplier's own cancellation
 * (#118 consistency rule 8): this one opens `cancel_requested` and waits for
 * the supplier's answer; it never pretends the cancellation already happened.
 */
export async function requestPurchaseOrderCancellation(input: {
  purchaseOrderId: string;
  initiator: 'customer' | 'operator';
  byOxyUserId?: string;
  at?: Date;
}): Promise<PurchaseOrderRecord | undefined> {
  const at = input.at ?? new Date();
  const po = await findPurchaseOrderById(input.purchaseOrderId);
  if (!po) return undefined;
  if (po.status !== 'submitted' && po.status !== 'accepted') return undefined;
  assertLegalPurchaseOrderTransition(po.status, 'cancel_requested');
  return await transitionPurchaseOrder({
    purchaseOrderId: input.purchaseOrderId,
    expected: po.status,
    next: 'cancel_requested',
    initiator: input.initiator,
    reasonCode: input.initiator === 'customer' ? 'customer_cancelled' : 'operator_cancelled',
    ...(input.byOxyUserId ? { byOxyUserId: input.byOxyUserId } : {}),
    at,
  });
}

/** The supplier confirmed the cancellation — the ask becomes fact. */
export async function applySupplierCancellationConfirmed(input: {
  purchaseOrderId: string;
  reasonCode?: PurchaseOrderReasonCode;
  supplierNote?: string;
  at?: Date;
}): Promise<PurchaseOrderRecord | undefined> {
  const at = input.at ?? new Date();
  const reasonCode = input.reasonCode ?? 'supplier_cancelled';
  assertLegalPurchaseOrderTransition('cancel_requested', 'cancelled');
  return await transitionPurchaseOrder({
    purchaseOrderId: input.purchaseOrderId,
    expected: 'cancel_requested',
    next: 'cancelled',
    initiator: 'supplier',
    reasonCode,
    ...(input.supplierNote ? { supplierNote: input.supplierNote } : {}),
    at,
    patch: { reasonCode, cancelledAt: at },
  });
}

/**
 * The supplier answered "too late" — the PO returns to `accepted` and the
 * recovery is #127's RMA path, not a pretend cancellation (ADR 0004 diagram 8).
 */
export async function applySupplierCancellationDeclined(input: {
  purchaseOrderId: string;
  supplierNote?: string;
  at?: Date;
}): Promise<PurchaseOrderRecord | undefined> {
  assertLegalPurchaseOrderTransition('cancel_requested', 'accepted');
  return await transitionPurchaseOrder({
    purchaseOrderId: input.purchaseOrderId,
    expected: 'cancel_requested',
    next: 'accepted',
    initiator: 'supplier',
    ...(input.supplierNote ? { supplierNote: input.supplierNote } : {}),
    at: input.at ?? new Date(),
  });
}

/**
 * A parcel left the supplier. The FIRST shipment moves `accepted → shipped`;
 * later parcels of a split shipment just add their row (ADR 0004 diagram 7).
 */
export async function recordSupplierShipment(input: {
  purchaseOrderId: string;
  trackingNumber: string;
  carrier?: string;
  service?: string;
  shippedAt?: Date;
}): Promise<PurchaseOrderShipmentRecord> {
  const shippedAt = input.shippedAt ?? new Date();
  const po = await findPurchaseOrderById(input.purchaseOrderId);
  if (!po) {
    throw new Error(`recordSupplierShipment: purchase order ${input.purchaseOrderId} not found`);
  }
  if (po.status === 'accepted') {
    assertLegalPurchaseOrderTransition('accepted', 'shipped');
    await transitionPurchaseOrder({
      purchaseOrderId: input.purchaseOrderId,
      expected: 'accepted',
      next: 'shipped',
      initiator: 'supplier',
      at: shippedAt,
      patch: { shippedAt },
    });
    // Losing the CAS here means a concurrent shipment callback already moved
    // it — the parcel row below is still recorded either way.
  } else if (po.status !== 'shipped') {
    throw new Error(
      `recordSupplierShipment: purchase order ${input.purchaseOrderId} is ${po.status}, ` +
        'which cannot ship',
    );
  }
  return await recordPurchaseOrderShipment({
    purchaseOrderId: input.purchaseOrderId,
    trackingNumber: input.trackingNumber,
    ...(input.carrier ? { carrier: input.carrier } : {}),
    ...(input.service ? { service: input.service } : {}),
    shippedAt,
  });
}

/** Every parcel arrived: `shipped → delivered`. */
export async function markPurchaseOrderDelivered(
  purchaseOrderId: string,
  at: Date = new Date(),
): Promise<PurchaseOrderRecord | undefined> {
  assertLegalPurchaseOrderTransition('shipped', 'delivered');
  return await transitionPurchaseOrder({
    purchaseOrderId,
    expected: 'shipped',
    next: 'delivered',
    initiator: 'supplier',
    at,
    patch: { deliveredAt: at },
  });
}

/** The PO-status → customer-vocabulary map behind the fulfilment view. */
const FULFILMENT_STATE_BY_STATUS: Readonly<
  Record<PurchaseOrderStatus, PurchaseOrderFulfilmentState>
> = {
  draft: 'preparing',
  submitted: 'preparing',
  accepted: 'preparing',
  cancel_requested: 'preparing',
  shipped: 'shipped',
  delivered: 'delivered',
  rejected: 'cancelled',
  expired: 'cancelled',
  cancelled: 'cancelled',
};

/**
 * The customer-safe projection (#118 consistency rule 9): fulfilment state in
 * the customer vocabulary plus tracking numbers — and structurally nothing
 * else, because `PurchaseOrderFulfilmentView` has no property for a supplier,
 * a cost or a destination copy.
 */
export function projectPurchaseOrderFulfilment(
  po: Pick<PurchaseOrderRecord, 'status'>,
  shipments: readonly Pick<PurchaseOrderShipmentRecord, 'trackingNumber'>[],
): PurchaseOrderFulfilmentView {
  return {
    state: FULFILMENT_STATE_BY_STATUS[po.status],
    trackingNumbers: shipments.map((shipment) => shipment.trackingNumber),
  };
}

/** The operator projection of one PO — named field by field, never a spread. */
export interface PurchaseOrderOperatorView {
  id: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  orderId: string;
  checkoutGroupId: string | null;
  supplierExternalOrderId: string | null;
  currency: string;
  itemsAmount: number;
  shippingAmount: number;
  taxAmount: number;
  dutyAmount: number;
  totalAmount: number;
  reasonCode: PurchaseOrderReasonCode | null;
  acceptanceDeadlineAt: Date | null;
  submissionAttempts: number;
  lastSubmissionError: string | null;
  operatorInterventionRequired: boolean;
  supplierInvoiceRef: string | null;
  supplierCreditNoteRef: string | null;
  reconciledAt: Date | null;
  createdAt: Date;
}

/**
 * The operator projection (#118 consistency rule 10). It carries the PO's own
 * money and references — an operator's job — and ISOLATES what is not this
 * PO's business: no credential reference (that column never leaves the
 * account repository's explicit opt-in), and no customer data beyond the
 * order id handle. Field-by-field so a new column cannot leak by spread.
 */
export function projectPurchaseOrderOperatorView(po: PurchaseOrderRecord): PurchaseOrderOperatorView {
  return {
    id: po.id,
    status: po.status,
    supplierId: po.supplierId,
    supplierAccountId: po.supplierAccountId,
    agreementId: po.agreementId,
    orderId: po.orderId,
    checkoutGroupId: po.checkoutGroupId,
    supplierExternalOrderId: po.supplierExternalOrderId,
    currency: po.currency,
    itemsAmount: po.itemsAmount,
    shippingAmount: po.shippingAmount,
    taxAmount: po.taxAmount,
    dutyAmount: po.dutyAmount,
    totalAmount: po.totalAmount,
    reasonCode: po.reasonCode,
    acceptanceDeadlineAt: po.acceptanceDeadlineAt,
    submissionAttempts: po.submissionAttempts,
    lastSubmissionError: po.lastSubmissionError,
    operatorInterventionRequired: po.operatorInterventionRequired,
    supplierInvoiceRef: po.supplierInvoiceRef,
    supplierCreditNoteRef: po.supplierCreditNoteRef,
    reconciledAt: po.reconciledAt,
    createdAt: po.createdAt,
  };
}
