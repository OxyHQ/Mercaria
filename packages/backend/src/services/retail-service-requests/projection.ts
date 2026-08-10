/**
 * What a customer sees, and what an operator sees — two DIFFERENT types (#127
 * §"Customer and operator experience").
 *
 * ## The customer view is a different type, not a filtered one
 *
 * `RetailServiceRequestView` has no supplier member, no recovery member, no
 * purchase-order member, no destination and no wholesale amount — so a
 * serializer that reached for one fails `tsc`. That is #106's `MerchantOrder`
 * device and it is the primary enforcement of #127 experience rule 8 (*"never
 * expose internal supplier disputes or wholesale amounts"*); the runtime walk in
 * `retail-service-isolation.test.ts` is the second layer, for a field added to
 * the view itself under a plausible name.
 *
 * ## `nextAction` is a bounded CODE and never a sentence
 *
 * Rule 2 asks the surface to *"show request status and next action"*, and a free
 * text status line is what a system produces when nobody decided what the next
 * action is. The copy lives in the client, so a correction does not require
 * rewriting what a stored request says.
 *
 * ## Received and refunded are separate, on purpose
 *
 * Rule 5 — *"distinguish return received from refund completed"* — is why
 * `RetailServiceReturnCaseView` carries its own quantities and
 * `RetailServiceRefundView` carries `settled` derived from the RAIL's state.
 * They really are different days and a buyer told one when they asked about the
 * other opens a support thread.
 */

import type {
  RetailServiceNextAction,
  RetailServiceOperatorView,
  RetailServiceRequestView,
  SupplierRecoveryView,
} from '@mercaria/shared-types';
import { retailRefundAllocationTotal } from '@mercaria/shared-types';
import { findRefundById } from '../../db/orders/refundRepository.js';
import { listRetailDisputeCoordinationsForOrder } from '../../db/retailServiceRequests/policyRepository.js';
import type { RetailServiceRequestRecord } from '../../db/retailServiceRequests/requestRepository.js';
import {
  findRetailReturnCaseForRequest,
  summariseRetailReturnDispositions,
} from '../../db/retailServiceRequests/returnCaseRepository.js';
import { listSupplierRecoveriesForRequest } from '../../db/retailServiceRequests/supplierRecoveryRepository.js';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import { composeRetailRefundAllocation } from './allocation.js';
import { readRetailRefundBasis } from './order-facts.js';

/** What the buyer is waiting for, or what they must do. */
function nextActionFor(
  record: RetailServiceRequestRecord,
  returnShipped: boolean,
): RetailServiceNextAction {
  switch (record.state) {
    case 'evidence_required':
      return 'send_evidence';
    case 'submitted':
      return 'awaiting_mercaria_decision';
    case 'accepted':
      return returnShipped ? 'awaiting_item_receipt' : 'ship_the_item_back';
    case 'in_progress':
      return 'awaiting_refund';
    case 'completed':
    case 'rejected':
    case 'withdrawn':
    case 'cancelled':
      return 'closed';
    default:
      return 'none';
  }
}

/**
 * The CUSTOMER's view of one request.
 *
 * Every field is named explicitly (the `provider_accounts` #46 device) and the
 * omissions are the design: a buyer reading this cannot tell that a supplier
 * exists, which is #127 experience rule 8 and ADR 0004 D2.8.
 */
export async function projectRetailServiceRequestForCustomer(
  record: RetailServiceRequestRecord,
  order: OrderRecord,
): Promise<RetailServiceRequestView> {
  const returnCase = await findRetailReturnCaseForRequest(record.id);
  const totals =
    returnCase === undefined
      ? undefined
      : await summariseRetailReturnDispositions(returnCase.id);

  const deadlineAt =
    record.commercialDeadlineAt !== null &&
    (record.statutoryDeadlineAt === null ||
      record.commercialDeadlineAt.getTime() > record.statutoryDeadlineAt.getTime())
      ? record.commercialDeadlineAt
      : record.statutoryDeadlineAt;

  const refund =
    record.refundId === null
      ? undefined
      : await projectRetailRefund(record, order, record.refundId);

  return {
    id: record.id,
    orderId: record.orderId,
    kind: record.kind,
    state: record.state,
    lines: record.lines.map((line) => ({
      orderItemId: line.orderItemId,
      variantId:
        order.items.find((item) => item.id === line.orderItemId)?.variantId ?? line.orderItemId,
      // The APPROVED quantity once Mercaria has decided, so a buyer sees what
      // they are actually getting rather than what they asked for.
      quantity: line.approvedQuantity ?? line.requestedQuantity,
    })),
    evidence: record.evidence.map((item) => ({
      kind: item.kind,
      fileId: item.fileId,
      ...(item.caption === null ? {} : { caption: item.caption }),
    })),
    ...(record.customerNote === null ? {} : { customerNote: record.customerNote }),
    ...(deadlineAt === null ? {} : { customerDeadlineAt: deadlineAt.toISOString() }),
    ...(record.outcome === null ? {} : { outcome: record.outcome }),
    ...(record.outcomeNote === null ? {} : { outcomeNote: record.outcomeNote }),
    ...(refund === undefined ? {} : { refund }),
    ...(returnCase === undefined || totals === undefined
      ? {}
      : {
          returnCase: {
            id: returnCase.id,
            state: returnCase.state,
            ...(returnCase.shipBackDeadlineAt === null
              ? {}
              : { shipBackDeadlineAt: returnCase.shipBackDeadlineAt.toISOString() }),
            // Honest about #159: no registered adapter declares
            // `return_authorization` and Moovo reverse transport is unbuilt, so
            // no label exists and the view says so rather than showing a
            // download that 404s.
            labelAvailable: returnCase.labelSource !== 'unavailable',
            ...(returnCase.instructionsKey === null
              ? {}
              : { instructionsKey: returnCase.instructionsKey }),
            shippedQuantity: totals.shipped,
            receivedQuantity: totals.received,
          },
        }),
    // A safety notice stays prominent whatever else the request says (rule 7).
    safetyNotice: record.kind === 'safety_recall',
    nextAction: nextActionFor(record, (totals?.shipped ?? 0) > 0),
    submittedAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * The refund as the buyer sees it — amount, breakdown, method and whether the
 * rail has finished.
 *
 * `settled` is read from `refunds.provider_state`, which is #49's own answer.
 * Re-deriving it from the request's state would be a second spelling of the same
 * fact, and the two would disagree exactly when a rail answered late — which is
 * the case a buyer is asking about.
 */
async function projectRetailRefund(
  record: RetailServiceRequestRecord,
  order: OrderRecord,
  refundId: string,
) {
  const refund = await findRefundById(refundId);
  const basis = await readRetailRefundBasis(order);
  const allocation = composeRetailRefundAllocation({
    kind: record.kind,
    lines: basis.lines,
    units: record.lines.map((line) => ({
      orderItemId: line.orderItemId,
      quantity: line.approvedQuantity ?? 0,
    })),
    totals: basis.totals,
  });
  return {
    refundId,
    amount: retailRefundAllocationTotal(allocation),
    allocation,
    // #127 refund rule 3. There is no other value this could take: the adapter
    // has no destination parameter, so a refund goes back the way it came or it
    // does not happen.
    destination: 'original_payment_method' as const,
    settled: refund?.providerState === 'succeeded',
  };
}

/**
 * The OPERATOR's view: customer obligation and supplier recovery SIDE BY SIDE.
 *
 * Two named members and no arithmetic between them. There is no field here that
 * nets a recovery against a refund and no function in this domain that could
 * produce one — which is #127's *"without conflating them"* and ADR 0004 D8.5.
 *
 * This is the only projection that carries a supplier recovery, and it is served
 * exclusively from `/internal/procurement/*` behind
 * `PROCUREMENT_OPERATOR_OXY_USER_IDS` — the sixth allow-list, which exists for
 * reading what Mercaria pays its suppliers. The payment-operator surface serves
 * the customer half from `projectRetailServiceRequestForCustomer`, so the
 * disclosure boundary is a property of the routers rather than of a filter.
 */
export async function projectRetailServiceRequestForOperator(
  record: RetailServiceRequestRecord,
  order: OrderRecord,
): Promise<RetailServiceOperatorView> {
  const [request, recoveries, coordinations] = await Promise.all([
    projectRetailServiceRequestForCustomer(record, order),
    listSupplierRecoveriesForRequest(record.id),
    listRetailDisputeCoordinationsForOrder(record.orderId),
  ]);

  const supplierRecoveries: SupplierRecoveryView[] = recoveries.map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    ...(row.expectedAmount === null || row.expectedCurrency === null
      ? {}
      : { expectedAmount: { amount: row.expectedAmount, currency: row.expectedCurrency } }),
    ...(row.creditedAmount === null || row.creditedCurrency === null
      ? {}
      : { creditedAmount: { amount: row.creditedAmount, currency: row.creditedCurrency } }),
    purchaseOrderId: row.purchaseOrderId,
    ...(row.supplierReturnAuthorizationId === null
      ? {}
      : { supplierReturnAuthorizationId: row.supplierReturnAuthorizationId }),
    ...(row.creditNoteReference === null
      ? {}
      : { creditNoteReference: row.creditNoteReference }),
    openedAt: row.openedAt.toISOString(),
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt.toISOString() }),
  }));

  const coordination = coordinations[0];
  return {
    request,
    customerObligation: {
      ...(record.outcome === null ? {} : { outcome: record.outcome }),
      ...(request.refund === undefined ? {} : { refundAmount: request.refund.amount }),
      refundSettled: request.refund?.settled ?? false,
      ...(record.decidedAt === null ? {} : { decidedAt: record.decidedAt.toISOString() }),
    },
    supplierRecoveries,
    ...(coordination === undefined
      ? {}
      : {
          disputeCoordination: {
            disputeId: coordination.disputeId,
            suspension: coordination.suspension,
            ...(coordination.suspensionReason === null
              ? {}
              : { suspensionReason: coordination.suspensionReason }),
          },
        }),
  };
}
