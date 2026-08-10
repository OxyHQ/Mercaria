/**
 * Coordinating a card dispute on a retail order (#127 §"Chargebacks and
 * disputes", ADR 0004 diagram 10).
 *
 * ## A dispute on a retail order is platform-funded and has no transfer to
 * reverse
 *
 * ADR 0004 diagram 10 states it: a `mercaria_retail` order has no connected
 * seller, so #49's seller-side recovery has nothing to recover from. The loss
 * stays with Mercaria, and if a supplier is at fault the claim is a B2B recovery
 * that runs separately — never against the buyer.
 *
 * ## The suspension is the load-bearing part
 *
 * Rules 5 and 10: *"suspend duplicate refund paths according to an explicit
 * policy"* and *"a chargeback cannot also produce an unnoticed duplicate
 * refund"*. While a coordination is `suspended`, `refund-bridge.ts` refuses
 * every refund on that order and the request records `dispute_suspension` as its
 * completion failure — visible, retryable, and not a stuck request.
 *
 * The word in rule 10 is *unnoticed*. A refund committed while a dispute is open
 * is sometimes right: an operator who has read the evidence and decided the
 * buyer is owed regardless may release the suspension, and the release is
 * attributable, dated and explained by CHECK. What is forbidden is the release
 * happening by default, by a sweep, or by nobody.
 *
 * ## The evidence is not copied here
 *
 * Rule 2 asks that fulfilment, tracking, support and return evidence be
 * preserved. All four already are, append-only, in the domains that own them —
 * `order_status_history`, #126's promise trail, #110's support thread and this
 * domain's own return case. `evidence_assembled_at` is a BOOLEAN instant rather
 * than a copy of any of it, because a second version of evidence is the one
 * somebody submits to a card network by mistake.
 *
 * ## Rule 3 is held by absence
 *
 * *"Prevent supplier data or PII from being exposed beyond what Stripe
 * requires."* There is no supplier column and no contact column on
 * `retail_dispute_coordinations`, and this module composes no evidence payload
 * and calls no provider — submitting evidence to Stripe is an operator act in
 * Stripe's own dashboard, which is where the redaction decisions belong.
 */

import {
  ensureRetailDisputeCoordination,
  findRetailDisputeCoordination,
  listRetailDisputeCoordinationsForOrder,
  markRetailDisputeEvidenceAssembled,
  setRetailRefundSuspension,
  type RetailDisputeCoordinationRow,
} from '../../db/retailServiceRequests/policyRepository.js';
import { appendRetailServiceEvent } from '../../db/retailServiceRequests/requestRepository.js';
import { findOrderById } from '../../db/orders/orderRepository.js';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { retailDeciderAudit, type RetailServiceDecider } from './authorization.js';

/**
 * Open the coordination for a dispute that names a retail order.
 *
 * Called from the payment domain's dispute handling through the ONE entry point
 * below, and converges: a redelivered `charge.dispute.created` produces one
 * coordination and does not re-suspend a refund an operator has since released.
 *
 * A dispute on a NON-retail order produces nothing at all and costs one indexed
 * read — this domain has no business suspending a marketplace seller's refunds,
 * which #49's own dispute service already handles with a transfer reversal.
 */
export async function coordinateRetailDispute(input: {
  disputeId: string;
  orderId: string;
}): Promise<RetailDisputeCoordinationRow | undefined> {
  const order = await findOrderById(input.orderId);
  if (!order) return undefined;
  if (order.commercialRole !== 'mercaria_retail') return undefined;

  const { row, created } = await ensureRetailDisputeCoordination({
    disputeId: input.disputeId,
    orderId: input.orderId,
  });
  if (created) {
    log.general.info(
      { disputeId: input.disputeId, orderId: input.orderId },
      '[RetailService] retail dispute coordinated; refunds on this order are suspended',
    );
  }
  return row;
}

/**
 * Release a suspension, attributably.
 *
 * The reason is MANDATORY at the row (a CHECK refuses a release with no reason,
 * no actor and no instant), so a refund issued while a dispute is open is a
 * decision somebody made and can be shown to have made. There is deliberately no
 * function that releases every suspension on an order, and no sweep that
 * releases one on a schedule.
 */
export async function releaseRetailRefundSuspension(
  decider: RetailServiceDecider,
  input: { disputeId: string; reason: string; requestId?: string },
  now: Date,
): Promise<RetailDisputeCoordinationRow> {
  if (decider.oxyUserId === undefined) {
    // A `system` decider cannot release a suspension. Releasing one is exactly
    // the decision that must have a name on it, and "the system decided" is not
    // a name. Unreachable from HTTP — every route mints an operator — and
    // refused here so an internal caller cannot do it either.
    throw conflict('Only a named operator may release a refund suspension.');
  }
  const existing = await findRetailDisputeCoordination(input.disputeId);
  if (existing === undefined) throw notFound('Dispute coordination not found');
  if (existing.suspension === 'released') return existing;

  const row = await setRetailRefundSuspension({
    id: existing.id,
    suspension: 'released',
    reason: input.reason,
    byOxyUserId: decider.oxyUserId,
    at: now,
  });
  if (row === undefined) throw notFound('Dispute coordination not found');

  if (input.requestId !== undefined) {
    await appendRetailServiceEvent({
      requestId: input.requestId,
      kind: 'refund_suspension_released',
      ...retailDeciderAudit(decider),
      detail: input.reason,
    });
  }
  log.general.warn(
    { disputeId: input.disputeId, by: decider.oxyUserId },
    '[RetailService] refund suspension released while a dispute is open',
  );
  return row;
}

/** Record that the evidence a dispute needs has been assembled. */
export async function markRetailDisputeEvidenceReady(
  decider: RetailServiceDecider,
  input: { disputeId: string },
  now: Date,
): Promise<void> {
  const existing = await findRetailDisputeCoordination(input.disputeId);
  if (existing === undefined) throw notFound('Dispute coordination not found');
  void decider;
  await markRetailDisputeEvidenceAssembled({ id: existing.id, at: now });
}

/** Every coordination on one order — the operator's read. */
export async function readRetailDisputeCoordinations(
  orderId: string,
): Promise<RetailDisputeCoordinationRow[]> {
  return listRetailDisputeCoordinationsForOrder(orderId);
}
