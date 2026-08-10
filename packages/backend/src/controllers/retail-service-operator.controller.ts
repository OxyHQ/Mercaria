/**
 * The two OPERATOR surfaces for retail service requests (#127 §"Customer and
 * operator experience"), split by what each may disclose.
 *
 * ## Two existing allow-lists, and the split is the design
 *
 * *"Operator surfaces must show customer obligation and supplier recovery side
 * by side without conflating them."* The two halves are disclosed to different
 * people, so they are served by different routers behind different gates:
 *
 *  - the CUSTOMER half from `/internal/payments/retail-service-requests/*`,
 *    behind `PAYMENT_OPERATOR_OXY_USER_IDS`. Deciding a remedy moves Mercaria's
 *    money, which is exactly what that list already gates, and the projection it
 *    serves carries NO recovery, no wholesale figure and no purchase-order id.
 *  - the SIDE-BY-SIDE trace from `/internal/procurement/retail-service/*`,
 *    behind `PROCUREMENT_OPERATOR_OXY_USER_IDS`. That list exists for "reading
 *    what Mercaria PAYS its suppliers" and this is the only surface that
 *    discloses one.
 *
 * So the disclosure boundary is a property of the two ROUTERS rather than of a
 * filter somebody has to remember to apply, and neither is a seventh list.
 *
 * ## Every write drives an existing idempotent path
 *
 * There is no "set this request completed", no "override this outcome", no
 * "attach this refund id" and no delete. `complete` calls the same function the
 * reconciler does; `report` appends a movement whose idempotency key converges;
 * `release` is the one mutation of a stored fact and is attributable, dated and
 * explained by CHECK.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  RETAIL_CUSTOMER_OUTCOMES,
  RETAIL_RETURN_DESTINATIONS,
  RETAIL_RETURN_DISPOSITIONS,
  RETAIL_SERVICE_NOTE_MAX_LENGTH,
  SUPPLIER_RECOVERY_KINDS,
} from '@mercaria/shared-types';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { respondWithError } from '../lib/errors/error-codes.js';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { findRetailServiceRequest, listOpenRetailServiceRequests, listRetailServiceEvents } from '../db/retailServiceRequests/requestRepository.js';
import { listOpenSupplierRecoveries } from '../db/retailServiceRequests/supplierRecoveryRepository.js';
import { findOrderById } from '../db/orders/orderRepository.js';
import { retailOperatorDecider } from '../services/retail-service-requests/authorization.js';
import {
  cancelRetailServiceRequest,
  completeRetailServiceRequest,
  decideRetailServiceRequest,
} from '../services/retail-service-requests/decision.service.js';
import { requestRetailSupplierCancellation } from '../services/retail-service-requests/cancellation.service.js';
import {
  openRetailSupplierRecovery,
  readRetailReturnMovements,
  recordRetailReturnMovement,
  requestSupplierReturnAuthorization,
  settleRetailSupplierRecovery,
} from '../services/retail-service-requests/return-case.service.js';
import {
  projectRetailServiceRequestForCustomer,
  projectRetailServiceRequestForOperator,
} from '../services/retail-service-requests/projection.js';
import { releaseRetailRefundSuspension } from '../services/retail-service-requests/dispute-coordination.service.js';
import { escalateRetailWarrantySafety } from '../services/retail-service-requests/warranty.service.js';

/** One path parameter as a string. */
function pathParam(req: Request, name: string): string {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? '';
}

const decideSchema = z
  .object({
    accept: z.boolean(),
    outcome: z.enum(RETAIL_CUSTOMER_OUTCOMES),
    outcomeNote: z.string().min(1).max(RETAIL_SERVICE_NOTE_MAX_LENGTH).optional(),
    returnDestination: z.enum(RETAIL_RETURN_DESTINATIONS).optional(),
    approvedQuantities: z
      .array(
        z.object({ orderItemId: z.string().min(1), quantity: z.number().int().min(0) }).strict(),
      )
      .optional(),
  })
  .strict();

const reportSchema = z
  .object({
    orderItemId: z.string().min(1),
    disposition: z.enum(RETAIL_RETURN_DISPOSITIONS),
    quantity: z.number().int().positive(),
    observedAt: z.string().datetime().optional(),
    idempotencyKey: z.string().min(1).max(200),
    detail: z.string().min(1).max(RETAIL_SERVICE_NOTE_MAX_LENGTH).optional(),
  })
  .strict();

const recoverySchema = z
  .object({
    kind: z.enum(SUPPLIER_RECOVERY_KINDS),
    purchaseOrderId: z.string().min(1),
    expectedAmount: z.number().int().min(0).optional(),
    expectedCurrency: z.string().length(3).optional(),
  })
  .strict();

const settleSchema = z
  .object({
    recoveryId: z.string().min(1),
    accepted: z.boolean(),
    creditedAmount: z.number().int().min(0).optional(),
    creditedCurrency: z.string().length(3).optional(),
    creditNoteReference: z.string().min(1).max(200).optional(),
    rejectionReason: z.string().min(1).max(RETAIL_SERVICE_NOTE_MAX_LENGTH).optional(),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().min(1).max(RETAIL_SERVICE_NOTE_MAX_LENGTH) }).strict();

/** Read a request and its order, or send the 404 and return `null`. */
async function loadForOperator(req: Request, res: Response) {
  const record = await findRetailServiceRequest(pathParam(req, 'requestId'));
  if (!record) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Request not found', 404);
    return null;
  }
  const order = await findOrderById(record.orderId);
  if (!order) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Request not found', 404);
    return null;
  }
  return { record, order };
}

/* -------------------------------------------------------------------------- */
/*  The CUSTOMER half — payment operators                                      */
/* -------------------------------------------------------------------------- */

/** GET — the open queue, oldest first. Customer facts only. */
export async function retailServiceQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listOpenRetailServiceRequests(100);
    sendSuccess(res, {
      requests: rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        kind: row.kind,
        state: row.state,
        submittedAt: row.createdAt.toISOString(),
        supplierResponseDueAt: row.supplierResponseDueAt?.toISOString(),
      })),
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to read the queue');
  }
}

/** GET — one request as the buyer sees it, plus its append-only trail. */
export async function retailServiceTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const [view, timeline] = await Promise.all([
      projectRetailServiceRequestForCustomer(loaded.record, loaded.order),
      listRetailServiceEvents(loaded.record.id),
    ]);
    sendSuccess(res, { request: view, timeline });
  } catch (error) {
    respondWithError(res, error, 'Failed to trace the request');
  }
}

/** POST — accept or reject, and name the outcome. */
export async function retailServiceDecideHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid request', 400);
      return;
    }
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'request:decide');
    const record = await decideRetailServiceRequest(
      decider,
      {
        requestId: loaded.record.id,
        accept: parsed.data.accept === true,
        outcome: parsed.data.outcome ?? 'no_remedy',
        ...(parsed.data.outcomeNote === undefined ? {} : { outcomeNote: parsed.data.outcomeNote }),
        ...(parsed.data.returnDestination === undefined
          ? {}
          : { returnDestination: parsed.data.returnDestination }),
        ...(parsed.data.approvedQuantities === undefined
          ? {}
          : {
              approvedQuantities: new Map(
                parsed.data.approvedQuantities.map((entry) => [
                  entry.orderItemId ?? '',
                  entry.quantity ?? 0,
                ]),
              ),
            }),
      },
      new Date(),
    );
    sendSuccess(res, await projectRetailServiceRequestForCustomer(record, loaded.order));
  } catch (error) {
    respondWithError(res, error, 'Failed to decide the request');
  }
}

/** POST — drive the accepted outcome. Idempotent on the refund's own key. */
export async function retailServiceCompleteHandler(req: Request, res: Response): Promise<void> {
  try {
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'request:complete');
    const record = await completeRetailServiceRequest(decider, loaded.record.id, new Date());
    sendSuccess(res, await projectRetailServiceRequestForCustomer(record, loaded.order));
  } catch (error) {
    respondWithError(res, error, 'Failed to complete the request');
  }
}

/** POST — terminate an accepted request Mercaria will not deliver, with a reason. */
export async function retailServiceCancelHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = reasonSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A reason is required', 400);
      return;
    }
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'request:decide');
    const record = await cancelRetailServiceRequest(
      decider,
      { requestId: loaded.record.id, reason: parsed.data.reason ?? '' },
      new Date(),
    );
    sendSuccess(res, await projectRetailServiceRequestForCustomer(record, loaded.order));
  } catch (error) {
    respondWithError(res, error, 'Failed to cancel the request');
  }
}

/**
 * POST — release a refund suspension while a dispute is open.
 *
 * The ONE mutation of a stored fact this surface performs, and it is the one
 * #127 rule 10 exists for: a refund committed while a dispute runs must be a
 * decision somebody made and can be shown to have made.
 */
export async function retailServiceReleaseSuspensionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = reasonSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A reason is required', 400);
      return;
    }
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'suspension:release');
    const row = await releaseRetailRefundSuspension(
      decider,
      { disputeId: pathParam(req, 'disputeId'), reason: parsed.data.reason ?? '' },
      new Date(),
    );
    sendSuccess(res, { disputeId: row.disputeId, suspension: row.suspension });
  } catch (error) {
    respondWithError(res, error, 'Failed to release the suspension');
  }
}

/** POST — escalate a warranty case to product safety, with a reason. */
export async function retailServiceEscalateSafetyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = reasonSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, 'A reason is required', 400);
      return;
    }
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'request:decide');
    const row = await escalateRetailWarrantySafety(
      decider,
      { requestId: loaded.record.id, reason: parsed.data.reason ?? '' },
      new Date(),
    );
    sendSuccess(res, { warrantyCaseId: row.id, state: row.state });
  } catch (error) {
    respondWithError(res, error, 'Failed to escalate the case');
  }
}

/* -------------------------------------------------------------------------- */
/*  The SUPPLIER half — procurement operators                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET — one request with its recoveries SIDE BY SIDE.
 *
 * The only projection in this domain that carries a supplier recovery, served
 * from the only router whose allow-list already grants "read what Mercaria pays
 * its suppliers". There is no member on it that nets one against the other.
 */
export async function retailRecoveryTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    sendSuccess(res, await projectRetailServiceRequestForOperator(loaded.record, loaded.order));
  } catch (error) {
    respondWithError(res, error, 'Failed to trace the recovery');
  }
}

/** GET — what Mercaria is still owed, oldest first. */
export async function retailRecoveryQueueHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listOpenSupplierRecoveries(100);
    sendSuccess(res, { recoveries: rows });
  } catch (error) {
    respondWithError(res, error, 'Failed to read the recovery queue');
  }
}

/** POST — ask the supplier for an RMA. Answers `unavailable` today, visibly. */
export async function retailRmaRequestHandler(req: Request, res: Response): Promise<void> {
  try {
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'rma:drive');
    const returnCase = await requestSupplierReturnAuthorization(
      decider,
      loaded.record.id,
      new Date(),
    );
    sendSuccess(res, {
      returnCaseId: returnCase.id,
      state: returnCase.state,
      labelSource: returnCase.labelSource,
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to request the authorization');
  }
}

/** POST — record a quantity movement against a return case. */
export async function retailReturnReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid request', 400);
      return;
    }
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'return:report');
    const now = new Date();
    const returnCase = await recordRetailReturnMovement(
      decider,
      {
        requestId: loaded.record.id,
        orderItemId: parsed.data.orderItemId ?? '',
        disposition: parsed.data.disposition ?? 'received',
        quantity: parsed.data.quantity ?? 0,
        observedAt: parsed.data.observedAt === undefined ? now : new Date(parsed.data.observedAt),
        idempotencyKey: parsed.data.idempotencyKey ?? '',
        ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
      },
      now,
    );
    sendSuccess(res, {
      returnCaseId: returnCase.id,
      state: returnCase.state,
      movements: await readRetailReturnMovements(returnCase.id),
    });
  } catch (error) {
    respondWithError(res, error, 'Failed to record the movement');
  }
}

/** POST — open a supplier recovery. It books nothing; #128 does. */
export async function retailRecoveryOpenHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = recoverySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid request', 400);
      return;
    }
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'recovery:drive');
    const result = await openRetailSupplierRecovery(
      decider,
      {
        requestId: loaded.record.id,
        kind: parsed.data.kind ?? 'return_credit',
        purchaseOrderId: parsed.data.purchaseOrderId ?? '',
        ...(parsed.data.expectedAmount === undefined
          ? {}
          : { expectedAmount: parsed.data.expectedAmount }),
        ...(parsed.data.expectedCurrency === undefined
          ? {}
          : { expectedCurrency: parsed.data.expectedCurrency }),
      },
      new Date(),
    );
    sendSuccess(res, result, result.created ? 201 : 200);
  } catch (error) {
    respondWithError(res, error, 'Failed to open the recovery');
  }
}

/**
 * POST — record what the supplier did with a claim.
 *
 * A REJECTION is an ordinary terminal state and changes nothing on the customer
 * side (#127 responsibility rule 4). This handler returns no customer field at
 * all, which is that rule at the HTTP boundary.
 */
export async function retailRecoverySettleHandler(req: Request, res: Response): Promise<void> {
  try {
    const parsed = settleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0]?.message ?? 'Invalid request', 400);
      return;
    }
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'recovery:drive');
    await settleRetailSupplierRecovery(
      decider,
      {
        recoveryId: parsed.data.recoveryId ?? '',
        requestId: loaded.record.id,
        accepted: parsed.data.accepted === true,
        ...(parsed.data.creditedAmount === undefined
          ? {}
          : { creditedAmount: parsed.data.creditedAmount }),
        ...(parsed.data.creditedCurrency === undefined
          ? {}
          : { creditedCurrency: parsed.data.creditedCurrency }),
        ...(parsed.data.creditNoteReference === undefined
          ? {}
          : { creditNoteReference: parsed.data.creditNoteReference }),
        ...(parsed.data.rejectionReason === undefined
          ? {}
          : { rejectionReason: parsed.data.rejectionReason }),
      },
      new Date(),
    );
    sendSuccess(res, { settled: true });
  } catch (error) {
    respondWithError(res, error, 'Failed to settle the recovery');
  }
}

/** POST — ask the supplier to cancel. The buyer's refund is already decided. */
export async function retailSupplierCancelHandler(req: Request, res: Response): Promise<void> {
  try {
    const loaded = await loadForOperator(req, res);
    if (loaded === null) return;
    const decider = retailOperatorDecider(getRequiredOxyUserId(req), 'recovery:drive');
    const state = await requestRetailSupplierCancellation(
      decider,
      loaded.record.id,
      new Date(),
    );
    sendSuccess(res, state);
  } catch (error) {
    respondWithError(res, error, 'Failed to request the cancellation');
  }
}
