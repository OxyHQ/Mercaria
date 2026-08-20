/**
 * Recording a REFUSED attempt on a buyer request (#743, widened by #765).
 *
 * `buyer_request_events`' own docblock says the trail carries "one row per
 * ATTEMPT including refusals" and that "a refused decision is the row worth
 * having: an audit that recorded only successes answers 'did anybody try to
 * cancel this' with silence." #743 closed that for the DECISION transition and
 * left it open for the other five, so the trail still answered "did anybody try
 * to mark this received and get told no" with the same silence.
 *
 * ## Two functions rather than one that takes a kind
 *
 * A decision and a transition carry DIFFERENT reason vocabularies
 * (`BUYER_REQUEST_DECISION_REFUSALS` and `BUYER_REQUEST_TRANSITION_REFUSALS`),
 * and one function taking both a kind and a reason could be handed any pairing
 * of them. Two signatures make every wrong pairing a `tsc` error instead:
 * `refuseDecision` cannot write a transition kind, and `refuseTransition`
 * cannot write `decision_refused`.
 *
 * ## Why these writes do NOT take a transaction handle
 *
 * `eventRepository`'s rule is that every write takes a transaction handle,
 * because an audit row that commits separately from the fact it describes is a
 * trail with holes. That rule is about a row describing something that
 * HAPPENED, and a refusal is the opposite case: nothing happened, the row IS
 * the whole fact, and the request handler is about to throw.
 *
 * So the two directions are opposite and both are correct. A refusal written on
 * a transaction handle would be rolled back by the very throw it exists to
 * record, leaving precisely the silence the trail exists to prevent — and it
 * would do so invisibly, because the refusal still reaches the caller as a 409.
 * Both functions here therefore write on the ROOT handle, and they are the only
 * writers in this domain that may.
 *
 * ## Why they throw rather than returning
 *
 * The record and the refusal are one act. A helper that only recorded would let
 * a caller record and then forget to throw (accepting a decision it just called
 * refused) or throw without recording (the bug being fixed). Returning `never`
 * and throwing the caller's own error makes the pair inseparable: at a call
 * site there is nothing left to get wrong, and `tsc` treats the call as
 * terminating, so it drops into an existing `throw` position unchanged.
 */

import type {
  BuyerRequestDecisionRefusal,
  BuyerRequestTransitionRefusal,
  BuyerRequestTransitionRefusalKind,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { recordBuyerRequestEvent } from '../../db/buyerRequests/eventRepository.js';
import { actorAuditColumns, type BuyerRequestDecider } from './authorization.js';

/** The request a refusal is about. Exactly one, as the table's CHECK demands. */
export type RefusedAttemptSubject =
  | { readonly cancellationRequestId: string }
  | { readonly returnRequestId: string };

/**
 * Record a refused decision, then throw the refusal.
 *
 * `now` is the caller's clock rather than `new Date()`, so a refusal lands on
 * the same instant the rest of that request's events use and the trail stays
 * orderable.
 */
export async function refuseDecision(input: {
  readonly subject: RefusedAttemptSubject;
  readonly decider: BuyerRequestDecider;
  readonly reason: BuyerRequestDecisionRefusal;
  readonly now: Date;
  readonly error: Error;
}): Promise<never> {
  await recordBuyerRequestEvent(getDb(), {
    ...input.subject,
    kind: 'decision_refused',
    ...actorAuditColumns(input.decider),
    detail: input.reason,
    at: input.now,
  });
  throw input.error;
}

/**
 * Record a refused instruction, receipt, refund, completion or return
 * cancellation, then throw the refusal.
 *
 * The KIND names the transition somebody attempted and the REASON says why it
 * did not run. Both are the caller's, because only the caller knows which of
 * the two it is: the same `state_not_eligible` refuses an instruction on a
 * received return and a refund on an approved one, and a reader needs the
 * transition to know which of those happened.
 */
export async function refuseTransition(input: {
  readonly subject: RefusedAttemptSubject;
  readonly decider: BuyerRequestDecider;
  readonly kind: BuyerRequestTransitionRefusalKind;
  readonly reason: BuyerRequestTransitionRefusal;
  readonly now: Date;
  readonly error: Error;
}): Promise<never> {
  await recordBuyerRequestEvent(getDb(), {
    ...input.subject,
    kind: input.kind,
    ...actorAuditColumns(input.decider),
    detail: input.reason,
    at: input.now,
  });
  throw input.error;
}
