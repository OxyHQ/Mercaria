/**
 * The SELLER half of a return — deciding, instructing, receiving, refunding
 * (#110).
 *
 * The only module in the return path that may touch money, and it does so
 * through the same bridge the cancellation path uses, which is
 * `refund.service.process`, which restocks per line and moves the order. There
 * is no second way to refund in this domain and no way at all to restock.
 *
 * ## Restock happens exactly once, and it happens when the GOODS come back
 *
 * A cancellation refunds and restocks immediately, because the goods never
 * left. A return cannot: refunding at APPROVAL would put units back on the
 * shelf that are still in a parcel, and `refund.service` is the only thing that
 * restocks, so the refund must wait for `received`. That is the whole reason
 * `received` is a state rather than a flag — #110 refund rule 5, "restock only
 * approved quantities and exactly once", with the timing made structural.
 *
 * ## `refund_pending` versus `completed`
 *
 * ADR 0001 D7: the commerce record commits before the rail is called, so the
 * refund exists and the money may still be moving. The return sits in
 * `refund_pending` until the refund row says the rail settled — read from
 * `refunds.provider_state`, which is what verified provider events write (#49),
 * so "verified provider events remain authoritative for provider completion"
 * (#110 refund rule 4) is satisfied by reading their output rather than by
 * subscribing to them.
 */

import type { BuyerRequestCompletionFailure, RefundLineInput } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { recordBuyerRequestEvent } from '../../db/buyerRequests/eventRepository.js';
import {
  findReturnRequestById,
  listReturnRequestLines,
  recordReturnCompletionFailure,
  setReturnLineApproved,
  transitionReturnRequest,
} from '../../db/buyerRequests/returnRepository.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { findRefundByIdempotencyKey } from '../../db/orders/refundRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { actorAuditColumns, type BuyerRequestDecider } from './authorization.js';
import {
  notifyActionRequired,
  notifyRefundCompleted,
  notifyRefundFailed,
  notifyRefundPending,
  notifyReturnUpdated,
} from './notifications.js';
import { loadBuyerRequestOrder } from './order-facts.js';
import {
  buyerRequestRefundKey,
  orderHasRefundPath,
  refundForBuyerRequest,
  settlementOf,
} from './refund-bridge.js';
import { getReturnRequest, type ReturnRequestWithDetail } from './return-request.service.js';

/** What a seller sends when they answer a return. */
export interface ReturnDecisionInput {
  decision: 'accept' | 'reject';
  note?: string;
  lines?: { variantId: string; quantity: number }[];
}

/** Answer a return request. `approved` or `rejected`; nothing moves either way. */
export async function decideReturnRequest(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  body: ReturnDecisionInput;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state !== 'requested') {
    // A repeat of the SAME decision converges; anything else is a real
    // conflict. The seller who clicked twice gets their own answer back.
    const already =
      (input.body.decision === 'accept' && existing.state === 'approved') ||
      (input.body.decision === 'reject' && existing.state === 'rejected');
    if (already) return getReturnRequest(input.requestId);
    throw conflict('This request has already been decided');
  }

  if (input.body.decision === 'reject' && (input.body.note ?? '').trim().length < 3) {
    throw validationError('A rejection must say why');
  }

  const requestedLines = await listReturnRequestLines(input.requestId);
  if (input.body.lines !== undefined) {
    const requested = new Map(requestedLines.map((line) => [line.variantId, line]));
    for (const line of input.body.lines) {
      const match = requested.get(line.variantId);
      if (!match) throw validationError('An approved line was not requested');
      if (line.quantity < 0 || line.quantity > match.requestedQuantity) {
        throw validationError('An approved quantity is more than was requested');
      }
    }
  }

  const accepted = input.body.decision === 'accept';
  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionReturnRequest(tx, {
      id: input.requestId,
      from: 'requested',
      to: accepted ? 'approved' : 'rejected',
      decidedByActorKind: input.decider.kind,
      decidedByOxyUserId: input.decider.oxyUserId,
      decidedAt: input.now,
      ...(input.body.note === undefined ? {} : { decisionNote: input.body.note }),
    });
    if (!row) return false;
    for (const line of requestedLines) {
      const narrowed = input.body.lines?.find((entry) => entry.variantId === line.variantId);
      await setReturnLineApproved(
        tx,
        input.requestId,
        line.variantId,
        accepted ? (narrowed?.quantity ?? line.requestedQuantity) : 0,
      );
    }
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: accepted ? 'accepted' : 'rejected',
      ...actorAuditColumns(input.decider),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This request was concurrently decided');

  const order = await findOrderById(existing.orderId);
  if (order) notifyReturnUpdated(order, input.requestId, accepted ? 'approved' : 'rejected');
  return getReturnRequest(input.requestId);
}

/**
 * Issue the seller's own return instructions.
 *
 * Mercaria composes NOTHING here — no label, no carrier, no drop-off point, no
 * address. #110 says return shipping is "owned by the relevant fulfilment
 * system" and forbids building one in this issue; Moovo owns that and has not
 * landed, so the honest shape is the seller's words plus an optional deadline.
 */
export async function issueReturnInstructions(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  instructions: string;
  shipBackDeadlineAt?: Date;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state === 'awaiting_item') return getReturnRequest(input.requestId);
  if (existing.state !== 'approved') throw conflict('This return is not awaiting instructions');
  if (input.instructions.trim().length < 3) {
    throw validationError('Return instructions are required');
  }

  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionReturnRequest(tx, {
      id: input.requestId,
      from: 'approved',
      to: 'awaiting_item',
      returnInstructions: input.instructions,
      ...(input.shipBackDeadlineAt === undefined
        ? {}
        : { shipBackDeadlineAt: input.shipBackDeadlineAt }),
    });
    if (!row) return false;
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: 'instructions_issued',
      ...actorAuditColumns(input.decider),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This return was concurrently updated');

  const order = await findOrderById(existing.orderId);
  if (order) {
    notifyReturnUpdated(order, input.requestId, 'awaiting_item');
    // The ship-back deadline is the only one in this domain a buyer can miss,
    // so it gets #110 communication item 10's own message rather than being
    // buried in the update.
    if (input.shipBackDeadlineAt !== undefined) notifyActionRequired(order, input.requestId);
  }
  return getReturnRequest(input.requestId);
}

/**
 * The seller has the goods.
 *
 * Reachable from `approved` as well as `awaiting_item`, because a seller who
 * simply took the parcel back without writing formal instructions has still
 * received it — and refusing to record that would leave a real return stuck in
 * a state whose only exit is paperwork.
 */
export async function markReturnReceived(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state === 'received') return getReturnRequest(input.requestId);
  if (existing.state !== 'approved' && existing.state !== 'awaiting_item') {
    throw conflict('This return cannot be marked received');
  }

  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionReturnRequest(tx, {
      id: input.requestId,
      from: existing.state,
      to: 'received',
      receivedAt: input.now,
    });
    if (!row) return false;
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: 'item_received',
      ...actorAuditColumns(input.decider),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This return was concurrently updated');

  const order = await findOrderById(existing.orderId);
  if (order) notifyReturnUpdated(order, input.requestId, 'received');
  return getReturnRequest(input.requestId);
}

/**
 * Refund the return. IDEMPOTENT, and the retry path for a failed attempt.
 *
 * The refund's idempotency key is derived from the REQUEST, so a second press,
 * an operator retry and a redelivered job converge on one refund row — and
 * `refund.service` short-circuits on that key before touching inventory, which
 * is what makes "cannot double-restock" true rather than merely likely.
 */
export async function refundReturnRequest(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state === 'completed') return getReturnRequest(input.requestId);
  if (existing.state !== 'received' && existing.state !== 'refund_pending') {
    throw conflict('This return has not been received');
  }

  const context = await loadBuyerRequestOrder(existing.orderId);
  if (!context) throw notFound('Order not found');

  const failure = await runRefund({
    context,
    requestId: input.requestId,
    decider: input.decider,
  });
  if (failure !== null) {
    await getDb().transaction(async (tx) => {
      await recordReturnCompletionFailure(tx, input.requestId, failure);
      await recordBuyerRequestEvent(tx, {
        returnRequestId: input.requestId,
        kind: 'completion_failed',
        ...actorAuditColumns(input.decider),
        detail: failure,
        at: input.now,
      });
    });
    const order = await findOrderById(existing.orderId);
    if (order) notifyRefundFailed(order, input.requestId);
    return getReturnRequest(input.requestId);
  }

  const refund = await findRefundByIdempotencyKey(buyerRequestRefundKey(input.requestId));
  if (!refund) throw conflict('The refund did not commit');

  if (existing.state === 'received') {
    await getDb().transaction(async (tx) => {
      await transitionReturnRequest(tx, {
        id: input.requestId,
        from: 'received',
        to: 'refund_pending',
        refundId: refund.id,
        completionFailure: null,
      });
      await recordBuyerRequestEvent(tx, {
        returnRequestId: input.requestId,
        kind: 'refund_committed',
        ...actorAuditColumns(input.decider),
        at: input.now,
      });
    });
    const order = await findOrderById(existing.orderId);
    if (order) notifyRefundPending(order, input.requestId);
  }

  // `refund.service` drains the provider outbox inline, so the rail has usually
  // answered by now and the return completes in the same call. When it has not,
  // the sweep below finishes the job.
  return reconcileReturnRefund({ requestId: input.requestId, now: input.now });
}

/**
 * Advance a `refund_pending` return once the rail has answered.
 *
 * Reads `refunds.provider_state` — what #49's verified provider events write —
 * rather than subscribing to those events, because the dependency has to point
 * this way: the payment domain must not learn about buyer requests, and a hook
 * from `refund-execution.service` into this one would invert the seam that
 * keeps the money path free of every domain built on top of it.
 *
 * Idempotent and safe to call from anywhere: the transition is a
 * compare-and-swap, so a sweep racing the inline call produces one completion.
 */
export async function reconcileReturnRefund(input: {
  requestId: string;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state !== 'refund_pending' || existing.refundId === null) {
    return getReturnRequest(input.requestId);
  }

  const state = await settlementOf(existing.refundId);
  const order = await findOrderById(existing.orderId);

  if (state.failed) {
    // The rail said the money did NOT go. The commerce record stands and the
    // stock is back — #49 books that gap for an operator (`refund_failed`) and
    // this records it on the request so the buyer's portal stops claiming a
    // refund is on its way. The return stays `refund_pending`, which is
    // retryable, rather than moving to a terminal state that would be a lie.
    await getDb().transaction(async (tx) => {
      await recordReturnCompletionFailure(tx, input.requestId, 'refund_refused');
      await recordBuyerRequestEvent(tx, {
        returnRequestId: input.requestId,
        kind: 'completion_failed',
        actorKind: 'system',
        detail: 'refund_refused',
        at: input.now,
      });
    });
    if (order) notifyRefundFailed(order, input.requestId);
    return getReturnRequest(input.requestId);
  }

  if (!state.settled) return getReturnRequest(input.requestId);

  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionReturnRequest(tx, {
      id: input.requestId,
      from: 'refund_pending',
      to: 'completed',
      completedAt: input.now,
      completionFailure: null,
    });
    if (!row) return false;
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: 'refund_settled',
      actorKind: 'system',
      at: input.now,
    });
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: 'completed',
      actorKind: 'system',
      at: input.now,
    });
    return true;
  });
  if (moved && order) notifyRefundCompleted(order, input.requestId);
  return getReturnRequest(input.requestId);
}

/**
 * Terminate an approved return.
 *
 * Distinct from the buyer's `withdrawn` because the actors are different and a
 * reader has to be able to tell "the buyer changed their mind" from "the seller
 * called it off". Nothing is refunded and nothing is restocked — a return that
 * never arrived leaves the original sale exactly as it was.
 */
export async function cancelReturnRequest(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  note: string;
  now: Date;
}): Promise<ReturnRequestWithDetail> {
  const existing = await findReturnRequestById(input.requestId);
  if (!existing) throw notFound('Return request not found');
  if (existing.state === 'cancelled') return getReturnRequest(input.requestId);
  if (
    existing.state !== 'approved' &&
    existing.state !== 'awaiting_item' &&
    existing.state !== 'received'
  ) {
    throw conflict('This return cannot be cancelled');
  }
  if (input.note.trim().length < 3) throw validationError('Say why the return was cancelled');

  const moved = await getDb().transaction(async (tx) => {
    const row = await transitionReturnRequest(tx, {
      id: input.requestId,
      from: existing.state,
      to: 'cancelled',
      decisionNote: input.note,
    });
    if (!row) return false;
    await recordBuyerRequestEvent(tx, {
      returnRequestId: input.requestId,
      kind: 'cancelled',
      ...actorAuditColumns(input.decider),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This return was concurrently updated');

  const order = await findOrderById(existing.orderId);
  if (order) notifyReturnUpdated(order, input.requestId, 'cancelled');
  return getReturnRequest(input.requestId);
}

/** Commit the refund for a received return, or report a bounded failure. */
async function runRefund(input: {
  context: NonNullable<Awaited<ReturnType<typeof loadBuyerRequestOrder>>>;
  requestId: string;
  decider: BuyerRequestDecider;
}): Promise<BuyerRequestCompletionFailure | null> {
  if (!orderHasRefundPath(input.context.order)) return 'refund_path_unavailable';

  const lines = await listReturnRequestLines(input.requestId);
  const refundLines: RefundLineInput[] = lines
    .filter((line) => (line.approvedQuantity ?? 0) > 0)
    .map((line) => ({
      variantId: line.variantId,
      quantity: line.approvedQuantity ?? 0,
      // The goods are physically back, which is the whole reason the refund
      // waited for `received` — so they go back on the shelf, exactly once,
      // through the only function in Mercaria that may put them there.
      restock: true,
    }));
  if (refundLines.length === 0) return 'refund_refused';

  try {
    const result = await refundForBuyerRequest({
      order: input.context.order,
      requestId: input.requestId,
      lines: refundLines,
      reason: 'Return accepted by the seller',
      // A return does NOT refund delivery: the parcel was carried, the service
      // was performed, and refunding it would be a policy decision nobody has
      // taken. A seller who wants to can issue a further refund from their own
      // dashboard, which is where a discretionary gesture belongs.
      refundShipping: false,
      actorOxyUserId: input.decider.oxyUserId,
    });
    return result.outcome === 'refunded' ? null : result.failure;
  } catch (err: unknown) {
    log.general.error(
      { err, requestId: input.requestId },
      '[BuyerRequests] return refund failed unexpectedly',
    );
    return 'unexpected_error';
  }
}
