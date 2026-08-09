/**
 * The EFFECTIVE state of one piece of evidence — PURE (#121 "Safety and
 * regulatory evidence" 10, acceptance 2).
 *
 * ## Expiry is derived from the clock, and that IS acceptance 2
 *
 * "Expired agreement or compliance evidence removes new publication and
 * checkout eligibility automatically" is normally implemented as a sweep that
 * flips a status column. It is implemented here as arithmetic: the row stores
 * what a REVIEWER decided (five values, `expired` not among them) plus a
 * nullable deadline, and `expired` is what this function returns when the
 * deadline has passed. So a certificate that ran out overnight stops
 * authorizing anything in the next derivation, with nothing having run — and no
 * stored state can disagree with the deadline beside it.
 *
 * The `deriveOfferFreshness` (#118) and `deriveNativeCheckoutEligibility` (#57)
 * rule, applied to documents.
 *
 * ## Expiry only overrides a VERIFIED state
 *
 * A rejected document that also happens to be past its date is still
 * `rejected`, because that is the fact an operator needs: "renew it" is the
 * wrong next action for a document somebody refused. Only a verification can
 * lapse, so only `verified` becomes `expired`.
 */

import type { RetailEvidenceReviewState, RetailEvidenceState } from '@mercaria/shared-types';

/** The stored half of any evidence row this module reads. */
export interface EvidenceStateFacts {
  reviewState: RetailEvidenceReviewState;
  /** The deadline. NULL = no expiry. */
  expiresAt: Date | null;
}

/** What a gate should treat this evidence as, right now. */
export function deriveEvidenceState(
  evidence: EvidenceStateFacts,
  now: Date = new Date(),
): RetailEvidenceState {
  if (evidence.reviewState !== 'verified') {
    return evidence.reviewState;
  }
  if (evidence.expiresAt !== null && evidence.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'verified';
}

/** Whether this evidence currently authorizes anything. The only accepting state. */
export function isEvidenceEffective(
  evidence: EvidenceStateFacts,
  now: Date = new Date(),
): boolean {
  return deriveEvidenceState(evidence, now) === 'verified';
}

/**
 * How informative each non-accepting state is, most informative FIRST.
 *
 * A subject usually has several documents of one kind and none of them
 * effective. Reporting "unverified" while a verified one EXPIRED sends an
 * operator to the review queue when the actual work is a renewal; reporting
 * "revoked" while another is merely pending hides the one they can finish. So
 * the refusal reported is the strongest fact present, and the order is the
 * policy that decides it.
 *
 * `expired` first: a document that WAS verified is the closest thing to
 * authority the subject has, and renewing it is the shortest path.
 */
const STATE_INFORMATIVENESS: readonly Exclude<RetailEvidenceState, 'verified'>[] = [
  'expired',
  'revoked',
  'rejected',
  'pending',
  'unknown',
];

/**
 * The single state to report for a set of candidate documents of one kind.
 *
 * `undefined` when the set is EMPTY — which is a different fact from "present
 * and not effective", and the caller distinguishes them (`missing` versus
 * `unverified`/`expired`/…). Returning `'unknown'` for both would collapse
 * "nobody has collected this document" into "somebody filed it and nobody
 * looked", which are different pieces of work.
 */
export function summarizeEvidenceState(
  candidates: readonly EvidenceStateFacts[],
  now: Date = new Date(),
): RetailEvidenceState | undefined {
  if (candidates.length === 0) return undefined;
  const states = new Set(candidates.map((candidate) => deriveEvidenceState(candidate, now)));
  if (states.has('verified')) return 'verified';
  return STATE_INFORMATIVENESS.find((state) => states.has(state)) ?? 'unknown';
}
