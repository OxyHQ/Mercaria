/**
 * Who may assert what, and what it takes to reach `verified` — issue #55's
 * evidence rules 2/3/4 and ADR 0002 D17's authority matrix, as pure functions.
 *
 * Every rule here is a decision about TRUST, so none of them reads the database,
 * the request or the clock: given an actor, a kind and a set of evidence, the
 * answer is the same every time and a test can enumerate it. The service layer
 * calls these; nothing else decides authorization for this domain.
 *
 * ## The four rules, and where each one is actually held
 *
 * 1. *A source adapter may create a candidate but cannot mark it verified unless
 *    an explicit trusted verification rule exists.* — {@link canAutoVerify},
 *    reading {@link AUTOMATIC_VERIFICATION_RULES}, which is EMPTY today.
 * 2. *Merchant self-claims provide evidence and are not self-verifying.* —
 *    {@link maxReachableStatus}: a self-claim tops out at `pending_review`.
 * 3. *Domain control proves control of that domain, never brand ownership or
 *    official-reseller status.* — `SUFFICIENT_EVIDENCE_KINDS` (shared-types)
 *    read by {@link findSufficientEvidence}.
 * 4. *High-impact official relationships may require four eyes.* —
 *    {@link requiresFourEyes} plus the partial unique on `relationship_reviews`.
 */

import {
  BADGE_RELATIONSHIP_KINDS,
  RELATIONSHIP_VERIFICATION_STATES,
  SUFFICIENT_EVIDENCE_KINDS,
  type RelationshipAssertedByKind,
  type RelationshipEvidenceKind,
  type RelationshipEvidenceStatus,
  type RelationshipKind,
  type RelationshipVerificationMethod,
  type RelationshipVerificationState,
} from '@mercaria/shared-types';

/**
 * One entry permits an automated actor to write `verified` for exactly one
 * (kind, method) pair.
 *
 * The list is EMPTY, and that is the decision rather than an unfinished state.
 * The one deterministic mechanism Mercaria has — #83's domain control — proves
 * control of a hostname, and ADR 0002 D10 is explicit that this establishes
 * neither brand ownership nor authorization to resell. It auto-verifies the
 * MERCHANT CLAIM it actually proves (`merchants.claim_state`, #54's column), not
 * any relationship defined here.
 *
 * An empty rule table would normally be untestable — a gate hardcoded to `false`
 * behaves identically. {@link canAutoVerify} therefore takes the rule table as a
 * parameter, so a test can supply one and prove the gate reads it.
 */
export interface AutomaticVerificationRule {
  readonly kind: RelationshipKind;
  readonly method: RelationshipVerificationMethod;
  readonly assertedBy: RelationshipAssertedByKind;
  /** Why this automated path is trusted with a verdict. Required, never blank. */
  readonly justification: string;
}

export const AUTOMATIC_VERIFICATION_RULES: readonly AutomaticVerificationRule[] = [];

/** Does an explicit trusted rule let this automated actor write `verified`? */
export function canAutoVerify(
  candidate: {
    kind: RelationshipKind;
    method: RelationshipVerificationMethod;
    assertedBy: RelationshipAssertedByKind;
  },
  rules: readonly AutomaticVerificationRule[] = AUTOMATIC_VERIFICATION_RULES,
): boolean {
  return rules.some(
    (rule) =>
      rule.kind === candidate.kind &&
      rule.method === candidate.method &&
      rule.assertedBy === candidate.assertedBy,
  );
}

/**
 * The highest status an actor may reach WITHOUT an operator decision.
 *
 * `catalog_operator` is absent from the switch on purpose: an operator does not
 * "reach" a status by asserting, they DECIDE one through the review workflow,
 * which has its own gates (evidence sufficiency, four eyes). Treating them as an
 * asserter that may write `verified` directly would route a verdict around both.
 */
export function maxReachableStatus(
  assertedBy: RelationshipAssertedByKind,
): Extract<RelationshipVerificationState, 'candidate' | 'pending_review'> {
  switch (assertedBy) {
    case 'ingestion_source':
      // Ingestion produces candidates. It does not get to put itself in a
      // review queue either — a machine asking for a human decision on every
      // match is how the queue stops being read at all.
      return 'candidate';
    case 'merchant_self_claim':
      // A merchant may say a thing about itself and ask for it to be reviewed.
      // Saying it is not verifying it, which is the whole of evidence rule 3.
      return 'pending_review';
    case 'platform_verification':
      return 'pending_review';
    case 'catalog_operator':
      return 'pending_review';
  }
}

/** Evidence as the gates below read it — kind and whether it still stands. */
export interface EvidenceFact {
  kind: RelationshipEvidenceKind;
  status: RelationshipEvidenceStatus;
}

/**
 * The evidence rows that could carry this kind to `verified`, considering only
 * evidence that is still ACTIVE.
 *
 * Returning the list rather than a boolean is deliberate: the caller records
 * WHICH proof was accepted in the review row, and a refusal can name what would
 * have been enough.
 */
export function findSufficientEvidence(
  kind: RelationshipKind,
  evidence: readonly EvidenceFact[],
): EvidenceFact[] {
  const acceptable = SUFFICIENT_EVIDENCE_KINDS[kind];
  return evidence.filter((row) => row.status === 'active' && acceptable.includes(row.kind));
}

/** What kinds of proof WOULD have been enough — for an honest refusal message. */
export function acceptableEvidenceKinds(kind: RelationshipKind): readonly RelationshipEvidenceKind[] {
  return SUFFICIENT_EVIDENCE_KINDS[kind];
}

/**
 * Whether verifying this kind needs a second operator.
 *
 * Scoped to the kinds that can produce a PUBLIC BADGE, derived from the same
 * registry the badge itself comes from — a separate list of "high impact" kinds
 * could disagree with which kinds actually reach a shopper. `enabled` is the
 * deployment's switch (`CATALOG_FOUR_EYES_REQUIRED`), defaulting ON: a badge
 * that misleads a buyer about who they are dealing with is the failure worth
 * failing closed on, and a single-operator deployment turns it off deliberately
 * rather than discovering it was never on.
 */
export function requiresFourEyes(kind: RelationshipKind, enabled: boolean): boolean {
  return enabled && BADGE_RELATIONSHIP_KINDS.includes(kind);
}

/**
 * The status transitions the review workflow admits.
 *
 * A closed table rather than a chain of `if`s, so "can a revoked claim be
 * verified again" has one answer in one place. Re-verification after a
 * revocation is deliberately absent: the row is history and the correction path
 * is a NEW row linked by `superseded_by_id`, which is what keeps a revoked claim
 * from being edited back into a live one.
 *
 * `candidate → candidate` is a deliberate self-transition, not an oversight: an
 * operator asking for more evidence on a row that is already a candidate changes
 * no status and must still ADVANCE THE REVIEW ROUND, which is what retires the
 * approvals given for the version being sent back. Without it, "request more
 * evidence, then approve alone" would defeat four eyes.
 */
export const RELATIONSHIP_TRANSITIONS: Readonly<
  Record<RelationshipVerificationState, readonly RelationshipVerificationState[]>
> = Object.freeze({
  candidate: ['candidate', 'pending_review', 'verified', 'rejected'],
  pending_review: ['verified', 'rejected', 'candidate'],
  verified: ['expired', 'revoked'],
  rejected: [],
  expired: [],
  revoked: [],
});

/** Is this a transition the workflow admits at all? */
export function canTransition(
  from: RelationshipVerificationState,
  to: RelationshipVerificationState,
): boolean {
  return RELATIONSHIP_TRANSITIONS[from].includes(to);
}

/**
 * Statuses from which no further transition exists — the ends of the workflow.
 * Derived from the table above so the two can never disagree.
 */
export const TERMINAL_RELATIONSHIP_STATES: readonly RelationshipVerificationState[] =
  RELATIONSHIP_VERIFICATION_STATES.filter(
    (state) => RELATIONSHIP_TRANSITIONS[state].length === 0,
  );
