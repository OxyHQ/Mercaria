/**
 * Mercaria deciding a customer's request, and driving what it decided (#127
 * responsibility rules 2–5, cancellation and return orchestration).
 *
 * This is the module that MAY reach the money and the supplier, and the only
 * one — `retail-service-isolation.test.ts` asserts both halves: the buyer-side
 * services import none of it, and this one genuinely imports the refund bridge
 * and the supplier RMA port, so the gate cannot pass by those having been
 * renamed out of existence.
 *
 * ## The ORDER of a decision is the whole design
 *
 * 1. Record the customer decision.
 * 2. Commit the customer's REFUND (or the cancellation's), on Mercaria's
 *    timeline.
 * 3. Open the supplier-side recovery, afterwards and best-effort.
 *
 * ADR 0004 D8.5 and #127 responsibility rules 4 and 5 are that order. A supplier
 * asked FIRST would make the buyer's remedy wait on an answer that may never
 * come; a supplier asked at all in step 2's transaction would make a refund
 * fail because a warehouse's API was down.
 *
 * ## `accepted` is not `completed`, and there is no `failed`
 *
 * Acceptance is Mercaria's DECISION; completion is the world having changed, and
 * the step between them can fail. A completion that did not complete leaves the
 * request `in_progress` with a bounded `completion_failure` beside it, and the
 * retry is the SAME idempotent call — the `payment_repairs` posture #110 already
 * adopted.
 */

import type {
  RetailCustomerOutcome,
  RetailReturnDestination,
  RetailServiceCompletionFailure,
} from '@mercaria/shared-types';
import { REFUNDING_RETAIL_CUSTOMER_OUTCOMES } from '@mercaria/shared-types';
import {
  appendRetailServiceEvent,
  approveRetailServiceRequestLines,
  findRetailServiceRequest,
  transitionRetailServiceRequest,
  type RetailServiceRequestRecord,
} from '../../db/retailServiceRequests/requestRepository.js';
import { insertRetailReturnCase } from '../../db/retailServiceRequests/returnCaseRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { composeRetailRefundAllocation } from './allocation.js';
import { retailDeciderAudit, type RetailServiceDecider } from './authorization.js';
import { retailOutcomeIsDeliverable } from './eligibility.js';
import { loadRetailServiceOrder, readRetailRefundBasis } from './order-facts.js';
import {
  notifyRetailCancellationUpdated,
  notifyRetailRefundPending,
  notifyRetailRequestClosed,
  notifyRetailReturnAuthorized,
} from './notifications.js';
import { commitRetailServiceRefund } from './refund-bridge.js';
import { retailRequestPolicy } from './request-kinds.js';
import { openRetailWarrantyCase } from './warranty.service.js';

/** What Mercaria records when it decides. */
export interface DecideRetailRequestInput {
  requestId: string;
  accept: boolean;
  outcome: RetailCustomerOutcome;
  outcomeNote?: string;
  /** Per line, what Mercaria approved. Absent means "everything requested". */
  approvedQuantities?: ReadonlyMap<string, number>;
  /** Where the goods go, on a kind that opens a return case. */
  returnDestination?: RetailReturnDestination;
}

/**
 * Decide one request.
 *
 * A compare-and-swap over the open states, so two operators pressing at once
 * produce ONE decision and the loser is told the request moved.
 */
export async function decideRetailServiceRequest(
  decider: RetailServiceDecider,
  input: DecideRetailRequestInput,
  now: Date,
): Promise<RetailServiceRequestRecord> {
  const record = await findRetailServiceRequest(input.requestId);
  if (!record) throw notFound('Request not found');

  if (input.accept && !retailOutcomeIsDeliverable(input.outcome)) {
    // The refusal names the outcome rather than saying "unsupported", and it
    // happens HERE rather than at completion — nobody is told "yes, a
    // replacement" and then "actually a refund" a week later. See
    // `SUPPORTED_RETAIL_CUSTOMER_OUTCOMES` for why the three that are missing
    // are missing.
    throw conflict(
      `Mercaria cannot deliver a ${input.outcome} for this order. A replacement, a repair ` +
        'and a redelivery each need a second purchase order against the same order and the ' +
        'same supplier, which #124’s idempotency key makes unrepresentable. Decide a ' +
        'refund-shaped outcome instead.',
    );
  }

  const moved = await transitionRetailServiceRequest({
    id: input.requestId,
    from: ['submitted', 'evidence_required'],
    to: input.accept ? 'accepted' : 'rejected',
    outcome: input.outcome,
    ...(input.outcomeNote === undefined ? {} : { outcomeNote: input.outcomeNote }),
    deciderKind: decider.kind,
    ...(decider.oxyUserId === undefined ? {} : { deciderOxyUserId: decider.oxyUserId }),
    decidedAt: now,
    ...(input.accept ? {} : { completedAt: now }),
  });
  if (!moved) throw conflict('This request has already been decided.');

  if (input.approvedQuantities !== undefined) {
    await approveRetailServiceRequestLines(input.requestId, input.approvedQuantities);
  } else {
    await approveRetailServiceRequestLines(
      input.requestId,
      new Map(record.lines.map((line) => [line.orderItemId, line.requestedQuantity])),
    );
  }

  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: input.accept ? 'request_accepted' : 'request_rejected',
    resultingState: input.accept ? 'accepted' : 'rejected',
    ...retailDeciderAudit(decider),
    ...(input.outcomeNote === undefined ? {} : { detail: input.outcomeNote }),
  });

  const context = await loadRetailServiceOrder(record.orderId);
  if (context === null) throw notFound('Order not found');

  if (!input.accept) {
    // A rejection produces a MESSAGE. A buyer told no can act on it; one told
    // nothing opens a second request. #127 communication item 12.
    notifyRetailRequestClosed(context.order, input.requestId, 'rejected');
    const rejected = await findRetailServiceRequest(input.requestId);
    if (!rejected) throw notFound('Request not found');
    return rejected;
  }

  const policy = retailRequestPolicy(record.kind);
  if (policy.opensReturnCase) {
    // The destination is MERCARIA's decision (#127 return rule 2) and defaults
    // to the supplier, which is where dropshipped goods physically are. The
    // buyer never learns it — the customer view has no destination member.
    const returnCase = await insertRetailReturnCase({
      requestId: input.requestId,
      destination: input.returnDestination ?? 'supplier',
      // `authorization_unavailable` is the shipped state and the honest one: no
      // adapter declares `return_authorization`, so no RMA can be obtained and
      // pretending otherwise would send a buyer's parcel to a warehouse
      // expecting nothing. `return-case.service.ts` asks anyway, and moves the
      // case if an answer ever arrives.
      state: 'authorization_pending',
      instructionsKey: 'retail.return.instructions.v1',
      shipBackDeadlineAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      lines: record.lines.map((line) => ({
        orderItemId: line.orderItemId,
        authorizedQuantity: input.approvedQuantities?.get(line.orderItemId) ?? line.requestedQuantity,
      })),
    });
    await appendRetailServiceEvent({
      requestId: input.requestId,
      kind: 'return_case_opened',
      ...retailDeciderAudit(decider),
      detail: returnCase.id,
    });
    notifyRetailReturnAuthorized(context.order, input.requestId);
  }

  if (policy.opensWarrantyCase) {
    await openRetailWarrantyCase(decider, {
      requestId: input.requestId,
      orderId: record.orderId,
      terms: context.terms,
      market: context.market,
      reportedAt: now,
    });
  }

  if (policy.window === 'cancellation') {
    notifyRetailCancellationUpdated(context.order, input.requestId, 'accepted');
  }

  const accepted = await findRetailServiceRequest(input.requestId);
  if (!accepted) throw notFound('Request not found');
  return accepted;
}

/**
 * Drive an accepted request's customer outcome — the money.
 *
 * IDEMPOTENT: the refund's key is derived from the request, so an operator
 * retry, a redelivered job and a second press converge on one refund. That is
 * what makes this safe to call from the operator surface, from the return
 * receipt path and from the reconciler without any of them coordinating.
 *
 * ## A return refunds on RECEIPT, a cancellation refunds immediately
 *
 * #127 return rule 9 permits customer refund timing to be separate from supplier
 * inspection *"when law or policy requires earlier action"* — and it does: EU
 * withdrawal requires reimbursement within 14 days of being told, at the latest
 * when the goods come back or proof of return is supplied. So the trigger is the
 * buyer's SHIPMENT evidence rather than the supplier's inspection, which is a
 * fact about the buyer rather than about a warehouse. `return-case.service.ts`
 * calls this when the units are marked shipped; a cancellation calls it here.
 */
export async function completeRetailServiceRequest(
  decider: RetailServiceDecider,
  requestId: string,
  now: Date,
): Promise<RetailServiceRequestRecord> {
  const record = await findRetailServiceRequest(requestId);
  if (!record) throw notFound('Request not found');
  if (record.state !== 'accepted' && record.state !== 'in_progress') {
    throw conflict('Only an accepted request can be completed.');
  }
  const outcome = record.outcome;
  if (outcome === null) throw conflict('This request has no decided outcome to complete.');

  const context = await loadRetailServiceOrder(record.orderId);
  if (context === null) throw notFound('Order not found');

  if (!REFUNDING_RETAIL_CUSTOMER_OUTCOMES.includes(outcome)) {
    // `no_remedy` — accepted as a fact and closed with nothing owed. It is not a
    // rejection: Mercaria agreed the request was valid and agreed the answer is
    // that nothing is due (a recall the buyer had already disposed of, a
    // delivery failure the carrier resolved).
    await finish(decider, record.id, 'completed', now, undefined);
    notifyRetailRequestClosed(context.order, record.id, 'completed');
    return reload(record.id);
  }

  const basis = await readRetailRefundBasis(context.order);
  const units = record.lines
    .map((line) => ({
      orderItemId: line.orderItemId,
      // The APPROVED quantity, never the requested one. A buyer asking for five
      // of three units must not be able to make the refund arithmetic read their
      // number — which is why `approved_quantity` exists as a separate column.
      quantity: line.approvedQuantity ?? 0,
    }))
    .filter((unit) => unit.quantity > 0);

  const allocation = composeRetailRefundAllocation({
    kind: record.kind,
    lines: basis.lines,
    units,
    totals: basis.totals,
  });

  const commit = await commitRetailServiceRefund({
    order: context.order,
    requestId: record.id,
    allocation,
    units,
    reason: `Mercaria retail service request ${record.kind}`,
  });

  if (commit.outcome === 'committed') {
    await transitionRetailServiceRequest({
      id: record.id,
      from: ['accepted', 'in_progress'],
      to: 'in_progress',
      refundId: commit.refundId,
      completionFailure: null,
    });
    await appendRetailServiceEvent({
      requestId: record.id,
      kind: 'refund_committed',
      resultingState: 'in_progress',
      ...retailDeciderAudit(decider),
      detail: commit.refundId,
    });
    // "The money is coming" — the commerce record has committed and the rail has
    // not finished. The reconciler turns it into `completed` when it has.
    notifyRetailRefundPending(context.order, record.id);
    return reload(record.id);
  }

  if (commit.outcome === 'converged') {
    await transitionRetailServiceRequest({
      id: record.id,
      from: ['accepted', 'in_progress'],
      to: 'in_progress',
      completionFailure: null,
    });
    return reload(record.id);
  }

  const failure: RetailServiceCompletionFailure =
    commit.outcome === 'suspended'
      ? 'dispute_suspension'
      : commit.outcome === 'nothing_owed'
        ? 'refund_refused'
        : 'order_state_changed';
  await transitionRetailServiceRequest({
    id: record.id,
    from: ['accepted', 'in_progress'],
    to: 'in_progress',
    completionFailure: failure,
  });
  await appendRetailServiceEvent({
    requestId: record.id,
    kind: 'completion_failed',
    resultingState: 'in_progress',
    ...retailDeciderAudit(decider),
    detail: failure,
  });
  log.general.warn(
    { requestId: record.id, orderId: record.orderId, failure },
    '[RetailService] completion did not complete; the request stands and the retry is the same call',
  );
  return reload(record.id);
}

/**
 * Terminate an ACCEPTED request that Mercaria is no longer going to deliver.
 *
 * Distinct from `withdrawn`, which is the buyer's own act, and from `rejected`,
 * which is Mercaria never having agreed. A `cancelled` request is one Mercaria
 * agreed to and then could not do — a recall superseded by a wider one, a return
 * the buyer never sent. It is an OPERATOR act with a reason, because it takes
 * something away from somebody who was told they would get it.
 */
export async function cancelRetailServiceRequest(
  decider: RetailServiceDecider,
  input: { requestId: string; reason: string },
  now: Date,
): Promise<RetailServiceRequestRecord> {
  const record = await findRetailServiceRequest(input.requestId);
  if (!record) throw notFound('Request not found');
  const moved = await transitionRetailServiceRequest({
    id: input.requestId,
    from: ['accepted', 'in_progress'],
    to: 'cancelled',
    completedAt: now,
  });
  if (!moved) throw conflict('Only an accepted request can be cancelled.');
  await appendRetailServiceEvent({
    requestId: input.requestId,
    kind: 'request_cancelled',
    resultingState: 'cancelled',
    ...retailDeciderAudit(decider),
    detail: input.reason,
  });
  const context = await loadRetailServiceOrder(record.orderId);
  if (context !== null) notifyRetailRequestClosed(context.order, input.requestId, 'cancelled');
  return reload(input.requestId);
}

/** Stamp a terminal state and its trail. */
async function finish(
  decider: RetailServiceDecider,
  requestId: string,
  to: 'completed',
  now: Date,
  refundId: string | undefined,
): Promise<void> {
  await transitionRetailServiceRequest({
    id: requestId,
    from: ['accepted', 'in_progress'],
    to,
    completedAt: now,
    completionFailure: null,
    ...(refundId === undefined ? {} : { refundId }),
  });
  await appendRetailServiceEvent({
    requestId,
    kind: 'request_completed',
    resultingState: to,
    ...retailDeciderAudit(decider),
  });
}

/** Read a request back, or fail loudly — it existed a statement ago. */
async function reload(requestId: string): Promise<RetailServiceRequestRecord> {
  const record = await findRetailServiceRequest(requestId);
  if (!record) throw notFound('Request not found');
  return record;
}

/** Stamp a request `completed` once its rail has settled. The reconciler's. */
export async function markRetailServiceRequestSettled(
  decider: RetailServiceDecider,
  requestId: string,
  now: Date,
): Promise<void> {
  await finish(decider, requestId, 'completed', now, undefined);
}
