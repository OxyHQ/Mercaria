/**
 * A checkout refusal that names its REASON, not just its sentence — #106,
 * closing #77's `#106` analytics seam.
 *
 * ## The problem this exists to solve
 *
 * #105 shipped three gates that already run on every guest checkout —
 * `assertGuestSellerTypesAllowed` (ADR 0003 D18's P2P exclusion),
 * `assertDestinationCountrySupported` and `assertSellerGroupsAcceptDestination`
 * — and each raised a generic `conflict()` carrying a sentence. #77 could
 * therefore not measure them: classifying a refusal would have meant matching
 * on message TEXT, which mis-classifies silently the first time somebody
 * improves the wording, and emitting only the ACCEPTED half would have made
 * `guest_eligibility_coverage` read a confident, permanent 100%. So #77
 * declared six event types, emitted none, and recorded that #106 owed each
 * refusal a bounded CODE. This module is that code.
 *
 * ## The vocabulary is the checkout domain's, and the mapping lives elsewhere
 *
 * These reasons are deliberately NOT `AnalyticsReasonCode` values, even though
 * every one of them has a counterpart there. A refusal is a fact about a
 * checkout — it decides an HTTP status and a message a buyer reads — and
 * telemetry is a consumer of that fact, not its owner. `checkout.controller.ts`
 * holds the one exhaustive mapping into the analytics vocabulary, so this
 * domain imports nothing from the analytics domain (the boundary
 * `checkout-contact-isolation.test.ts` scans) and a new reason here fails
 * `tsc` at the mapping until somebody decides how it is measured.
 *
 * ## What a refusal may carry, and what it may not
 *
 * A reason code and the same message #105 already wrote. Never a seller's
 * contact, never a cart's contents, never an email or an address — #105
 * privacy rule 8, unchanged. The seller KEYS a refusal names are already in the
 * message because a mixed cart's remedy is to deselect one of them, and they
 * are not carried as structured data here: the analytics event that reads this
 * takes the OUTCOME and nothing else.
 */

import { ErrorCodes } from '../../utils/api-response.js';
import { MercariaError } from '../../lib/errors/error-codes.js';

/**
 * Why a checkout was refused, as a closed set.
 *
 * Each member names a GATE, not a message. `other` is deliberately absent: an
 * unclassified refusal is the thing this vocabulary exists to eliminate, and
 * providing a bucket for one would make it the path of least resistance. A
 * refusal with no reason stays an ordinary `conflict()` and is measured as
 * nothing, which is honest — the events below are emitted only for classified
 * outcomes.
 */
export const CHECKOUT_REFUSAL_REASONS = [
  /** ADR 0003 D18: a guest may not buy from an individual seller (#112 owns any reversal). */
  'p2p_seller_excluded',
  /** The deployment does not serve the destination country at all. */
  'market_not_supported',
  /** A destination no selected seller can be fulfilled to, or an unpriceable method. */
  'destination_unsupported',
  /** A pickup, a mismatched method, or a destination this deployment cannot complete. */
  'destination_incomplete',
  /** ADR 0001 D9: a seller in the cart cannot be paid. */
  'seller_not_payment_ready',
  /**
   * #107: an operator has withdrawn guest checkout from this platform, market,
   * merchant or fulfilment path. ONE reason for all four dimensions on purpose
   * — which lever fired is an operational fact for a log line, and telling a
   * buyer's client which dimension of a rollout they fell outside would let it
   * enumerate the levers by varying one input at a time.
   */
  'guest_rollout_blocked',
  /**
   * #107: the #85 merchant-activation seam refused. Separate from
   * `seller_not_payment_ready` because the two say different things about the
   * same seller — one cannot be PAID, the other has not ACCEPTED — and the
   * remedies differ (finish Stripe onboarding vs accept the guest-checkout
   * terms). Collapsing them would send a merchant to the wrong screen.
   */
  'guest_seller_not_activated',
  /**
   * #123: a `mercaria_retail` line failed the ten-way conjunction — ADR 0004
   * D3's fail-closed rule made visible at the gate.
   *
   * ONE reason for all ten conditions, the `guest_rollout_blocked` decision
   * applied to a harder case. Which condition fired is genuinely sensitive
   * here rather than merely operational: `supplier_stock_unknown` versus
   * `cost_incomplete` versus `retail_disabled` would let a client vary one
   * input at a time and read out a supplier's live stock position, Mercaria's
   * wholesale cost coverage and the operator's incident levers. The
   * {@link RetailCheckoutRefusal} vocabulary IS carried — into the log line and
   * the operator trace, where the reader is already authorized.
   */
  'retail_line_ineligible',
  /**
   * #85: this seller may not currently sell. ONE reason for three levers — an
   * unaccepted marketplace fee schedule, the merchant's own pause and an
   * operator's safety hold — the `guest_rollout_blocked` decision applied to the
   * authenticated path. A buyer cannot act on which of the three fired, and a
   * client able to vary one input at a time could read out whether a particular
   * merchant is under an operator hold, which is a moderation fact about
   * somebody else's business.
   *
   * Deliberately NOT `seller_not_payment_ready`: one seller cannot be PAID, the
   * other has not been ACTIVATED, and the remedies are different screens. It is
   * also not `guest_seller_not_activated`, which is the same word about the
   * GUEST conjunction — collapsing them would make "authenticated checkout is
   * off for this store" and "guest checkout is off for this store"
   * indistinguishable in every metric that reads either.
   */
  'seller_not_activated',
] as const;

/** One of {@link CHECKOUT_REFUSAL_REASONS}. */
export type CheckoutRefusalReason = (typeof CHECKOUT_REFUSAL_REASONS)[number];

/**
 * A `MercariaError` that additionally names which gate refused.
 *
 * A SUBCLASS rather than an extra optional field on `MercariaError`, so the
 * reason cannot be absent when the type says it is present, and so
 * `respondWithError` keeps working unchanged — it reads `code` and
 * `httpStatus`, both of which this inherits.
 */
export class CheckoutRefusal extends MercariaError {
  readonly reason: CheckoutRefusalReason;

  constructor(reason: CheckoutRefusalReason, message: string) {
    super({ code: ErrorCodes.CONFLICT, message });
    this.name = 'CheckoutRefusal';
    this.reason = reason;
  }
}

/** Refuse a checkout, naming the gate. The 409 and the message are unchanged. */
export function checkoutRefusal(
  reason: CheckoutRefusalReason,
  message: string,
): CheckoutRefusal {
  return new CheckoutRefusal(reason, message);
}

/** Whether a caught error is a classified checkout refusal. */
export function isCheckoutRefusal(err: unknown): err is CheckoutRefusal {
  return err instanceof CheckoutRefusal;
}
