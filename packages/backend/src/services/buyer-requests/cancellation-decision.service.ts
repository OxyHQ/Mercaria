/**
 * The SELLER half of a cancellation — deciding one and completing it (#110).
 *
 * This is the file that may touch an order, and the ONE in the cancellation
 * path that imports `order.service`. The buyer half next door imports none of
 * it, so "a buyer files a request and a seller acts" is visible in the import
 * graph rather than only in prose — and the isolation gate asserts both
 * directions.
 *
 * ## Acceptance and completion are separate, and the split is rule 2
 *
 * "A request does not mark the order cancelled before payment, inventory and
 * seller rules complete." So accepting stamps a DECISION and then attempts the
 * completion; a completion that fails leaves the request `accepted` with a
 * bounded failure code, and the retry is {@link completeCancellationRequest} —
 * the same idempotent call, which is why there is no `failed` state to climb
 * out of.
 *
 * ## Completion drives services that already exist, and adds no third way
 *
 * `release` is `order.service.transition(order, 'cancelled')`, which releases
 * the reservation exactly as a buyer's own cancel does. `refund` is the refund
 * bridge, which is `refund.service.process`, which restocks per line and moves
 * the order itself. Neither path writes an order column here, and neither
 * touches inventory here. #110 cancellation rule 4 verbatim.
 */

import type { BuyerRequestCompletionFailure, RefundLineInput } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  findCancellationRequestById,
  listCancellationRequestLines,
  recordCancellationCompletionFailure,
  setCancellationLineApproved,
  transitionCancellationRequest,
} from '../../db/buyerRequests/cancellationRepository.js';
import { recordBuyerRequestEvent } from '../../db/buyerRequests/eventRepository.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { findRefundByIdempotencyKey } from '../../db/orders/refundRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { transition } from '../order.service.js';
import { actorAuditColumns, type BuyerRequestDecider } from './authorization.js';
import { notifyCancellationDecided } from './notifications.js';
import { resolveCancellationEligibility } from './policy.js';
import {
  buyerRequestRefundKey,
  orderHasRefundPath,
  refundForBuyerRequest,
} from './refund-bridge.js';
import {
  getCancellationRequest,
  type CancellationRequestWithLines,
} from './cancellation-request.service.js';
import { loadBuyerRequestOrder } from './order-facts.js';

/** What a seller sends when they answer a request. */
export interface CancellationDecisionInput {
  decision: 'accept' | 'reject';
  /** Mandatory on a rejection — #110 cancellation rule 8. */
  note?: string;
  /** Per-line agreed quantities. Omit to agree to everything requested. */
  lines?: { variantId: string; quantity: number }[];
}

/**
 * Answer a cancellation request.
 *
 * The decision and its audit commit in ONE transaction, and the COMPLETION runs
 * after — separately and best-effort. That order matters: a completion that
 * fails must leave a recorded decision behind, because a seller who pressed
 * accept and got a 500 will press it again, and the second press has to find a
 * request that already says somebody agreed.
 */
export async function decideCancellationRequest(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  body: CancellationDecisionInput;
  now: Date;
}): Promise<CancellationRequestWithLines> {
  const existing = await findCancellationRequestById(input.requestId);
  if (!existing) throw notFound('Cancellation request not found');

  // Idempotent on a repeat of the SAME decision: a seller whose click timed out
  // gets the request they already decided rather than a 409 about their own
  // earlier press.
  if (existing.state !== 'submitted') {
    if (input.body.decision === 'reject' && existing.state === 'rejected') {
      return getCancellationRequest(input.requestId);
    }
    if (input.body.decision === 'accept' && existing.state !== 'rejected') {
      // `accepted` or `completed` — re-drive the completion, which is
      // idempotent, so a retry after a failed completion is the same call.
      return completeCancellationRequest({
        requestId: input.requestId,
        decider: input.decider,
        now: input.now,
      });
    }
    throw conflict('This request has already been decided');
  }

  if (input.body.decision === 'reject' && (input.body.note ?? '').trim().length < 3) {
    throw validationError('A rejection must say why');
  }

  const requestedLines = await listCancellationRequestLines(input.requestId);
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
    const row = await transitionCancellationRequest(tx, {
      id: input.requestId,
      from: 'submitted',
      to: accepted ? 'accepted' : 'rejected',
      decidedByActorKind: input.decider.kind,
      decidedByOxyUserId: input.decider.oxyUserId,
      decidedAt: input.now,
      ...(input.body.note === undefined ? {} : { decisionNote: input.body.note }),
    });
    if (!row) return false;
    // Whatever the seller did NOT narrow is agreed in full, written explicitly
    // rather than left NULL: the completion reads only `approved_quantity`, so
    // an unwritten one would refund nothing and look like a seller's choice.
    for (const line of requestedLines) {
      const narrowed = input.body.lines?.find((entry) => entry.variantId === line.variantId);
      await setCancellationLineApproved(
        tx,
        input.requestId,
        line.variantId,
        accepted ? (narrowed?.quantity ?? line.requestedQuantity) : 0,
      );
    }
    await recordBuyerRequestEvent(tx, {
      cancellationRequestId: input.requestId,
      kind: accepted ? 'accepted' : 'rejected',
      ...actorAuditColumns(input.decider),
      at: input.now,
    });
    return true;
  });
  if (!moved) throw conflict('This request was concurrently decided');

  const order = await findOrderById(existing.orderId);
  if (order) notifyCancellationDecided(order, input.requestId, accepted);

  if (!accepted) return getCancellationRequest(input.requestId);
  return completeCancellationRequest({
    requestId: input.requestId,
    decider: input.decider,
    now: input.now,
  });
}

/**
 * Actually undo the order. IDEMPOTENT, and the retry path for a failed
 * completion.
 *
 * The mode is RE-DERIVED from the order's live payment state rather than read
 * off the request, because the two can legitimately differ: a buyer asks while
 * a payment is still verifying and it verifies a second later, and completing
 * in `release` mode then would release a reservation on money that has already
 * been taken. The snapshot on the request survives as what the buyer was told.
 */
export async function completeCancellationRequest(input: {
  requestId: string;
  decider: BuyerRequestDecider;
  now: Date;
}): Promise<CancellationRequestWithLines> {
  const request = await findCancellationRequestById(input.requestId);
  if (!request) throw notFound('Cancellation request not found');
  if (request.state === 'completed') return getCancellationRequest(input.requestId);
  if (request.state !== 'accepted') throw conflict('This request has not been accepted');

  const context = await loadBuyerRequestOrder(request.orderId);
  if (!context) throw notFound('Order not found');

  const failure = await runCompletion({
    context,
    requestId: input.requestId,
    decider: input.decider,
  });

  if (failure !== null) {
    await getDb().transaction(async (tx) => {
      await recordCancellationCompletionFailure(tx, input.requestId, failure);
      await recordBuyerRequestEvent(tx, {
        cancellationRequestId: input.requestId,
        kind: 'completion_failed',
        ...actorAuditColumns(input.decider),
        detail: failure,
        at: input.now,
      });
    });
    // NOT a throw. The decision stands, the request is visibly owed, and the
    // seller's next press is the same idempotent call — answering 500 here
    // would hide a recorded state behind an error page.
    return getCancellationRequest(input.requestId);
  }

  const refundId = await findCompletionRefundId(input.requestId);
  await getDb().transaction(async (tx) => {
    await transitionCancellationRequest(tx, {
      id: input.requestId,
      from: 'accepted',
      to: 'completed',
      completedAt: input.now,
      completionFailure: null,
      ...(refundId === null ? {} : { refundId }),
    });
    await recordBuyerRequestEvent(tx, {
      cancellationRequestId: input.requestId,
      kind: 'completed',
      ...actorAuditColumns(input.decider),
      at: input.now,
    });
  });
  return getCancellationRequest(input.requestId);
}

/**
 * The refund a completed cancellation produced, if it produced one.
 *
 * Found by the deterministic key rather than returned from the completion, so a
 * RETRY that converged on an existing refund records the same id the first
 * attempt would have. A `release`-mode cancellation has none, and `null` is the
 * right answer rather than an invented reference.
 */
async function findCompletionRefundId(requestId: string): Promise<string | null> {
  const refund = await findRefundByIdempotencyKey(buyerRequestRefundKey(requestId));
  return refund?.id ?? null;
}

/**
 * Run the mode's own completion. Returns a bounded failure, or `null`.
 *
 * Never throws for anything a seller could have caused — a concurrent
 * transition, a rail refusal, a moderation hold — because each of those is a
 * fact to record on the request rather than an error to surface. A genuinely
 * unexpected failure is logged and reported as `unexpected_error`, which is
 * retryable and visible, rather than swallowed.
 */
async function runCompletion(input: {
  context: Awaited<ReturnType<typeof loadBuyerRequestOrder>>;
  requestId: string;
  decider: BuyerRequestDecider;
}): Promise<BuyerRequestCompletionFailure | null> {
  const context = input.context;
  if (!context) return 'order_state_changed';

  // The order may have moved since the decision. Re-deriving eligibility is
  // what stops an accepted request cancelling an order a seller shipped in the
  // meantime.
  const eligibility = resolveCancellationEligibility(context.policy);
  if (eligibility.verdict === 'ineligible') {
    // An order that is ALREADY closed is the outcome the buyer asked for, so
    // the completion succeeds rather than reporting a failure nobody can act
    // on — a second decider, a sweep and a merchant's own cancel all converge
    // here.
    return eligibility.reason === 'order_already_closed' ? null : 'order_state_changed';
  }

  try {
    if (eligibility.mode === 'release') {
      await transition(context.order, 'cancelled', {
        actor: { kind: input.decider.kind, oxyUserId: input.decider.oxyUserId },
        note: 'cancellation request accepted',
      });
      return null;
    }

    if (!orderHasRefundPath(context.order)) return 'refund_path_unavailable';

    const lines = await listCancellationRequestLines(input.requestId);
    // A whole-order cancellation refunds every line in full; a partial one
    // refunds exactly what the seller approved. `restock: true` on both, because
    // the goods never left — which is the difference between a cancellation and
    // a return, where the goods have to come back first.
    const refundLines: RefundLineInput[] =
      lines.length === 0
        ? context.order.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            restock: true,
            ...(item.locationId === null ? {} : { locationId: item.locationId }),
          }))
        : lines
            .filter((line) => (line.approvedQuantity ?? 0) > 0)
            .map((line) => ({
              variantId: line.variantId,
              quantity: line.approvedQuantity ?? 0,
              restock: true,
            }));

    const result = await refundForBuyerRequest({
      order: context.order,
      requestId: input.requestId,
      lines: refundLines,
      reason: 'Cancellation requested by the buyer',
      // A cancelled order was never shipped, so the buyer gets the delivery
      // charge back too. A RETURN does not — see the return decision service.
      refundShipping: true,
      actorOxyUserId: input.decider.oxyUserId,
    });
    return result.outcome === 'refunded' ? null : result.failure;
  } catch (err: unknown) {
    log.general.error(
      { err, requestId: input.requestId },
      '[BuyerRequests] cancellation completion failed unexpectedly',
    );
    return 'unexpected_error';
  }
}
