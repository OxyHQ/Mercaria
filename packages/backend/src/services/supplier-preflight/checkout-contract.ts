/**
 * What checkout (#123) and purchase-order creation (#124) may ask of a
 * preflight, and the ONE thing this domain refuses unconditionally.
 *
 * PURE, and deliberately so: everything here is a decision about facts the
 * caller already holds, which is what lets #123 wire it into
 * `checkout.service` without that service importing an adapter, a repository or
 * a provider client — the `services/payments/provider-account.service.ts`
 * arrangement, one domain over.
 *
 * ## Nothing here authorizes fulfilment, and now nothing here MENTIONS it
 *
 * #122 states it outright: "a quote is not a PurchaseOrder and cannot
 * independently authorize supplier fulfilment." That is not a limitation of an
 * implementation — it is the boundary, and it stays. #122 published a
 * `authorizeSupplierFulfilment` here that refused unconditionally; #124 moved
 * the function to `services/supplier-orders/fulfilment-authorization.ts`, where
 * it can read the `purchase_orders` row that DOES authorize, rather than
 * relaxing the isolation gate that forbids this domain from importing one.
 *
 * The property is unchanged and is now simply structural: this module has no
 * function that could answer `authorized: true`, because it has no such
 * function at all.
 *
 * ## `assertPreflightSatisfiesCheckout` is complete
 *
 * The revalidation #122 "Checkout integration" asks for before payment creation
 * — a live quote, the right destination, the right quantity, the right
 * currency, the policy versions still in force, the environment matching — is
 * entirely a function of the quote and the live context, so it is implemented
 * here in full. #123 calls it; nothing about it waits on #123.
 */

import type {
  CurrencyCode,
  SupplierPreflightStatus,
  SupplierQuoteUsage,
} from '@mercaria/shared-types';
import { deriveSupplierQuoteUsage } from './quote-usage.js';

/** Why a stored preflight may not fund the checkout being attempted. */
export type SupplierPreflightCheckoutRefusal =
  | 'quote_not_complete'
  | 'quote_not_open'
  | 'quote_expired'
  | 'destination_changed'
  | 'quantity_changed'
  | 'currency_changed'
  | 'offer_changed'
  | 'environment_mismatch'
  | 'sourcing_policy_superseded'
  | 'pricing_policy_superseded'
  | 'eligibility_policy_superseded'
  | 'reservation_expired';

/** The stored answer, as checkout reads it. */
export interface StoredPreflightFacts {
  quoteId: string;
  status: SupplierPreflightStatus;
  environment: string;
  procurementOfferId: string | null;
  quantity: number;
  requestedCurrency: CurrencyCode;
  destinationCountry: string;
  destinationRegion: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  releasedAt: Date | null;
  supersededByQuoteId: string | null;
  sourcingPolicyKey: string | null;
  sourcingPolicyVersion: number | null;
  pricingPolicyKey: string | null;
  pricingPolicyVersion: number | null;
  eligibilityPolicyKey: string | null;
  eligibilityPolicyVersion: number | null;
  /** The supplier's own hold deadline, when a real reservation exists. */
  reservationExpiresAt: Date | null;
}

/** What checkout is actually about to do, right now. */
export interface LiveCheckoutFacts {
  environment: string;
  procurementOfferId: string;
  quantity: number;
  currency: CurrencyCode;
  destinationCountry: string;
  destinationRegion: string | null;
  /** The versions in force at this instant, when the deployment has them. */
  sourcingPolicyKey: string | null;
  sourcingPolicyVersion: number | null;
  pricingPolicyKey: string | null;
  pricingPolicyVersion: number | null;
  eligibilityPolicyKey: string | null;
  eligibilityPolicyVersion: number | null;
  now: Date;
}

/** Satisfied, or refused with every reason it is not. */
export type SupplierPreflightCheckoutDecision =
  | { satisfied: true; usage: SupplierQuoteUsage }
  | { satisfied: false; usage: SupplierQuoteUsage; refusals: readonly SupplierPreflightCheckoutRefusal[] };

/**
 * Whether a stored preflight still answers the question checkout is about to
 * ask (#122 checkout integration 1–6, 8).
 *
 * Collects every refusal rather than short-circuiting: a client whose
 * destination AND quantity both changed needs to re-preflight once, and telling
 * it about one at a time turns a single round trip into several.
 *
 * The policy-version comparison is a NO-OP when the quote recorded no version —
 * a quote states which policies the CALLER was operating under, and a
 * deployment that had none is not thereby retroactively wrong. What it cannot
 * do is disagree: a quote naming version 3 while version 4 is in force is
 * refused, which is #122's "recalculate landed cost and price floor through
 * #120" arriving as a precondition rather than as a recomputation this domain
 * would have no business performing.
 */
export function assertPreflightSatisfiesCheckout(
  stored: StoredPreflightFacts,
  live: LiveCheckoutFacts,
): SupplierPreflightCheckoutDecision {
  const usage = deriveSupplierQuoteUsage(
    {
      consumedAt: stored.consumedAt,
      releasedAt: stored.releasedAt,
      supersededByQuoteId: stored.supersededByQuoteId,
      expiresAt: stored.expiresAt,
    },
    live.now,
  );

  const refusals: SupplierPreflightCheckoutRefusal[] = [];

  if (stored.status !== 'complete') refusals.push('quote_not_complete');
  if (usage === 'expired') refusals.push('quote_expired');
  else if (usage !== 'open') refusals.push('quote_not_open');

  if (stored.environment !== live.environment) refusals.push('environment_mismatch');
  if (stored.procurementOfferId !== live.procurementOfferId) refusals.push('offer_changed');
  if (stored.quantity !== live.quantity) refusals.push('quantity_changed');
  if (stored.requestedCurrency !== live.currency) refusals.push('currency_changed');
  if (
    stored.destinationCountry !== live.destinationCountry ||
    (stored.destinationRegion ?? null) !== (live.destinationRegion ?? null)
  ) {
    refusals.push('destination_changed');
  }

  if (versionMoved(stored.sourcingPolicyKey, stored.sourcingPolicyVersion, live.sourcingPolicyKey, live.sourcingPolicyVersion)) {
    refusals.push('sourcing_policy_superseded');
  }
  if (versionMoved(stored.pricingPolicyKey, stored.pricingPolicyVersion, live.pricingPolicyKey, live.pricingPolicyVersion)) {
    refusals.push('pricing_policy_superseded');
  }
  if (
    versionMoved(
      stored.eligibilityPolicyKey,
      stored.eligibilityPolicyVersion,
      live.eligibilityPolicyKey,
      live.eligibilityPolicyVersion,
    )
  ) {
    refusals.push('eligibility_policy_superseded');
  }

  // A hold that lapsed is worse than no hold at all, because the quote was
  // taken on the assumption that the stock was held. It refuses rather than
  // degrading to "advisory", which would be `assumed_stock_on_timeout` wearing
  // an expiry.
  if (stored.reservationExpiresAt && stored.reservationExpiresAt.getTime() <= live.now.getTime()) {
    refusals.push('reservation_expired');
  }

  return refusals.length === 0
    ? { satisfied: true, usage }
    : { satisfied: false, usage, refusals: [...new Set(refusals)].sort() };
}

/**
 * Whether a recorded version disagrees with the one in force.
 *
 * An unrecorded version is not a disagreement — see the caller's docblock. A
 * version in force where the quote recorded none is likewise not: publishing a
 * first policy version must not invalidate every open quote, and the quote's
 * own TTL bounds how long that can matter.
 */
function versionMoved(
  storedKey: string | null,
  storedVersion: number | null,
  liveKey: string | null,
  liveVersion: number | null,
): boolean {
  if (storedKey === null || storedVersion === null) return false;
  if (liveKey === null || liveVersion === null) return false;
  return storedKey !== liveKey || storedVersion !== liveVersion;
}

/**
 * `authorizeSupplierFulfilment` LIVES ELSEWHERE — see
 * `services/supplier-orders/fulfilment-authorization.ts` (#124).
 *
 * It was published here as a seam that refused unconditionally, because
 * `authorized: true` requires a purchase-order id and
 * `supplier-preflight-isolation.test.ts` forbids this domain from importing the
 * purchase-order repository. #124 did not relax that wall — it is #122's "a
 * quote is not a PurchaseOrder and cannot independently authorize supplier
 * fulfilment", held structurally — so the FUNCTION moved to where it can read a
 * purchase order, and this domain kept the property that made the seam
 * meaningful in the first place: nothing here can authorize anything.
 *
 * This note is not a re-export and must not become one. It is here because a
 * reader looking for the function in the module #122 published it from should
 * find out where it went and why, rather than concluding it was dropped.
 */
