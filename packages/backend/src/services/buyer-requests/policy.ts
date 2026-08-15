/**
 * Server policy: may THIS order be cancelled, may it be returned, and by when
 * (#110 cancellation rule 1, return field 9).
 *
 * ## Pure, and that is the point
 *
 * No database, no configuration and no clock beyond the one passed in — so the
 * whole eligibility matrix is a table a test can drive, and so the SAME
 * function decides what the buyer's UI renders and what the submit path
 * enforces. Two spellings of "is this cancellable" would disagree eventually,
 * and the failure mode is a button that exists and then 409s.
 *
 * ## Eligibility is DERIVED, never stored
 *
 * The `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, and for the same reason: the inputs are the live order status, the live
 * payment status, the live status HISTORY, any open request and the clock —
 * five things across four tables this domain does not own. A stored verdict
 * would go stale the moment a seller pressed "shipped", and the place it must
 * not be stale is a button that says "cancel my order".
 *
 * ## What decides the two windows
 *
 * A cancellation closes when the goods LEAVE, which the status history knows
 * exactly. A return opens when the goods leave and closes a policy window after
 * they arrive — and the anchor is the DELIVERED event when there is one, else
 * the SHIPPED event, because a seller who never marks an order delivered must
 * not be able to run a buyer's return window out by inaction.
 */

import type {
  CancellationCompletionMode,
  CancellationIneligibilityReason,
  ReturnIneligibilityReason,
} from '@mercaria/shared-types';
import { DEFAULT_RETURN_WINDOW_DAYS } from '@mercaria/shared-types';

/**
 * The order facts an eligibility decision reads, and no others.
 *
 * Structural rather than `OrderRecord`, the `OrderAccessFacts` device: naming
 * the seven is what makes it obvious that a buyer's contact, a total, a payment
 * reference and a seller's payout account are not among them.
 */
export interface BuyerRequestOrderFacts {
  readonly id: string;
  readonly status: string;
  /**
   * The commercial model the order was sold under (#123).
   *
   * Checked FIRST in both derivations: a `mercaria_retail` order has no store,
   * so #110's whole decision path — `requireStorePermission` on the order's
   * store — cannot reach it, and a request filed here would sit forever with
   * nobody able to decide it. #127 owns those orders and answers the same buyer
   * with a decider that exists.
   */
  readonly commercialRole: string;
  readonly paymentStatus: string;
  readonly shippingMethod: string;
  /** Non-null for an order imported from a connected platform. */
  readonly sourceExternalId: string | null;
  /** Every status the order has ever reached, with its instant. */
  readonly statusHistory: readonly { readonly status: string; readonly at: Date }[];
  /** The seller's store return window in days, or `null` for a P2P seller. */
  readonly storeReturnWindowDays: number | null;
}

/**
 * Whether a cancellation may be opened, and the safe reason when it may not.
 *
 * A STRING discriminant, not `eligible: true | false`. This backend compiles
 * with `strict: false`, and without `strictNullChecks` TypeScript does not
 * narrow a union on the truthiness of a boolean-literal discriminant — so
 * `if (!verdict.eligible)` leaves the caller holding the whole union and
 * reading `.reason` off it does not compile. #68 hit this and wrote it up in
 * `AGENTS.md`; it is not a style choice.
 */
export type CancellationEligibility =
  | { readonly verdict: 'eligible'; readonly mode: CancellationCompletionMode }
  | { readonly verdict: 'ineligible'; readonly reason: CancellationIneligibilityReason };

/** Whether a return may be opened, and the safe reason when not. Same rule. */
export type ReturnEligibility =
  | { readonly verdict: 'eligible'; readonly windowEndsAt: Date }
  | { readonly verdict: 'ineligible'; readonly reason: ReturnIneligibilityReason };

/** The statuses from which nothing further can be asked for. */
const CLOSED_ORDER_STATUSES = new Set(['cancelled', 'refunded']);

/** The first instant the order reached a status, or `null` if it never did. */
function reachedAt(facts: BuyerRequestOrderFacts, status: string): Date | null {
  let earliest: Date | null = null;
  for (const event of facts.statusHistory) {
    if (event.status !== status) continue;
    if (earliest === null || event.at.getTime() < earliest.getTime()) earliest = event.at;
  }
  return earliest;
}

/**
 * When the goods left, if they have.
 *
 * Read from the HISTORY rather than from the current status, because an order
 * that shipped and was then partially refunded reads `partially_refunded` today
 * — and asking "is it shipped" of the current status would answer no and offer
 * a cancellation on goods that are already with the buyer.
 */
export function dispatchedAt(facts: BuyerRequestOrderFacts): Date | null {
  return reachedAt(facts, 'shipped');
}

/** The anchor a return window is measured from. See the module docblock. */
export function returnWindowAnchor(facts: BuyerRequestOrderFacts): Date | null {
  return reachedAt(facts, 'delivered') ?? reachedAt(facts, 'shipped');
}

/**
 * The window this order's seller offers, in days.
 *
 * `stores.policies_return_window_days` when the seller is a store — a real
 * merchant setting that already exists and is already editable — and
 * {@link DEFAULT_RETURN_WINDOW_DAYS} for a P2P seller, who has no store row to
 * carry one. The P2P default is deliberately the generous direction: a person
 * selling one used item has stated no policy, and inventing a shorter window on
 * their behalf would take a consumer right away by omission.
 */
export function returnWindowDays(facts: BuyerRequestOrderFacts): number {
  return facts.storeReturnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS;
}

/**
 * May this order be cancelled, and how would it be undone?
 *
 * The order of the checks is the policy. `order_already_closed` comes first
 * because it is the only one that means "nothing is owed"; `external_order`
 * before dispatch because an imported order's status is somebody else's fact
 * and reading it as a Mercaria lifecycle would offer a cancellation Mercaria
 * cannot perform; and the OPEN-request check is the caller's, not this
 * function's — see {@link cancellationEligibilityWithOpenRequest}.
 */
export function resolveCancellationEligibility(
  facts: BuyerRequestOrderFacts,
): CancellationEligibility {
  if (facts.commercialRole === 'mercaria_retail') {
    return { verdict: 'ineligible', reason: 'retail_order' };
  }
  if (CLOSED_ORDER_STATUSES.has(facts.status)) {
    return { verdict: 'ineligible', reason: 'order_already_closed' };
  }
  if (facts.sourceExternalId !== null) {
    return { verdict: 'ineligible', reason: 'external_order' };
  }
  if (facts.shippingMethod === 'pickup') {
    // REACHABLE since #93, and the refusal stands rather than being relaxed
    // with it. The branch used to be unreachable because checkout refused every
    // pickup; #93 landed collection, so pickup orders now exist and a buyer
    // holding one arrives here.
    //
    // It still answers `pickup_not_supported`, which is #110's decision and not
    // #93's to overturn: a cancellation that took the `release` path would
    // release a reservation while the collectable-inventory hold nobody has
    // modelled stayed behind. The merchant-side path is real and unaffected —
    // `POST …/pickup/cancel` withdraws the handover, and the existing
    // order-cancel path returns the money and the units. Closing this needs
    // #110 to decide what a buyer-driven cancellation does to a collection
    // hold, which is a decision about inventory rather than about pickup.
    return { verdict: 'ineligible', reason: 'pickup_not_supported' };
  }
  if (dispatchedAt(facts) !== null) {
    return { verdict: 'ineligible', reason: 'order_already_dispatched' };
  }
  // The mode is decided by whether MONEY has moved, never by the status: an
  // order can be `processing` and unpaid on a rail that captures late, and
  // cancelling it must release a reservation rather than attempt a refund of
  // nothing.
  return {
    verdict: 'eligible',
    mode: facts.paymentStatus === 'paid' ? 'refund' : 'release',
  };
}

/** {@link resolveCancellationEligibility}, plus the "somebody already asked" case. */
export function cancellationEligibilityWithOpenRequest(
  facts: BuyerRequestOrderFacts,
  hasOpenRequest: boolean,
): CancellationEligibility {
  if (hasOpenRequest) return { verdict: 'ineligible', reason: 'request_already_open' };
  return resolveCancellationEligibility(facts);
}

/**
 * May this order be returned, and until when?
 *
 * `nothing_left_to_return` is the caller's to supply, because it needs the
 * order's lines and every earlier return's approved quantities — facts this
 * pure function is deliberately not given. See
 * {@link returnEligibilityWithOpenRequest}.
 */
export function resolveReturnEligibility(
  facts: BuyerRequestOrderFacts,
  now: Date,
): ReturnEligibility {
  if (facts.commercialRole === 'mercaria_retail') {
    return { verdict: 'ineligible', reason: 'retail_order' };
  }
  if (CLOSED_ORDER_STATUSES.has(facts.status)) {
    return { verdict: 'ineligible', reason: 'order_already_closed' };
  }
  if (facts.sourceExternalId !== null) {
    return { verdict: 'ineligible', reason: 'external_order' };
  }
  const anchor = returnWindowAnchor(facts);
  if (anchor === null) {
    return { verdict: 'ineligible', reason: 'order_not_delivered' };
  }
  const windowEndsAt = new Date(
    anchor.getTime() + returnWindowDays(facts) * 24 * 60 * 60 * 1_000,
  );
  if (windowEndsAt.getTime() <= now.getTime()) {
    return { verdict: 'ineligible', reason: 'return_window_closed' };
  }
  return { verdict: 'eligible', windowEndsAt };
}

/** {@link resolveReturnEligibility}, plus the two facts it is not given. */
export function returnEligibilityWithOpenRequest(
  facts: BuyerRequestOrderFacts,
  input: { hasOpenRequest: boolean; hasReturnableUnits: boolean },
  now: Date,
): ReturnEligibility {
  if (input.hasOpenRequest) return { verdict: 'ineligible', reason: 'request_already_open' };
  const base = resolveReturnEligibility(facts, now);
  // Checked AFTER the base, so a buyer past their window is told about the
  // window rather than about the units — the deadline is the fact they can act
  // on, and "nothing left" would read as an accusation.
  if (base.verdict === 'eligible' && !input.hasReturnableUnits) {
    return { verdict: 'ineligible', reason: 'nothing_left_to_return' };
  }
  return base;
}
