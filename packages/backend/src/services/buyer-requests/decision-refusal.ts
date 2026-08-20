/**
 * Recording a REFUSED decision (#743).
 *
 * `buyer_request_events`' own docblock says the trail carries "one row per
 * ATTEMPT including refusals" and that "a refused decision is the row worth
 * having: an audit that recorded only successes answers 'did anybody try to
 * cancel this' with silence." Eleven of the twelve kinds had a producer;
 * `decision_refused` had none, so the trail recorded only successes — the exact
 * failure the vocabulary was written to prevent.
 *
 * ## Why this one write does NOT take a transaction handle
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
 * `refuseDecision` therefore writes on the ROOT handle, and it is the only
 * writer in this domain that may.
 *
 * ## Why it throws rather than returning
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
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { recordBuyerRequestEvent } from '../../db/buyerRequests/eventRepository.js';
import { actorAuditColumns, type BuyerRequestDecider } from './authorization.js';

/** The request a refusal is about. Exactly one, as the table's CHECK demands. */
export type RefusedDecisionSubject =
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
  readonly subject: RefusedDecisionSubject;
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
