/**
 * When a retail buyer's rights start and stop — pure, total, and the ONE place
 * the statutory/commercial precedence is expressed (#127 §"Customer eligibility
 * and policy").
 *
 * ## Two clocks, never collapsed
 *
 * Rules 2 and 3 ask that statutory and commercial policy be recorded separately
 * and that a supplier's narrower policy never silently reduce a statutory right.
 * A single effective deadline cannot express the second: by the time the two are
 * one number the narrower one has already won and nothing records that it did.
 *
 * So {@link deriveRetailServiceDeadlines} returns BOTH, both are stored on the
 * request, and the effective one is `resolveEffectiveServiceDeadline`'s LATER of
 * them. `Math.max` on a deadline can only move it outwards, so there is no input
 * pair for which this shortens a buyer's rights — which a property test drives
 * over randomized pairs rather than asserting in a comment.
 *
 * ## Nothing here reads a supply agreement, and that is the point
 *
 * An agreement's `returnsResponsibility` describes Mercaria's RECOURSE against a
 * supplier. Reading it as a bound on what a buyer may ask for is the exact
 * substitution ADR 0004 D2.6 forbids, and it is a plausible-looking change — the
 * agreement is right there and it says "no returns after 14 days". This module
 * imports no procurement repository and `retail-service-isolation.test.ts` fails
 * the build if it starts to.
 *
 * ## The windows come from the ORDER, not from today's constants
 *
 * #126 snapshots the four consumer windows onto `retail_order_role_snapshots` in
 * the order's own transaction. A buyer asking in two years what their return
 * window was is answered from their order — so every function below takes the
 * SNAPSHOT and none of them reads `currentRetailCustomerTerms()`.
 */

import type {
  RetailPolicyBasis,
  RetailServiceRequestKind,
  RetailServiceWindow,
} from '@mercaria/shared-types';
import { RETAIL_SERVICE_REQUEST_POLICIES } from '@mercaria/shared-types';

/**
 * The four windows a retail order was bought under, read off #126's snapshot.
 *
 * Numbers rather than a version pointer, because a pointer is only as durable as
 * the code that can still resolve it — #126's own reasoning, and this is the
 * consumer that makes it matter.
 */
export interface RetailTermsSnapshot {
  readonly customerTermsVersion: string;
  readonly cancellationWindowHours: number;
  readonly withdrawalWindowDays: number;
  readonly returnWindowDays: number;
  readonly warrantyMonths: number;
}

/**
 * The instants a deadline can be anchored on.
 *
 * `deliveredAt` is the anchor every goods-based right runs from, and
 * `dispatchedAt` is the one a cancellation runs against. Both are read from the
 * order's STATUS HISTORY rather than from its current status: an order that
 * shipped and was then partially refunded reads `partially_refunded` today, and
 * asking the current status "is it shipped" would offer a cancellation on goods
 * already with the buyer. #110 found that exact bug and this is the same read.
 *
 * A NULL `deliveredAt` on a shipped order is ordinary — Moovo owns delivery
 * confirmation (#126) and no adapter reports one today, so most retail orders
 * have a dispatch instant and no delivery instant. The consequence is stated
 * rather than hidden: {@link deriveRetailServiceDeadlines} then anchors on
 * dispatch, which starts the buyer's clock EARLIER than the law does and is the
 * wrong direction. It is corrected by `anchorGraceDays` below.
 */
export interface RetailOrderClock {
  readonly placedAt: Date;
  readonly dispatchedAt: Date | null;
  readonly deliveredAt: Date | null;
}

/**
 * Days added when a goods-based window has to be anchored on DISPATCH because no
 * delivery evidence exists.
 *
 * The statutory clock runs from the day the consumer takes physical possession.
 * Anchoring on dispatch starts it earlier, which shortens the buyer's rights —
 * so the anchor carries a grace equal to a generous transit time and the buyer
 * gets the benefit of Mercaria's ignorance rather than paying for it.
 *
 * It is a CONSTANT and not a setting: a deployment able to tune "how much
 * benefit of the doubt does a buyer get" would tune it to zero, and the number
 * exists because Mercaria cannot observe delivery, not because anybody chose a
 * service level.
 */
export const RETAIL_UNKNOWN_DELIVERY_GRACE_DAYS = 14;

/** The two deadlines a request is decided against, both stored. */
export interface RetailServiceDeadlines {
  readonly statutoryAt: Date | null;
  readonly commercialAt: Date | null;
}

/** `days` after `from`, as a new `Date`. */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** `hours` after `from`, as a new `Date`. */
function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/**
 * `months` after `from`, calendar-correct.
 *
 * `setUTCMonth` clamps a 31st into a short month, which is the behaviour a
 * guarantee period wants: three years from 31 January is 31 January, and three
 * years from 31 August is 31 August. Adding `months * 30` days instead loses
 * five days over three years — small, and on the side that takes a right away.
 */
function addMonths(from: Date, months: number): Date {
  const out = new Date(from.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/**
 * When goods-based rights start counting, and whether Mercaria actually knows.
 *
 * Returns the anchor AND whether it is a real delivery instant, because the
 * caller has to add the grace when it is not — and a function returning only the
 * date would leave that decision at a call site where it can be forgotten.
 */
export function retailPossessionAnchor(
  clock: RetailOrderClock,
): { readonly at: Date; readonly delivered: boolean } | null {
  if (clock.deliveredAt !== null) return { at: clock.deliveredAt, delivered: true };
  if (clock.dispatchedAt !== null) return { at: clock.dispatchedAt, delivered: false };
  return null;
}

/**
 * The two deadlines for one request kind on one order.
 *
 * `null` on both means the kind has no window at all — a wrong item, a lost
 * parcel, a recall and a chargeback are not bounded by a withdrawal clock, and
 * #127 policy rule 8 says so outright. Giving them one would be the mechanism by
 * which a recall expires.
 *
 * The statutory side is the EU minimum the order's market grants and the
 * commercial side is Mercaria's published policy, which is longer for returns
 * (30 days against 14) and identical for the guarantee. Where the two coincide
 * both are returned rather than one being suppressed: a request has to record
 * that Mercaria checked both, or "we applied the statutory one" and "we never
 * looked" are the same row.
 */
export function deriveRetailServiceDeadlines(input: {
  readonly kind: RetailServiceRequestKind;
  readonly terms: RetailTermsSnapshot;
  readonly clock: RetailOrderClock;
}): RetailServiceDeadlines {
  const window: RetailServiceWindow = RETAIL_SERVICE_REQUEST_POLICIES[input.kind].window;
  if (window === 'none') return { statutoryAt: null, commercialAt: null };

  if (window === 'cancellation') {
    // A cancellation runs from the PURCHASE, not from possession: it is the
    // right to stop something that has not arrived. There is no EU statutory
    // pre-dispatch cancellation right distinct from withdrawal, so this window
    // is entirely Mercaria's own and the statutory side is honestly absent.
    return {
      statutoryAt: null,
      commercialAt: addHours(input.clock.placedAt, input.terms.cancellationWindowHours),
    };
  }

  const anchor = retailPossessionAnchor(input.clock);
  if (anchor === null) {
    // Nothing has left a warehouse. A goods-based right has not started, which
    // is not the same as having expired — both deadlines are absent and
    // `deriveRetailServiceEligibility` refuses on `not_yet_delivered` rather
    // than on `window_closed`, because those lead to opposite next actions.
    return { statutoryAt: null, commercialAt: null };
  }
  const from = anchor.delivered
    ? anchor.at
    : addDays(anchor.at, RETAIL_UNKNOWN_DELIVERY_GRACE_DAYS);

  if (window === 'warranty') {
    const at = addMonths(from, input.terms.warrantyMonths);
    // The legal conformity guarantee and Mercaria's own commercial warranty are
    // the same period today. Both are returned so a later divergence is a
    // constant change rather than a shape change.
    return { statutoryAt: at, commercialAt: at };
  }

  // `withdrawal` and `return` produce the same PAIR, and that is not a missing
  // branch. The statutory withdrawal right is the floor under both — a buyer
  // returning a damaged item does not lose it by naming a different reason — and
  // Mercaria's own 30-day return policy stands beside it whatever the reason is.
  // The LATER-of rule then picks, and `decidingPolicyBasis` says which won.
  return {
    statutoryAt: addDays(from, input.terms.withdrawalWindowDays),
    commercialAt: addDays(from, input.terms.returnWindowDays),
  };
}

/**
 * Which basis actually decided a deadline, for the explanation a buyer gets.
 *
 * #127 policy rule 4 asks that the policy versions USED be preserved, and rule 5
 * asks that the states be explained. "Your return window is 30 days because
 * Mercaria's policy is longer than the 14 the law requires" is a different
 * sentence from "your return window is 14 days", and only this function can tell
 * a client which to render.
 */
export function decidingPolicyBasis(deadlines: RetailServiceDeadlines): RetailPolicyBasis | null {
  if (deadlines.statutoryAt === null && deadlines.commercialAt === null) return null;
  if (deadlines.statutoryAt === null) return 'commercial';
  if (deadlines.commercialAt === null) return 'statutory';
  return deadlines.commercialAt.getTime() > deadlines.statutoryAt.getTime()
    ? 'commercial'
    : 'statutory';
}
