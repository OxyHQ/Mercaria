/**
 * What live enforcement actions DO (#148 acceptance 2, ADR 0005 D18).
 *
 * PURE — a list of actions in, five booleans and a list of program ids out. No
 * database, no clock beyond the one the caller passes, no configuration.
 *
 * ## Why this exists at all
 *
 * Before #148 a partner's fraud posture was ONE coarse column,
 * `referral_partners.state`, whose `suspended` value stops new links AND new
 * attribution AND payout AND earning simultaneously. An operator wanting to
 * stop crediting NEW referrals during an investigation therefore had to stop
 * paying the partner's already-vested honest earnings too — which #148
 * acceptance 2 forbids in as many words: *"New attribution can be paused while
 * valid existing earnings continue settling."*
 *
 * These five are that separation. Each is read by exactly one gate that already
 * existed:
 *
 *  - `newLinksSuspended` → `instrument.service.ts`'s `requireIssuable`
 *  - `newAttributionSuspended` → `attribution.service.ts`'s `attributeTouch`
 *  - `payoutHeld` → `earnings/payability.ts`'s `deriveRewardPayability`
 *  - `terminated` / `permanentlyRestricted` → enrollment
 *
 * ## DERIVED, never stored
 *
 * The `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken for the reason that rule itself gives: the inputs are a SET of
 * rows carrying expiries and lifts, so a stored boolean would be right until
 * the first action lapsed and would then be wrong with nothing to notice it.
 * The place that must not happen is a gate refusing to pay somebody whose
 * suspension ended a month ago.
 *
 * ## Liveness is TWO conditions and both are needed
 *
 * An action is live when it has not been LIFTED and has not EXPIRED. Reading
 * only `lifted_at` leaves a fourteen-day payout hold in force forever; reading
 * only `expires_at` leaves an overturned appeal's action still biting. The SQL
 * that loads them narrows on `lifted_at is null` because that is the indexed
 * half; expiry is applied here, against the caller's clock, so the two cannot
 * disagree about "now".
 */

import {
  REFERRAL_ENFORCEMENT_ACTION_EFFECTS,
  type ReferralEnforcementAction,
  type ReferralEnforcementEffects,
} from '@mercaria/shared-types';

/** The minimum of an action row this derivation reads. */
export interface EnforcementActionFact {
  action: ReferralEnforcementAction;
  /** Present for a `program_partner`-scoped action, absent otherwise. */
  programId?: string | null;
  startsAt: Date;
  expiresAt?: Date | null;
  liftedAt?: Date | null;
}

/** Nothing in force. The answer for a partner with a clean record. */
export const NO_ENFORCEMENT_EFFECTS: ReferralEnforcementEffects = Object.freeze({
  newLinksSuspended: false,
  newAttributionSuspended: false,
  payoutHeld: false,
  terminated: false,
  permanentlyRestricted: false,
  removedFromProgramIds: Object.freeze([]) as readonly string[],
});

/**
 * Whether one action is in force at `at`.
 *
 * Exported so the operator projection can say which of a partner's actions are
 * live without re-implementing the two conditions — a second spelling of
 * "live" is how a dashboard ends up showing an expired hold as current.
 */
export function enforcementActionIsLive(fact: EnforcementActionFact, at: Date): boolean {
  if (fact.liftedAt != null) return false;
  if (fact.startsAt.getTime() > at.getTime()) return false;
  if (fact.expiresAt != null && fact.expiresAt.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * The five effects, from the live actions AND the partner's own state.
 *
 * ## Why the partner state is folded in HERE rather than read beside this
 *
 * `referral_partners.state` already answers a coarse version of the same
 * question, and #146's `suspendPartner` / `terminatePartner` are its only
 * writers. Leaving it out would give the three gates two things to consult and
 * two chances to disagree; duplicating it into an enforcement row would give
 * `referral_partners.state` a rival. So this derivation is the ONE authority
 * and it reads both: the column supplies the coarse posture #142 already
 * enforces, the actions supply the granularity #148 adds.
 *
 * The consequence worth stating: a `suspended` partner still gets today's
 * behaviour exactly — no new links, no new attribution, no payout. What is NEW
 * is that an operator no longer has to reach for that column to stop one of
 * the three. `new_attribution_suspension` alone leaves `payoutHeld` false, and
 * #148 acceptance 2 is that gap.
 *
 * ## The action → effect-keys mapping is exhaustive
 *
 * An action added without an entry fails `tsc` rather than defaulting to
 * "raises nothing" — which is the dangerous default here, because the omission
 * would read as a working gate that never fires.
 */
export function deriveEnforcementEffects(
  actions: readonly EnforcementActionFact[],
  partnerState: string,
  at: Date,
): ReferralEnforcementEffects {
  const effects = {
    newLinksSuspended: false,
    newAttributionSuspended: false,
    payoutHeld: false,
    terminated: false,
    permanentlyRestricted: false,
  };
  const removedFromProgramIds: string[] = [];

  // #142/#146's coarse posture, preserved exactly. `terminated` is the stronger
  // of the two and raises the suspended set as well, so the order of the two
  // branches cannot matter.
  if (partnerState === 'suspended' || partnerState === 'terminated') {
    effects.newLinksSuspended = true;
    effects.newAttributionSuspended = true;
    effects.payoutHeld = true;
  }
  if (partnerState === 'terminated') {
    effects.terminated = true;
  }

  for (const fact of actions) {
    if (!enforcementActionIsLive(fact, at)) continue;
    for (const key of REFERRAL_ENFORCEMENT_ACTION_EFFECTS[fact.action]) {
      effects[key] = true;
    }
    if (fact.action === 'program_removal' && fact.programId != null) {
      if (!removedFromProgramIds.includes(fact.programId)) {
        removedFromProgramIds.push(fact.programId);
      }
    }
  }

  return { ...effects, removedFromProgramIds };
}

/**
 * Whether a partner may earn NEW attribution under a program.
 *
 * The program-removal half is why this takes a program id and why
 * `deriveEnforcementEffects` returns the removed set rather than a boolean:
 * removal from one program must leave every other program the partner is in
 * untouched, and a partner-wide boolean cannot express that.
 */
export function enforcementPermitsAttribution(
  effects: ReferralEnforcementEffects,
  programId: string,
): boolean {
  if (effects.newAttributionSuspended) return false;
  if (effects.terminated) return false;
  return !effects.removedFromProgramIds.includes(programId);
}
