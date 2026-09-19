/**
 * What may be DONE about a digital-retail purchase (#1016 Workstream 12,
 * ADR 0011 D11).
 *
 * ## Derived from facts, never from a boolean
 *
 * There is no `refundable` column anywhere in this domain. A refund decision
 * depends on where procurement got to, whether an artifact exists, whether the
 * buyer has SEEN it, whether the ecosystem can say it was USED, which capability
 * it is, and whether the buyer waived withdrawal — six facts that move
 * independently, and a stored verdict beside them would be wrong within a day.
 *
 * ## The distinction the whole function turns on
 *
 * **A reveal is not a redemption.** A buyer who looked at a key has had the
 * opportunity to use it, which is why a reveal changes the remedy at all; a buyer
 * whose key the ecosystem reports as REDEEMED has used it, which is a different
 * and stronger fact. Collapsing them would refuse a refund to everybody who
 * clicked, or grant one to everybody who used their key — and this repository has
 * both facts precisely so it need do neither.
 *
 * ## `manual_review` is an outcome, not a failure
 *
 * Where the evidence is genuinely ambiguous — a revealed key an ecosystem cannot
 * report on, a buyer claiming an invalid key — the honest answer is a human. A
 * function that guessed here would be making a commercial decision with no
 * evidence, at scale.
 */

import {
  isSecretBearingCapability,
  type DigitalArtifactRedemptionState,
  type DigitalFulfilmentCapability,
  type DigitalFulfilmentStatus,
  type DigitalPurchaseOrderStatus,
  type DigitalRemedyReason,
  type DigitalRemedyVerdict,
} from '@mercaria/shared-types';

/** The facts a remedy is derived from. A row satisfies it; so does a fixture. */
export interface RemedyFacts {
  readonly purchaseOrderStatus: DigitalPurchaseOrderStatus | null;
  readonly fulfilmentStatus: DigitalFulfilmentStatus | null;
  readonly capability: DigitalFulfilmentCapability;
  /** Whether an active artifact exists for this fulfilment. */
  readonly artifactDelivered: boolean;
  readonly revealed: boolean;
  readonly redemptionState: DigitalArtifactRedemptionState;
  /** Whether the buyer reported the artifact invalid, used or wrong-region. */
  readonly buyerReportedFault: boolean;
  /** Whether the supplier's rider says it will replace an invalid artifact. */
  readonly replacementSupported: boolean;
  /** ADR 0010 D11's withdrawal waiver, taken at checkout. */
  readonly withdrawalWaived: boolean;
}

/** Derive the remedy. Pure — same answer for a row and for a fixture. */
export function deriveDigitalRemedy(facts: RemedyFacts): DigitalRemedyVerdict {
  const reasons = new Set<DigitalRemedyReason>();

  if (facts.fulfilmentStatus === 'refunded') {
    reasons.add('already_refunded');
    return { outcome: 'not_eligible', reasons: [...reasons].sort() };
  }

  // Nothing has been bought upstream yet: the cheapest remedy in the domain, and
  // the only one with no supplier consequence at all.
  if (facts.purchaseOrderStatus === null || facts.purchaseOrderStatus === 'pending') {
    reasons.add('not_yet_procured');
    return { outcome: 'cancel_before_procurement', reasons: [...reasons].sort() };
  }

  // In flight. A cancellation here is a request to the SUPPLIER, and whether it
  // lands is their answer, not ours.
  if (facts.purchaseOrderStatus === 'preflighted' || facts.purchaseOrderStatus === 'submitting') {
    reasons.add('procurement_in_flight');
    return { outcome: 'cancel_procurement', reasons: [...reasons].sort() };
  }

  // The state where nobody knows whether money was spent. Refunding the customer
  // now is defensible and buying again is not — but the decision is a human's,
  // because the recovery sweep may resolve it within the minute.
  if (facts.purchaseOrderStatus === 'ambiguous') {
    reasons.add('procurement_outcome_unknown');
    return { outcome: 'manual_review', reasons: [...reasons].sort() };
  }

  // Procurement failed outright: there is nothing to take back, and the customer
  // is owed their money whatever the withdrawal terms say — a waiver waives a
  // change of mind, not a delivery that never happened.
  if (
    facts.purchaseOrderStatus === 'rejected' ||
    facts.purchaseOrderStatus === 'failed' ||
    facts.purchaseOrderStatus === 'cancelled'
  ) {
    reasons.add('not_yet_procured');
    return { outcome: 'refund_customer', reasons: [...reasons].sort() };
  }

  if (!facts.artifactDelivered) {
    // Accepted upstream, nothing handed over yet. The supplier owes Mercaria
    // either the artifact or a credit; the customer is owed their money now.
    reasons.add('procurement_in_flight');
    return { outcome: 'refund_customer', reasons: [...reasons].sort() };
  }

  // A reported fault takes precedence over everything below it: a key that does
  // not work was never the thing the customer bought, whatever they clicked.
  if (facts.buyerReportedFault || facts.redemptionState === 'invalid') {
    reasons.add('artifact_reported_invalid');
    return {
      outcome: facts.replacementSupported ? 'replace_artifact' : 'supplier_credit_pending',
      reasons: [...reasons].sort(),
    };
  }

  if (facts.redemptionState === 'redeemed') {
    reasons.add('artifact_redeemed');
    if (facts.withdrawalWaived) reasons.add('withdrawal_waived');
    return { outcome: 'not_eligible', reasons: [...reasons].sort() };
  }

  // A capability that hands over no secret cannot be "revealed", so its remedy
  // turns on whether the activation happened — which the ecosystem reports, and
  // which is the same `redeemed` fact one branch up.
  if (!isSecretBearingCapability(facts.capability)) {
    if (facts.redemptionState === 'unredeemed') {
      reasons.add('artifact_not_revealed');
      return { outcome: 'refund_customer', reasons: [...reasons].sort() };
    }
    reasons.add('activation_completed');
    return { outcome: 'manual_review', reasons: [...reasons].sort() };
  }

  if (!facts.revealed) {
    // Delivered but never looked at. The buyer has had no opportunity to use it,
    // so a waiver has not bitten and the refund is clean.
    reasons.add('artifact_not_revealed');
    return { outcome: 'refund_customer', reasons: [...reasons].sort() };
  }

  reasons.add('artifact_revealed');
  if (facts.withdrawalWaived) {
    reasons.add('withdrawal_waived');
    // Revealed, waived, and the ecosystem cannot tell us whether it was used.
    // This is the case the whole vocabulary exists for: the answer is a person,
    // not a guess in either direction.
    return {
      outcome: facts.redemptionState === 'unredeemed' ? 'refund_customer' : 'manual_review',
      reasons: [...reasons].sort(),
    };
  }
  return { outcome: 'manual_review', reasons: [...reasons].sort() };
}
