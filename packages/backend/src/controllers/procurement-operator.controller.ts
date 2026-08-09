/**
 * The procurement operator surface (#124 observability and operations).
 *
 * Lives under `/internal/procurement/*` behind `requireProcurementOperator` —
 * the SAME sixth allow-list `/internal/supplier-preflight` uses, and
 * deliberately not a seventh. The power is the same one: reading what Mercaria
 * pays its suppliers and acting on a supplier order. A separate list would be a
 * second thing to keep in sync with no distinction to justify it.
 *
 * ## Every write DRIVES an existing idempotent path
 *
 * `POST …/submit` enqueues the outbox row whose id is derived from the purchase
 * order, so an operator clicking it twice claims the SAME row rather than
 * queueing a second supplier order — #124 idempotency item 6 ("prevent operator
 * retry from bypassing the same unique key") held by the primary key rather
 * than by a check here. `POST …/cancel` opens the durable cancellation request
 * a buyer's own cancellation would. `POST …/converge` enqueues the submission
 * job, whose first act on an unresolved attempt is to ASK the provider by
 * client reference.
 *
 * So this surface adds a TRIGGER and no new way to move goods or money — the
 * `/internal/payments` repair-surface arrangement, whose four repairs each
 * drive a path that already exists.
 *
 * ## What is deliberately ABSENT
 *
 * There is no "set this purchase order accepted", no "attach this external
 * order id", no "clear this attempt" and no "delete this event". A purchase
 * order's state is what a supplier said, and an operator who could edit one
 * could make a supplier order that never existed look fulfilled. The one
 * mutation of a stored fact is resolving an EXCEPTION, which is a decision
 * about Mercaria's own queue and is attributable, dated and explained.
 */

import type { Request, Response } from 'express';
import type { ProcurementExceptionKind, ProcurementExceptionResolution } from '@mercaria/shared-types';
import { getDb } from '../db/postgres.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { procurementOperatorId } from '../middleware/procurement-operator-authz.js';
import { validationError } from '../lib/errors/error-codes.js';
import {
  findPurchaseOrderById,
  findPurchaseOrderLines,
  findPurchaseOrderShipments,
  findPurchaseOrderTransitions,
} from '../db/procurement/purchaseOrderRepository.js';
import { listSupplierOrderAttempts } from '../db/supplierOrders/attemptRepository.js';
import {
  listPurchaseOrderLineOutcomes,
  listPurchaseOrderTrackingEvents,
  listSupplierDocuments,
} from '../db/supplierOrders/evidenceRepository.js';
import {
  listProcurementExceptionsForPurchaseOrder,
  resolveProcurementException,
} from '../db/supplierOrders/exceptionRepository.js';
import { listSupplierProviderEventsForPurchaseOrder } from '../db/supplierOrders/providerEventRepository.js';
import { projectPurchaseOrderOperatorView } from '../services/procurement/purchase-order.service.js';
import { requestSupplierCancellation } from '../services/supplier-orders/cancellation.service.js';
import {
  readProcurementMetrics,
  readProcurementQueues,
} from '../services/supplier-orders/metrics.service.js';
import {
  enqueueProcurementEvent,
  purchaseOrderCancellationEventId,
  purchaseOrderSubmissionEventId,
} from '../services/supplier-orders/procurement-outbox.service.js';
import { redactSupplierReference } from '../services/supplier-orders/redact.js';

/** GET — submission latency, acceptance rate, lag, exceptions, refusals. */
export async function procurementMetricsHandler(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await readProcurementMetrics());
}

/** GET — the two operator queues: open conditions and dead-lettered jobs. */
export async function procurementQueuesHandler(req: Request, res: Response): Promise<void> {
  const kindRaw = req.query['kind'];
  const kind = typeof kindRaw === 'string' && kindRaw.trim() !== '' ? kindRaw.trim() : undefined;
  const limitRaw = req.query['limit'];
  const limit = Number.parseInt(typeof limitRaw === 'string' ? limitRaw : '50', 10);
  sendSuccess(
    res,
    await readProcurementQueues({
      ...(kind ? { kind: kind as ProcurementExceptionKind } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    }),
  );
}

/**
 * GET — one purchase order's whole procurement trace.
 *
 * Opens from a PURCHASE ORDER ID and nothing else. No buyer handle, no email,
 * no destination: the destination lives on the purchase order and is
 * deliberately not projected here, because an operator diagnosing a stuck
 * supplier order needs the supplier's answers, not the buyer's address — the
 * `tracePayment` five-handles rule, applied to procurement.
 */
export async function procurementTraceHandler(req: Request, res: Response): Promise<void> {
  const purchaseOrderId = requiredParam(req, 'purchaseOrderId');
  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Purchase order not found', 404);
    return;
  }

  const [lines, transitions, shipments, attempts, events, lineOutcomes, tracking, documents, exceptions] =
    await Promise.all([
      findPurchaseOrderLines(purchaseOrderId),
      findPurchaseOrderTransitions(purchaseOrderId),
      findPurchaseOrderShipments(purchaseOrderId),
      listSupplierOrderAttempts(purchaseOrderId),
      listSupplierProviderEventsForPurchaseOrder(purchaseOrderId),
      listPurchaseOrderLineOutcomes(purchaseOrderId),
      listPurchaseOrderTrackingEvents(purchaseOrderId),
      listSupplierDocuments(purchaseOrderId),
      listProcurementExceptionsForPurchaseOrder(purchaseOrderId),
    ]);

  sendSuccess(res, {
    purchaseOrder: {
      ...projectPurchaseOrderOperatorView(purchaseOrder),
      providerState: purchaseOrder.providerState,
      providerStateObservedAt: purchaseOrder.providerStateObservedAt,
      stateMappingVersion: purchaseOrder.stateMappingVersion,
      // The supplier's own order id is a live handle on their platform: shown
      // as its last four characters, the `provider_accounts` rule.
      supplierExternalOrderIdSuffix: redactSupplierReference(purchaseOrder.supplierExternalOrderId),
    },
    lines: lines.map((line) => ({
      id: line.id,
      supplierSku: line.supplierSku,
      quantity: line.quantity,
      unitCostAmount: line.unitCostAmount,
      lineTotalAmount: line.lineTotalAmount,
    })),
    transitions,
    shipments,
    attempts,
    events,
    lineOutcomes,
    tracking,
    documents,
    exceptions,
  });
}

/**
 * POST — submit or re-drive one purchase order.
 *
 * Enqueues the deterministic row; it does NOT call the supplier inline. Two
 * reasons, and the second is the load-bearing one: a provider call in a request
 * would evaporate on a restart after the attempt row was written, and the
 * enqueue makes an operator's retry indistinguishable from the dispatcher's own
 * — which is what stops it becoming a second path to a second supplier order.
 */
export async function procurementSubmitHandler(req: Request, res: Response): Promise<void> {
  const purchaseOrderId = requiredParam(req, 'purchaseOrderId');
  const purchaseOrder = await findPurchaseOrderById(purchaseOrderId);
  if (!purchaseOrder) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Purchase order not found', 404);
    return;
  }
  const created = await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderSubmissionEventId(purchaseOrderId),
    eventType: 'purchase_order_submission',
    payload: { purchaseOrderId },
  });
  sendSuccess(res, {
    purchaseOrderId,
    enqueued: created,
    // `false` is the ordinary outcome of a second click and is reported as such
    // rather than as an error: the job already exists and will run.
    note: created ? 'submission job created' : 'a submission job already exists for this order',
  });
}

/** POST — open a durable cancellation request and enqueue its delivery. */
export async function procurementCancelHandler(req: Request, res: Response): Promise<void> {
  const purchaseOrderId = requiredParam(req, 'purchaseOrderId');
  const operatorId = procurementOperatorId(req);
  const outcome = await requestSupplierCancellation({
    purchaseOrderId,
    initiator: 'operator',
    ...(operatorId ? { byOxyUserId: operatorId } : {}),
  });
  if (outcome.outcome === 'not_cancellable') {
    sendError(
      res,
      ErrorCodes.CONFLICT,
      `Purchase order is \`${outcome.status}\` and cannot be cancelled`,
      409,
    );
    return;
  }
  await enqueueProcurementEvent(getDb(), {
    id: purchaseOrderCancellationEventId(purchaseOrderId),
    eventType: 'purchase_order_cancellation',
    payload: { purchaseOrderId },
  });
  sendSuccess(res, { purchaseOrderId, requested: true });
}

/**
 * POST — close one exception with an attributable decision.
 *
 * The only mutation of a stored fact this surface offers, and it is a decision
 * about Mercaria's own queue rather than about what a supplier said. A second
 * close matches nothing and answers 409, so two operators cannot both record a
 * resolution for one condition.
 */
export async function procurementResolveExceptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const exceptionId = requiredParam(req, 'exceptionId');
  const operatorId = procurementOperatorId(req);
  if (!operatorId) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Operator identity is required', 401);
    return;
  }
  const body = req.body as { resolution: ProcurementExceptionResolution; note?: string };
  const resolved = await resolveProcurementException({
    exceptionId,
    resolution: body.resolution,
    resolvedByOxyUserId: operatorId,
    ...(body.note ? { resolutionNote: body.note } : {}),
  });
  if (!resolved) {
    sendError(res, ErrorCodes.CONFLICT, 'Exception is already resolved or does not exist', 409);
    return;
  }
  sendSuccess(res, resolved);
}

/** A required path parameter, or a 400 that names it. */
function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`\`${name}\` is required.`);
  }
  return value;
}
