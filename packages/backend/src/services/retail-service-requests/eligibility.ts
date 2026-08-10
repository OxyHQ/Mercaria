/**
 * May Mercaria entertain this request — a pure, total derivation (#127
 * §"Customer eligibility and policy").
 *
 * ## DERIVED, never stored
 *
 * The deliberate divergence from the one-stored-verdict rule, and it is #121's
 * exactly: the inputs sit on tables this domain does not own — the order's live
 * status and status history, #126's terms snapshot, the live category-exception
 * table, the quantities other requests already consumed, and the clock. A stored
 * copy would go stale in the direction that ADMITS a request the policy refuses,
 * which is the wrong direction for a verdict that authorizes money.
 *
 * That is also what makes a published category exception bite with NO sweep
 * having run, and what makes the whole derivation testable against a table of
 * fixtures with no database at all.
 *
 * ## Three-valued, and `evidence_needed` is not a soft no
 *
 * #127 policy rule 5 asks that eligible, ineligible and evidence-needed all be
 * explained, and they route to three different next actions: proceed, stop, or
 * send us a photograph. `ineligible` beats `evidence_needed` beats `eligible` —
 * `deriveRetailCompleteness`'s severity rule (#120), applied to a remedy.
 *
 * ## It reads no supplier fact
 *
 * `RetailServiceEligibilityInput` has no member for a supplier state, a supplier
 * credit, a wholesale cost or a supply agreement — ADR 0004 D8.5 held by the
 * parameter list rather than by a service remembering not to look, the
 * `SourcingCandidateFacts` device from #122.
 */

import type {
  RetailCustomerOutcome,
  RetailServiceEligibilityVerdict,
  RetailServiceIneligibilityReason,
  RetailServiceRequestKind,
} from '@mercaria/shared-types';
import {
  RETAIL_SERVICE_REQUEST_POLICIES,
  resolveEffectiveServiceDeadline,
  SUPPORTED_RETAIL_CUSTOMER_OUTCOMES,
} from '@mercaria/shared-types';
import type { RetailServiceDeadlines } from './policy.js';

/**
 * Everything the derivation may know.
 *
 * Note what is absent as much as what is present: no supplier, no purchase
 * order, no cost, no agreement, no email and no session. A remedy is decided
 * from the order, its lines, its terms and the clock.
 */
export interface RetailServiceEligibilityInput {
  readonly kind: RetailServiceRequestKind;
  /** `mercaria_retail`, or anything else — the first thing checked. */
  readonly commercialRole: string;
  /** The order's live payment status. */
  readonly paymentStatus: string;
  /** From the status HISTORY, never the current status. */
  readonly dispatched: boolean;
  /** From the status HISTORY. */
  readonly delivered: boolean;
  readonly deadlines: RetailServiceDeadlines;
  /** Is a request of this kind already open on this order? */
  readonly openRequestOfKind: boolean;
  /**
   * Do the named lines still have units nothing has resolved?
   *
   * The cross-row arithmetic lives in the repository, which holds the lock; this
   * takes its answer. Passing the sums instead would put the same subtraction in
   * two places and let them disagree.
   */
  readonly unresolvedUnitsAvailable: boolean;
  /** A LIVE category exception covering this kind for these goods. */
  readonly categoryExcluded: boolean;
  /** Has the buyer supplied any evidence yet? */
  readonly hasEvidence: boolean;
  readonly now: Date;
}

/**
 * The verdict. A STRING discriminant, not `eligible: true | false`.
 *
 * This backend compiles with `strict: false`, and without `strictNullChecks`
 * TypeScript does not narrow a union on a boolean-literal discriminant — so the
 * obvious spelling leaves every caller holding the whole union and unable to
 * read `.reason`. #68 measured it, #110 hit it again, and `AGENTS.md` records it.
 */
export type RetailServiceEligibility =
  | { readonly verdict: 'eligible'; readonly deadlineAt: Date | null }
  | { readonly verdict: 'evidence_needed' }
  | {
      readonly verdict: 'ineligible';
      readonly reason: RetailServiceIneligibilityReason;
      /** The deadline that passed, on `window_closed` only. */
      readonly deadlineAt?: Date;
    };

/** The full derivation. Pure, total, no I/O and no clock but the one passed in. */
export function deriveRetailServiceEligibility(
  input: RetailServiceEligibilityInput,
): RetailServiceEligibility {
  // Order of the refusals is load-bearing and runs from the most structural to
  // the most contingent, so a buyer is never told "your window closed" about an
  // order that was never a retail order in the first place.
  if (input.commercialRole !== 'mercaria_retail') {
    return { verdict: 'ineligible', reason: 'not_a_retail_order' };
  }

  const policy = RETAIL_SERVICE_REQUEST_POLICIES[input.kind];
  if (!policy.customerSubmittable) {
    return { verdict: 'ineligible', reason: 'not_customer_submittable' };
  }
  if (input.paymentStatus !== 'paid') {
    // `refund.service` leaves `payment_status` at `paid` while anything is still
    // refundable, so a partially refunded order is admitted here — a buyer who
    // already had one line refunded may still return another, and refusing
    // would strand exactly the person a partial remedy already let down once.
    // `refunded` means the grand total is covered and there is nothing left.
    return { verdict: 'ineligible', reason: 'order_not_paid' };
  }
  if (input.openRequestOfKind) {
    return { verdict: 'ineligible', reason: 'request_already_open' };
  }
  if (!input.unresolvedUnitsAvailable) {
    return { verdict: 'ineligible', reason: 'quantity_already_resolved' };
  }
  if (input.categoryExcluded) {
    return { verdict: 'ineligible', reason: 'category_exception' };
  }

  // A cancellation asks Mercaria to stop something that has not arrived. Once it
  // has been dispatched the answer is a RETURN, and `RETAIL_REASONS_OFFERING_RETURN`
  // is what lets a client say so rather than leaving the buyer at a dead end.
  const cancellation = policy.window === 'cancellation';
  if (cancellation && input.dispatched) {
    return { verdict: 'ineligible', reason: 'already_dispatched' };
  }
  // A goods-based right cannot start before the goods exist. `not_yet_delivered`
  // and `window_closed` are opposite facts — one says "wait", the other says
  // "too late" — and collapsing them is how a buyer waiting for a parcel is told
  // their return window expired.
  if (!cancellation && policy.window !== 'none' && !input.dispatched && !input.delivered) {
    return { verdict: 'ineligible', reason: 'not_yet_delivered' };
  }

  const deadlineAt = resolveEffectiveServiceDeadline(
    input.deadlines.statutoryAt,
    input.deadlines.commercialAt,
  );
  if (deadlineAt !== null && input.now.getTime() > deadlineAt.getTime()) {
    return { verdict: 'ineligible', reason: 'window_closed', deadlineAt };
  }

  // Evidence LAST, so a buyer is never asked for a photograph of goods they are
  // going to be refused anyway. #127 policy rule 6 is the other half of this:
  // `evidenceRequired` is false for ordinary withdrawal, so nobody is asked to
  // photograph something they simply changed their mind about.
  if (policy.evidenceRequired && !input.hasEvidence) {
    return { verdict: 'evidence_needed' };
  }

  return { verdict: 'eligible', deadlineAt };
}

/**
 * May Mercaria actually deliver this outcome?
 *
 * The three unsupported ones all mean *send the buyer another physical item*,
 * and each needs a SECOND purchase order against the same customer order and the
 * same supplier — which `po:<orderId>:<supplierId>` (#124) makes unrepresentable
 * by design. The refusal happens at DECISION time and names the outcome, so
 * nobody is told "yes, a replacement" and then "actually a refund" a week later.
 *
 * A refund-shaped remedy is always available and is never worse for the buyer
 * than the remedy it replaces, which is why this is a real answer rather than a
 * placeholder. #127's own sentence — *"Mercaria must not advertise a warranty
 * period it cannot operationally support"* — is what makes saying so out loud
 * the correct behaviour.
 */
export function retailOutcomeIsDeliverable(outcome: RetailCustomerOutcome): boolean {
  return SUPPORTED_RETAIL_CUSTOMER_OUTCOMES.includes(outcome);
}

/** Whether a verdict permits a request to be filed at all. */
export function eligibilityAdmitsSubmission(
  eligibility: RetailServiceEligibility,
): eligibility is
  | { readonly verdict: 'eligible'; readonly deadlineAt: Date | null }
  | { readonly verdict: 'evidence_needed' } {
  return eligibility.verdict !== 'ineligible';
}

/** The state a freshly filed request lands in, from its verdict. */
export function initialRequestState(
  eligibility: RetailServiceEligibility,
): 'submitted' | 'evidence_required' {
  return eligibility.verdict === 'evidence_needed' ? 'evidence_required' : 'submitted';
}

/** The verdict as its bare vocabulary value, for a projection. */
export function eligibilityVerdictOf(
  eligibility: RetailServiceEligibility,
): RetailServiceEligibilityVerdict {
  return eligibility.verdict;
}
