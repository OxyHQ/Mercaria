/**
 * The operator surface's handlers — issue #50.
 *
 * Everything here is behind `requirePaymentOperator`, which is the whole of the
 * authorization: no handler re-checks it, and none reads a store, a membership
 * or a permission. That is deliberate rather than an omission — this surface
 * reads ACROSS every store and every P2P seller, so a per-store check would be
 * meaningless, and one that looked like it worked would be worse than none.
 *
 * ## What the responses carry, and what they never do
 *
 * A trace is merchant and operator financial detail: statuses, amounts,
 * currencies, Mercaria ids and the rail's own object ids. It carries no provider
 * PAYLOAD — the stored `payload_summary` was already reduced by
 * `redactProviderPayload` at ingress, and this projects it again rather than
 * spreading a row, so a column added later cannot ride along.
 *
 * It also carries no buyer contact value of any kind. There is no email, no
 * phone and no address anywhere in the shapes below, which is issue #50's
 * privacy boundary 5 held structurally: the fields do not exist to be leaked.
 *
 * ## Every response is a PROJECTION, never a row
 *
 * The same rule #46's `SellerPaymentSettings` follows. `db.select()` enumerates
 * every column, so returning a row would ship whatever the next migration adds —
 * and on these tables that is provider detail by default.
 */

import type { Request, Response } from 'express';
import { getDb } from '../db/postgres.js';
import { config } from '../config/index.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';
import { operatorId } from '../middleware/operator-authz.js';
import { routeParam } from '../utils/request.js';
import type {
  DiscrepancyResolutionInput,
  PaymentExceptionsQueryInput,
  PaymentRefetchInput,
  PaymentRepairInput,
  PaymentTraceQueryInput,
} from '../middleware/payments-schemas.js';
import {
  findPaymentById,
  type PaymentAttemptRow,
  type PaymentProviderEventRow,
  type PaymentRow,
  type PayoutRow,
  type TransferRow,
} from '../db/payments/paymentRepository.js';
import {
  closeDiscrepancy,
  findDiscrepancyById,
  listDiscrepancies,
  listDiscrepanciesForPayment,
  type PaymentDiscrepancyRow,
} from '../db/payments/discrepancyRepository.js';
import {
  listRepairsForDiscrepancy,
  listRepairsForPayment,
  type PaymentRepairRow,
} from '../db/payments/repairRepository.js';
import {
  listPaymentOutboxExceptions,
  type PaymentOutboxRow,
} from '../db/payments/paymentOutboxRepository.js';
import { tracePayment, type PaymentTrace } from '../services/payments/payment.service.js';
import { findLinkedOrderByNumber } from '../services/payments/order-linkage.js';
import { reconcileOnePayment } from '../services/payments/reconciliation/open-payments.job.js';
import {
  runRepair,
  RepairRefusedError,
  type RepairRequest,
} from '../services/payments/reconciliation/repairs.service.js';
import { collectPaymentMetrics } from '../services/payments/reconciliation/metrics.service.js';
import type { PaymentDiscrepancyKind, PaymentOutboxEventType } from '@mercaria/shared-types';

/**
 * The outbox event types that ARE an operator queue.
 *
 * Five conditions only a person can close: #47's withheld transfer, #49's three
 * refund and reversal exceptions, and #48's capture-after-release. They are read
 * from `payment_outboxes` rather than copied into `payment_discrepancies`,
 * because copying would make one condition two rows that can disagree about
 * whether it is resolved — and the outbox row is the one the dispatcher already
 * reasons about.
 */
const EXCEPTION_EVENT_TYPES: readonly PaymentOutboxEventType[] = [
  'transfer_withheld',
  'refund_failed',
  'reversal_failed',
  'refund_unmatched',
  'payment_succeeded_after_release',
];

/** `GET /internal/payments/trace` — everything known about one payment. */
export async function tracePaymentHandler(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as PaymentTraceQueryInput;
  try {
    const trace = await resolveTrace(query);
    if (!trace) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No payment matches that handle', 404);
      return;
    }

    const db = getDb();
    const [discrepancies, repairs] = await Promise.all([
      listDiscrepanciesForPayment(db, trace.payment.id),
      listRepairsForPayment(db, trace.payment.id),
    ]);

    log.general.info(
      { actor: operatorId(req), paymentId: trace.payment.id },
      '[Payments] operator opened a payment trace',
    );
    sendSuccess(res, {
      payment: projectPayment(trace.payment),
      orderIds: trace.orderIds,
      attempts: trace.attempts.map(projectAttempt),
      events: trace.events.map(projectEvent),
      transfers: trace.transfers.map(projectTransfer),
      payouts: trace.payouts.map(projectPayout),
      refunds: trace.refunds.map(projectRefund),
      disputes: trace.disputes.map(projectDispute),
      ledger: trace.ledger.map((entry) => ({
        transactionId: entry.transaction.id,
        kind: entry.transaction.kind,
        description: entry.transaction.description,
        createdAt: entry.transaction.createdAt.toISOString(),
        entries: entry.entries.map((leg) => ({
          account: leg.account,
          currency: leg.currency,
          // A `bigint` cannot be serialised by `JSON.stringify` — and rounding it
          // into a `number` would silently lose exactness past 2^53 on the one
          // surface whose job is to be exactly right.
          amountMinor: leg.amountMinor.toString(),
          ownerType: leg.ownerType,
          ownerId: leg.ownerId,
          orderId: leg.orderId,
        })),
      })),
      discrepancies: discrepancies.map(projectDiscrepancy),
      repairs: repairs.map(projectRepair),
    });
  } catch (error: unknown) {
    log.general.error({ err: error, actor: operatorId(req) }, '[Payments] operator trace failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not assemble the payment trace', 500);
  }
}

/** `GET /internal/payments/exceptions` — the open queues, filterable. */
export async function listExceptionsHandler(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as PaymentExceptionsQueryInput;
  const limit = query.limit ?? 50;

  try {
    // Inside the try, including `getDb()`. An express handler that throws
    // OUTSIDE one is an unhandled rejection: express never sees it, no response
    // is written, and the caller hangs until its own timeout — which during an
    // incident is the worst possible failure for the surface an operator is
    // using to diagnose the incident.
    const db = getDb();
    const [discrepancies, exceptions] = await Promise.all([
      listDiscrepancies(db, {
        status: query.status ? [query.status] : ['open', 'acknowledged'],
        ...(query.kind ? { kind: [query.kind as PaymentDiscrepancyKind] } : {}),
        ...(query.severity ? { severity: [query.severity] } : {}),
        limit,
      }),
      listPaymentOutboxExceptions(db, {
        eventTypes: EXCEPTION_EVENT_TYPES,
        // Everything not yet delivered: `pending` (still being retried),
        // `processing` (in flight) and `dead_letter` (will not happen without a
        // person). `processed` is excluded because these handlers are
        // announcements — the CONDITION outlives the delivery, and a processed
        // row means an operator was told, not that the money was fixed.
        statuses: ['pending', 'processing', 'dead_letter'],
        limit,
      }),
    ]);

    sendSuccess(res, {
      discrepancies: discrepancies.map(projectDiscrepancy),
      exceptions: exceptions.map(projectException),
    });
  } catch (error: unknown) {
    log.general.error({ err: error, actor: operatorId(req) }, '[Payments] exception queue failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not read the exception queues', 500);
  }
}

/** `POST /internal/payments/events/:id/replay` — re-run a failed event processor. */
export async function replayEventHandler(req: Request, res: Response): Promise<void> {
  // `routeParam` rather than `req.params.id`: Express types a param as
  // `string | string[]`, and every id below is a single value.
  const eventId = routeParam(req, 'id');
  const actor = operatorId(req);

  if (!config.payments.stripe.enabled) {
    sendError(res, ErrorCodes.CONFLICT, 'The card rail is not configured on this deployment', 409);
    return;
  }

  try {
    const { replayProviderEvent } = await import('../services/payments/stripe/event-processor.js');
    const replayed = await replayProviderEvent(eventId);
    log.general.warn({ actor, eventId, replayed }, '[Payments] operator replayed a provider event');
    sendSuccess(res, {
      eventId,
      replayed,
      note: replayed
        ? 'The event was reopened and run again. Its own idempotency is unchanged, so work that ' +
          'had already landed was a no-op.'
        : 'The event was not in a replayable state — already processed, or claimed by a live task.',
    });
  } catch (error: unknown) {
    log.general.error({ err: error, actor, eventId }, '[Payments] event replay failed');
    sendError(res, ErrorCodes.NOT_FOUND, 'That provider event does not exist', 404);
  }
}

/** `POST /internal/payments/refetch` — re-read provider state for one payment. */
export async function refetchPaymentHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as PaymentRefetchInput;
  const actor = operatorId(req);

  if (!config.payments.stripe.enabled) {
    sendError(res, ErrorCodes.CONFLICT, 'The card rail is not configured on this deployment', 409);
    return;
  }

  try {
    const payment = await findPaymentById(getDb(), body.paymentId);
    if (!payment) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No such payment', 404);
      return;
    }

    // The SAME function the sweep runs. An operator asking "what does Stripe
    // actually say" and a sweep asking it must get one answer through one code
    // path, or the answer an incident is resolved on is not the answer the
    // system acts on.
    const outcome = await reconcileOnePayment(payment);
    log.general.warn(
      { actor, paymentId: payment.id, converged: outcome.converged, note: outcome.note },
      '[Payments] operator re-fetched provider state',
    );
    sendSuccess(res, {
      paymentId: payment.id,
      previousStatus: payment.status,
      providerStatus: outcome.providerStatus,
      converged: outcome.converged,
      findings: outcome.findings,
      note: outcome.note,
    });
  } catch (error: unknown) {
    log.general.error(
      { err: error, actor, paymentId: body.paymentId },
      '[Payments] refetch failed',
    );
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not re-read the payment from its rail', 500);
  }
}

/** `POST /internal/payments/repairs` — run one named repair. */
export async function runRepairHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as PaymentRepairInput;
  const actor = operatorId(req);

  try {
    const result = await runRepair(toRepairRequest(body, actor));
    sendSuccess(res, {
      action: result.action,
      outcome: result.outcome,
      note: result.note,
      repairId: result.repairId,
      ledgerTransactionId: result.ledgerTransactionId,
    });
  } catch (error: unknown) {
    if (error instanceof RepairRefusedError) {
      // 409, not 400 and not 500: the request was understood and the STATE
      // refused it. The message is written for an operator and names ids and
      // states only, so it is safe to hand back verbatim — which is the whole
      // point of refusing with a distinct class.
      sendError(res, ErrorCodes.CONFLICT, error.message, 409);
      return;
    }
    log.general.error({ err: error, actor, action: body.action }, '[Payments] repair failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'The repair could not be completed', 500);
  }
}

/** `POST /internal/payments/discrepancies/:id/resolve` — close an investigation. */
export async function resolveDiscrepancyHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as DiscrepancyResolutionInput;
  const actor = operatorId(req);
  const discrepancyId = routeParam(req, 'id');

  try {
    const db = getDb();
    const existing = await findDiscrepancyById(db, discrepancyId);
    if (!existing) {
      sendError(res, ErrorCodes.NOT_FOUND, 'No such discrepancy', 404);
      return;
    }

    const row = await closeDiscrepancy(db, {
      discrepancyId,
      status: body.status,
      actorOxyUserId: actor,
      reason: body.reason,
      ...(body.note ? { note: body.note } : {}),
    });
    if (!row) {
      sendError(res, ErrorCodes.INTERNAL_ERROR, 'The discrepancy could not be updated', 500);
      return;
    }

    log.general.warn(
      { actor, discrepancyId, status: body.status, reason: body.reason, kind: row.kind },
      '[Payments] operator closed a discrepancy',
    );
    const repairs = await listRepairsForDiscrepancy(db, discrepancyId);
    sendSuccess(res, { discrepancy: projectDiscrepancy(row), repairs: repairs.map(projectRepair) });
  } catch (error: unknown) {
    log.general.error({ err: error, actor, discrepancyId }, '[Payments] resolve failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'The discrepancy could not be updated', 500);
  }
}

/** `GET /internal/payments/metrics` — the fuller counts `/health` only summarises. */
export async function paymentMetricsHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await collectPaymentMetrics());
  } catch (error: unknown) {
    log.general.error({ err: error, actor: operatorId(req) }, '[Payments] metrics failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Could not collect payment metrics', 500);
  }
}

/**
 * Turn the validated body into the service's own request shape.
 *
 * The ACTOR is stamped here, from the authenticated caller, and there is no path
 * by which a body could supply it — the same rule the seller payments surface
 * follows for its owner. An audit trail anybody can forge is not one.
 */
function toRepairRequest(body: PaymentRepairInput, actor: string): RepairRequest {
  const base = {
    actorOxyUserId: actor,
    reason: body.reason,
    ...('discrepancyId' in body && body.discrepancyId ? { discrepancyId: body.discrepancyId } : {}),
  };

  if (body.action === 'book_reconciling_entry') {
    return {
      ...base,
      action: body.action,
      discrepancyId: body.discrepancyId,
      currency: body.currency,
      entries: body.entries.map((entry) => ({
        account: entry.account,
        amountMinor: BigInt(entry.amountMinor),
        ...(entry.ownerType ? { ownerType: entry.ownerType } : {}),
        ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
        ...(entry.orderId ? { orderId: entry.orderId } : {}),
      })),
    };
  }
  if (body.action === 'retry_withheld_transfer') {
    return { ...base, action: body.action, paymentId: body.paymentId, orderId: body.orderId };
  }
  if (body.action === 'retry_transfer_reversal') {
    return { ...base, action: body.action, subjectKind: body.subjectKind, subjectId: body.subjectId };
  }
  return { ...base, action: body.action, refundId: body.refundId };
}

/** Resolve whichever handle the operator gave into a trace. */
async function resolveTrace(query: PaymentTraceQueryInput): Promise<PaymentTrace | undefined> {
  if (query.paymentId) return await tracePayment({ byPaymentId: query.paymentId });
  if (query.checkoutGroupId) {
    return await tracePayment({ byCheckoutGroupId: query.checkoutGroupId });
  }
  if (query.orderId) return await tracePayment({ byOrderId: query.orderId });
  if (query.providerObjectId) {
    return await tracePayment({
      byProviderObjectId: { provider: 'stripe', providerObjectId: query.providerObjectId },
    });
  }
  if (query.orderNumber) {
    const order = await findLinkedOrderByNumber(query.orderNumber);
    return order ? await tracePayment({ byOrderId: order.id }) : undefined;
  }
  return undefined;
}

/**
 * The payment, projected.
 *
 * Named fields, never a spread — see the file docblock. The FX rate snapshot is
 * flattened into one object rather than five columns, because that is what makes
 * a conversion reproducible for whoever is reading it.
 */
function projectPayment(row: PaymentRow) {
  return {
    id: row.id,
    checkoutGroupId: row.checkoutGroupId,
    provider: row.provider,
    status: row.status,
    orderId: row.orderId,
    presentment: { amount: row.presentmentAmount, currency: row.presentmentCurrency },
    platform:
      row.platformAmount !== null && row.platformCurrency !== null
        ? { amount: row.platformAmount, currency: row.platformCurrency }
        : null,
    platformRate:
      row.platformRateRate !== null
        ? {
            from: row.platformRateFrom,
            to: row.platformRateTo,
            rate: row.platformRateRate,
            provider: row.platformRateProvider,
            asOf: row.platformRateAsOf,
          }
        : null,
    providerObjectId: row.providerObjectId,
    // The BUYER's Oxy id is a Mercaria-scoped identifier and is what an operator
    // needs to correlate a support conversation. It is not a contact value and
    // cannot be used to reach anybody — which is exactly the line issue #50's
    // privacy boundary 3 draws.
    buyerOxyUserId: row.buyerOxyUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One authorization attempt. `errorMessage` was redacted at the write site. */
function projectAttempt(row: PaymentAttemptRow) {
  return {
    sequence: row.sequence,
    status: row.status,
    providerObjectId: row.providerObjectId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One inbound provider event.
 *
 * `payloadSummary` is deliberately ABSENT even though it was already redacted at
 * ingress. What an operator needs from an event is which object it was about,
 * when it arrived, and what Mercaria did with it — all of which are columns
 * here — and the summary is the one field whose contents are the provider's
 * shape rather than Mercaria's, so it is the field that would quietly grow.
 * `objectIds` is included because correlation is the whole point of a trace.
 */
function projectEvent(row: PaymentProviderEventRow) {
  return {
    id: row.id,
    providerEventId: row.providerEventId,
    type: row.type,
    livemode: row.livemode,
    status: row.status,
    attempts: row.attempts,
    objectIds: row.objectIds,
    processingNote: row.processingNote,
    lastError: row.lastError,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

/** One seller transfer. */
function projectTransfer(row: TransferRow) {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    amount: { amount: row.amountAmount, currency: row.amountCurrency },
    reversedAmount: row.reversedAmount,
    providerObjectId: row.providerObjectId,
    /**
     * When a high-value hold on this transfer ends, or `null` when none is in
     * force. Projected because `status: 'pending'` with no provider object is
     * the SAME shape for a hold, a seller whose account lapsed and a rail that
     * refused — and only this field tells an operator which, without making
     * them go and read the outbox exception.
     */
    heldUntil: row.heldUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One payout, with the caveat `PaymentTrace.payouts` states. */
function projectPayout(row: PayoutRow) {
  return {
    id: row.id,
    providerObjectId: row.providerObjectId,
    status: row.status,
    amount: { amount: row.amountAmount, currency: row.amountCurrency },
    failureCode: row.failureCode,
    arrivalAt: row.arrivalAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One refund, with the fields the MERCHANT surface deliberately withholds.
 *
 * #49 keeps `providerRefundId`, `providerReversalId`, `reversalState` and the
 * reversal amount off `Refund` on purpose — a merchant needs to know whether
 * their buyer has been paid, and whether Mercaria has finished clawing the
 * seller's share back off a connected account is a reconciliation question. This
 * is where that question is answered, which is what #49 meant by "belongs to the
 * payment trace (#50)".
 */
function projectRefund(row: PaymentTrace['refunds'][number]) {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    provider: row.provider,
    providerState: row.providerState,
    providerRefundId: row.providerRefundId,
    providerFailureCode: row.providerFailureCode,
    reversalState: row.reversalState,
    providerReversalId: row.providerReversalId,
    reversalAmount:
      row.reversalAmountAmount !== null && row.reversalAmountCurrency !== null
        ? { amount: row.reversalAmountAmount, currency: row.reversalAmountCurrency }
        : null,
    totalRefunded: {
      amount: row.totalRefundedPresentmentAmount,
      currency: row.totalRefundedPresentmentCurrency,
    },
    createdAt: row.createdAt.toISOString(),
  };
}

/** One dispute. */
function projectDispute(row: PaymentTrace['disputes'][number]) {
  return {
    id: row.id,
    providerDisputeId: row.providerDisputeId,
    orderId: row.orderId,
    status: row.status,
    outcome: row.outcome,
    reason: row.reason,
    amount: { amount: row.amountAmount, currency: row.amountCurrency },
    feeAmount: row.feeAmount,
    evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
    openedBookedAt: row.openedBookedAt?.toISOString() ?? null,
    recoveryState: row.recoveryState,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** One discrepancy. `detail` was composed from Mercaria's own figures. */
function projectDiscrepancy(row: PaymentDiscrepancyRow) {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    provider: row.provider,
    correlationKey: row.correlationKey,
    paymentId: row.paymentId,
    orderId: row.orderId,
    checkoutGroupId: row.checkoutGroupId,
    providerObjectId: row.providerObjectId,
    detail: row.detail,
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedReason: row.resolvedReason,
    resolutionNote: row.resolutionNote,
  };
}

/** One repair attempt, applied or refused. */
function projectRepair(row: PaymentRepairRow) {
  return {
    id: row.id,
    action: row.action,
    subjectKey: row.subjectKey,
    discrepancyId: row.discrepancyId,
    actorOxyUserId: row.actorOxyUserId,
    reason: row.reason,
    outcome: row.outcome,
    detail: row.detail,
    paymentId: row.paymentId,
    orderId: row.orderId,
    ledgerTransactionId: row.ledgerTransactionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One outbox exception.
 *
 * `payload` is included and is safe to be: an outbox payload is deliberately
 * MINIMAL — ids and Mercaria's own state, never a provider payload, a contact
 * value or a secret (#45 API and events 6 and 8) — which is the property that
 * lets this surface render it whole rather than field by field.
 */
function projectException(row: PaymentOutboxRow) {
  return {
    id: row.id,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    payload: row.payload,
    lastError: row.lastError,
    availableAt: row.availableAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
