/**
 * Getting the goods back, and getting Mercaria's money back — two things that
 * happen in one place and are never the same thing (#127 §"Return and RMA
 * orchestration", §"Supplier credits and recoveries").
 *
 * ## The customer's refund does not wait for the supplier's inspection
 *
 * #127 return rule 9 permits customer refund timing to be separate from supplier
 * inspection *"when law or policy requires earlier action"*, and it does: EU
 * withdrawal requires reimbursement at the latest when the goods come back OR
 * when the consumer supplies proof of return. So the refund trigger is the
 * BUYER's shipment evidence — a fact about the buyer — and not the warehouse's
 * receipt, which can be days later and is somebody else's diligence.
 *
 * #110 made the opposite choice for a MARKETPLACE return and was right to: there
 * the refund also RESTOCKS, so refunding before the goods are back would put
 * units on a shelf that are still in a parcel. A retail line restocks nothing
 * (ADR 0004 D5), so the reason for waiting does not exist here.
 *
 * ## The supplier RMA is asked for AFTER the customer is served
 *
 * ADR 0004 D8.5, as an ordering: `requestSupplierReturnAuthorization` runs after
 * the case exists and the customer's remedy is decided, and its answer changes
 * nothing about either. A supplier that refuses leaves the case in
 * `authorization_unavailable`, the buyer keeps their refund, and Mercaria's loss
 * is a `rejected_claim` recovery nobody's customer path reads.
 */

import type {
  RetailReturnDisposition,
  SupplierRecoveryKind,
} from '@mercaria/shared-types';
import {
  findRetailReturnCase,
  findRetailReturnCaseForRequest,
  listRetailReturnDispositions,
  recordRetailReturnDisposition,
  summariseRetailReturnDispositions,
  transitionRetailReturnCase,
  type RetailReturnCaseRecord,
} from '../../db/retailServiceRequests/returnCaseRepository.js';
import {
  appendRetailServiceEvent,
  findRetailServiceRequest,
} from '../../db/retailServiceRequests/requestRepository.js';
import {
  openSupplierRecovery,
  transitionSupplierRecovery,
  upsertSupplierReturnAuthorization,
} from '../../db/retailServiceRequests/supplierRecoveryRepository.js';
import { listRetailProcurementIntents } from '../../db/retailCheckout/retailCheckoutRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { retailDeciderAudit, type RetailServiceDecider } from './authorization.js';
import { completeRetailServiceRequest } from './decision.service.js';
import { loadRetailServiceOrder } from './order-facts.js';
import { notifyRetailReturnUpdated } from './notifications.js';
import { supplierRmaPort } from './supplier-rma.port.js';

/** The case for one request, with its lines. */
export async function readRetailReturnCase(
  requestId: string,
): Promise<RetailReturnCaseRecord | undefined> {
  return findRetailReturnCaseForRequest(requestId);
}

/**
 * Ask the supplier for a return authorization.
 *
 * Best-effort by construction: every outcome leaves the case usable and the
 * buyer's remedy untouched. The `unavailable` branch is the shipped one — no
 * registered adapter declares `return_authorization` — and it is recorded as a
 * REASON rather than as silence, because "we never asked" and "we asked and were
 * refused" lead an operator to opposite conclusions.
 */
export async function requestSupplierReturnAuthorization(
  decider: RetailServiceDecider,
  requestId: string,
  now: Date,
): Promise<RetailReturnCaseRecord> {
  const request = await findRetailServiceRequest(requestId);
  if (!request) throw notFound('Request not found');
  const returnCase = await findRetailReturnCaseForRequest(requestId);
  if (returnCase === undefined) throw notFound('Return case not found');
  if (returnCase.destination !== 'supplier') {
    // A return coming to Mercaria or going to a manufacturer needs no supplier
    // RMA. Asking for one would be a claim against a supplier for goods they
    // never receive.
    return returnCase;
  }

  const intents = await listRetailProcurementIntents(request.orderId);
  const purchaseOrderId = intents.find((intent) => intent.purchaseOrderId !== null)
    ?.purchaseOrderId;
  if (purchaseOrderId === undefined || purchaseOrderId === null) {
    // No purchase order means nothing was ever procured from a supplier for
    // these lines, so there is nobody to claim against. The case stands and the
    // buyer's remedy is unaffected.
    log.general.info(
      { requestId, orderId: request.orderId },
      '[RetailService] no purchase order to open an RMA against; the return case stands',
    );
    return returnCase;
  }

  const idempotencyKey = `rma:${returnCase.id}`;
  const answer = await supplierRmaPort().requestAuthorization({
    purchaseOrderId,
    reasonCode: request.kind,
    // Mercaria's OWN purchase-order line ids. The customer's order-line ids do
    // not cross — a supplier has no business knowing how Mercaria numbers a
    // consumer's basket.
    lines: [],
    idempotencyKey,
  });

  const { row } = await upsertSupplierReturnAuthorization({
    purchaseOrderId,
    reasonCode: request.kind,
    idempotencyKey,
    requestedAt: now,
    ...(answer.outcome === 'authorized'
      ? {
          state: answer.state,
          providerReference: answer.providerReference,
          authorizedAt: now,
          ...(answer.supplierDeadlineAt === undefined
            ? {}
            : { supplierDeadlineAt: answer.supplierDeadlineAt }),
        }
      : { state: 'requested' as const, unavailableReason: answer.reason }),
  });

  await transitionRetailReturnCase({
    id: returnCase.id,
    from: ['authorization_pending', 'authorization_unavailable'],
    to: answer.outcome === 'authorized' ? 'authorized' : 'authorization_unavailable',
    supplierReturnAuthorizationId: row.id,
    ...(answer.outcome === 'authorized' ? { labelSource: 'supplier_rma' as const } : {}),
  });
  await appendRetailServiceEvent({
    requestId,
    kind: answer.outcome === 'authorized' ? 'supplier_rma_authorized' : 'supplier_rma_unavailable',
    ...retailDeciderAudit(decider),
    detail: answer.outcome === 'authorized' ? row.id : answer.reason,
  });

  const reloaded = await findRetailReturnCase(returnCase.id);
  if (reloaded === undefined) throw notFound('Return case not found');
  return reloaded;
}

/**
 * Record a quantity movement, and move the case if the movement moved it.
 *
 * The APPEND-ONLY trail is the state; the case's own column is a coarse label
 * derived from it. #127 return rule 7's six trackable states are not all states
 * of a case: a case covering three units of which two arrived is in none of
 * them, and `partially_received` is the honest word for that.
 *
 * A `shipped` movement is what triggers the customer's refund — see the module
 * docblock. It is called through `completeRetailServiceRequest`, which is
 * idempotent on the refund's own key, so a buyer reporting a shipment twice
 * refunds once.
 */
export async function recordRetailReturnMovement(
  decider: RetailServiceDecider,
  input: {
    requestId: string;
    orderItemId: string;
    disposition: RetailReturnDisposition;
    quantity: number;
    observedAt: Date;
    idempotencyKey: string;
    detail?: string;
  },
  now: Date,
): Promise<RetailReturnCaseRecord> {
  const returnCase = await findRetailReturnCaseForRequest(input.requestId);
  if (returnCase === undefined) throw notFound('Return case not found');
  const line = returnCase.lines.find((row) => row.orderItemId === input.orderItemId);
  if (line === undefined) throw conflict('That line is not part of this return.');

  const { created } = await recordRetailReturnDisposition({
    returnCaseLineId: line.id,
    disposition: input.disposition,
    quantity: input.quantity,
    observedAt: input.observedAt,
    idempotencyKey: input.idempotencyKey,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...retailDeciderAudit(decider),
  });
  if (!created) {
    // The convergence the key exists for. A supplier redelivering an event has
    // done nothing wrong, and the case is already where the first delivery put
    // it.
    return returnCase;
  }

  const totals = await summariseRetailReturnDispositions(returnCase.id);
  const authorized = returnCase.lines.reduce((sum, row) => sum + row.authorizedQuantity, 0);
  const nextState =
    totals.inspected > 0
      ? 'inspected'
      : totals.received >= authorized && authorized > 0
        ? 'received'
        : totals.received > 0
          ? 'partially_received'
          : totals.shipped > 0
            ? 'in_transit'
            : returnCase.state;

  if (nextState !== returnCase.state) {
    await transitionRetailReturnCase({
      id: returnCase.id,
      from: [
        'authorization_pending',
        'authorization_unavailable',
        'authorized',
        'in_transit',
        'partially_received',
        'received',
      ],
      to: nextState,
      ...(input.disposition === 'inspected'
        ? { inspectedAt: now, inspectionOutcome: input.detail ?? 'inspected' }
        : {}),
    });
  }

  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: `return_${input.disposition}`,
    ...retailDeciderAudit(decider),
    detail: String(input.quantity),
  });

  const request = await findRetailServiceRequest(input.requestId);
  if (request) {
    const context = await loadRetailServiceOrder(request.orderId);
    if (context !== null) notifyRetailReturnUpdated(context.order, input.requestId, nextState);
  }

  if (input.disposition === 'shipped') {
    // The refund trigger. Idempotent on the refund's own key, so reporting a
    // shipment twice refunds once — and a `credited` movement from a supplier
    // weeks later never triggers anything at all, which is ADR 0004 D8.5.
    await completeRetailServiceRequest(decider, input.requestId, now);
  }

  const reloaded = await findRetailReturnCase(returnCase.id);
  if (reloaded === undefined) throw notFound('Return case not found');
  return reloaded;
}

/** Every movement against one case, oldest first — the operator's trail. */
export async function readRetailReturnMovements(returnCaseId: string) {
  return listRetailReturnDispositions(returnCaseId);
}

/**
 * Open a supplier recovery against a return.
 *
 * A recovery is Mercaria trying to get its COST back. It is not a customer
 * refund, is not sized by one and does not delay one — and none of that is a
 * rule anybody has to remember, because this function returns nothing a customer
 * path could read and takes no customer amount.
 *
 * The `expectedAmount` is deliberately OPTIONAL and is deliberately not derived
 * from the customer's refund. What a supplier owes Mercaria is the wholesale
 * figure on the purchase order, which an operator supplies or a credit note
 * states; computing it from what the buyer paid would be the exact conflation
 * ADR 0004 D8.5 forbids.
 */
export async function openRetailSupplierRecovery(
  decider: RetailServiceDecider,
  input: {
    requestId: string;
    kind: SupplierRecoveryKind;
    purchaseOrderId: string;
    supplierReturnAuthorizationId?: string;
    expectedAmount?: number;
    expectedCurrency?: string;
  },
  now: Date,
): Promise<{ id: string; created: boolean }> {
  const { row, created } = await openSupplierRecovery({
    kind: input.kind,
    purchaseOrderId: input.purchaseOrderId,
    ...(input.supplierReturnAuthorizationId === undefined
      ? {}
      : { supplierReturnAuthorizationId: input.supplierReturnAuthorizationId }),
    serviceRequestId: input.requestId,
    ...(input.expectedAmount === undefined ? {} : { expectedAmount: input.expectedAmount }),
    ...(input.expectedCurrency === undefined
      ? {}
      : { expectedCurrency: input.expectedCurrency as never }),
    openedAt: now,
    idempotencyKey: `recovery:${input.requestId}:${input.kind}`,
  });
  if (created) {
    await appendRetailServiceEvent({
      requestId: input.requestId,
      kind: 'supplier_recovery_opened',
      ...retailDeciderAudit(decider),
      detail: input.kind,
    });
  }
  return { id: row.id, created };
}

/**
 * Record what the supplier actually did with a claim.
 *
 * A REJECTION is an ordinary terminal state and changes nothing on the customer
 * side — #127 responsibility rule 4, held by this function returning the
 * recovery row and nothing else. There is no branch here that reads a customer
 * request, and none that could.
 */
export async function settleRetailSupplierRecovery(
  decider: RetailServiceDecider,
  input: {
    recoveryId: string;
    requestId: string;
    accepted: boolean;
    creditedAmount?: number;
    creditedCurrency?: string;
    creditNoteReference?: string;
    rejectionReason?: string;
  },
  now: Date,
): Promise<void> {
  const moved = await transitionSupplierRecovery({
    id: input.recoveryId,
    from: ['claimed', 'acknowledged', 'accepted'],
    to: input.accepted ? 'credited' : 'rejected',
    ...(input.creditedAmount === undefined ? {} : { creditedAmount: input.creditedAmount }),
    ...(input.creditedCurrency === undefined
      ? {}
      : { creditedCurrency: input.creditedCurrency as never }),
    ...(input.creditNoteReference === undefined
      ? {}
      : { creditNoteReference: input.creditNoteReference }),
    ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
    ...(input.accepted ? {} : { closedAt: now }),
  });
  if (!moved) throw conflict('This recovery has already been settled.');

  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: input.accepted ? 'supplier_recovery_credited' : 'supplier_recovery_rejected',
    ...retailDeciderAudit(decider),
    detail: input.accepted ? (input.creditNoteReference ?? 'credited') : (input.rejectionReason ?? 'rejected'),
  });
  log.general.info(
    { recoveryId: input.recoveryId, accepted: input.accepted },
    '[RetailService] supplier recovery settled; the customer refund is unaffected',
  );
}
