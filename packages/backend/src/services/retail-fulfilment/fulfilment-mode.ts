/**
 * Who books the transport for a supplier-fulfilled retail order (#126
 * §"Supplier-to-Moovo fulfilment modes").
 *
 * Two pure functions and no I/O, because the two questions they answer are
 * asked at different times against different evidence and must not be able to
 * borrow each other's inputs:
 *
 *  - {@link determinePermittedFulfilmentMode} is asked at CHECKOUT, against the
 *    versioned supply agreement alone. Its answer is snapshotted with the order
 *    and never revisited — a contractual grant that could change after a sale
 *    would let a later agreement version reinterpret what a buyer bought under.
 *  - {@link chooseFulfilmentMode} is asked LATER, when a supplier has accepted
 *    and there is something to hand over. Its answer is written exactly once.
 *
 * Collapsing them into one function would mean either freezing a mode nobody
 * could yet know at checkout (Mode A needs verified package facts, which only
 * exist after acceptance) or leaving the contractual half rewritable.
 *
 * ## Neither function reads a carrier, and neither may learn to
 *
 * Not one input below names a carrier, a service level, a transit time or a
 * price. Mode A is *"Moovo books the fleet or carrier"* — WHICH carrier is
 * Moovo's decision, and a Mercaria function that took carrier availability as
 * an input would be the first half of the carrier integration #126 acceptance 2
 * forbids. `retail-logistics-isolation.test.ts` fails the build if this module
 * grows one.
 *
 * ## An undecided mode is never a default
 *
 * {@link chooseFulfilmentMode} returns a discriminated union whose `undecided`
 * branch has no `mode` property at all, so a caller cannot read "we do not know
 * yet" as `supplier_controlled` without writing the coercion out loud. That is
 * #122's downgrade rule applied to a decision rather than to an answer: every
 * missing fact lands on the value that BLOCKS, and here blocking means no
 * transport is arranged rather than one arranged the wrong way.
 */

import type {
  RetailFulfilmentModeChoice,
  RetailFulfilmentModeDecision,
  RetailPermittedFulfilmentMode,
} from '@mercaria/shared-types';

/**
 * The contractual facts the permitted mode is decided from.
 *
 * All three come off ONE `supplier_agreements` version. `inForce` is the
 * caller's answer from `services/procurement/agreement-scope.ts`, which is the
 * fail-closed authority on whether an agreement is approved, current and covers
 * the destination — re-deriving it here would be a second answer to a question
 * that domain already owns, and the two would disagree on the day one of them
 * learned about a new scope column.
 */
export interface RetailFulfilmentModeFacts {
  /** The agreement is approved, within its window, and covers this sale. */
  inForce: boolean;
  /** `supplier_agreements.dropship_rights_granted` — the supplier may ship to
   * Mercaria's customer under Mercaria's name, using its own carriage. */
  dropshipRightsGranted: boolean;
  /** `supplier_agreements.moovo_label_dispatch_permitted` — the supplier will
   * dispatch against a Moovo-issued label and pickup. */
  moovoLabelDispatchPermitted: boolean;
}

/**
 * What the agreement permits — or that it permits nothing, which refuses the
 * sale rather than choosing a mode.
 *
 * `either` is a real answer and not a fudge: an agreement can genuinely grant
 * both, and recording that is what lets the operational choice later prefer
 * Mode A when package facts arrive and fall back to Mode B when they do not,
 * without a second contractual read at a moment when the agreement may have
 * been superseded.
 */
export function determinePermittedFulfilmentMode(
  facts: RetailFulfilmentModeFacts,
): RetailFulfilmentModeDecision {
  if (!facts.inForce) {
    return { outcome: 'refused', reason: 'agreement_not_in_force' };
  }
  if (facts.moovoLabelDispatchPermitted && facts.dropshipRightsGranted) {
    return { outcome: 'permitted', permitted: 'either' };
  }
  if (facts.moovoLabelDispatchPermitted) {
    return { outcome: 'permitted', permitted: 'moovo_controlled' };
  }
  if (facts.dropshipRightsGranted) {
    return { outcome: 'permitted', permitted: 'supplier_controlled' };
  }
  return { outcome: 'refused', reason: 'no_dispatch_right_granted' };
}

/**
 * The operational facts the actual mode is chosen from.
 *
 * `packageFactsVerified` is #126 Mode A requirement 2 — *"package dimensions,
 * weight, origin and readiness come from verified supplier facts"*. Mercaria
 * stores none of those (they are Moovo's, and the supplier reports them through
 * #124/#125's adapter), so this is a boolean the CALLER answers from the
 * adapter's own report rather than a lookup this module performs. Today no
 * adapter reports them, so the honest value is `false` and Mode A is
 * unreachable — which is stated rather than hidden, and is why the undecided
 * reason names the missing fact instead of saying "not supported".
 *
 * `moovoBookingAvailable` is the port's readiness, which is `false` until #156
 * and #159 land.
 */
export interface RetailFulfilmentModeChoiceFacts {
  permitted: RetailPermittedFulfilmentMode;
  /** The supplier has accepted the purchase order for these lines. */
  procurementAccepted: boolean;
  /** The supplier has reported verified package readiness (#126 Mode A req 2). */
  packageFactsVerified: boolean;
  /** A registered Moovo port can book transport (#156/#159). */
  moovoBookingAvailable: boolean;
}

/**
 * Which mode is actually used, or why that is not yet answerable.
 *
 * Mode A is preferred where it is permitted AND both of its preconditions hold,
 * because it is the mode in which Mercaria — the seller of record, and the
 * party a buyer will ask — controls the carriage. Falling back to Mode B when
 * one of them is missing is a real choice and not a degradation: a supplier
 * booking its own carrier is a complete fulfilment path, and refusing it
 * because Mode A was unavailable would strand a paid order for a preference.
 *
 * With `permitted: 'moovo_controlled'` and Mode A's preconditions unmet there
 * is nothing to fall back TO, so the answer is `undecided` naming the missing
 * precondition — never `supplier_controlled`, which the agreement did not
 * grant, and which the row's own CHECK would refuse anyway.
 */
export function chooseFulfilmentMode(
  facts: RetailFulfilmentModeChoiceFacts,
): RetailFulfilmentModeChoice {
  if (!facts.procurementAccepted) {
    return { outcome: 'undecided', reason: 'procurement_not_accepted' };
  }

  const moovoPermitted = facts.permitted === 'moovo_controlled' || facts.permitted === 'either';
  const supplierPermitted =
    facts.permitted === 'supplier_controlled' || facts.permitted === 'either';

  if (moovoPermitted && facts.packageFactsVerified && facts.moovoBookingAvailable) {
    return { outcome: 'chosen', mode: 'moovo_controlled' };
  }
  if (supplierPermitted) {
    return { outcome: 'chosen', mode: 'supplier_controlled' };
  }
  // Only `moovo_controlled` is permitted and one of its preconditions is
  // missing. The reason names the FIRST unmet one, and package facts come
  // first because that is the one a supplier can supply — reporting "Moovo is
  // unavailable" for an order whose supplier has not confirmed what it is
  // handing over would send an operator to the wrong system.
  return {
    outcome: 'undecided',
    reason: facts.packageFactsVerified ? 'moovo_booking_unavailable' : 'package_facts_unverified',
  };
}
