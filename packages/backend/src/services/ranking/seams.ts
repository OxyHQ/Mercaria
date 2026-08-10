/**
 * The two facts #74 ranks on that nothing in Mercaria publishes yet.
 *
 * Both are NAMED contracts that fail closed rather than stubs that lie: each
 * returns "no data", the signal that reads it reports `no_provider`, the label
 * that depends on it is never awarded, and the offer's score is a mean over the
 * signals that ARE known — so an unbuilt seam neither helps nor hurts anybody's
 * position. That is the whole reason the unknown branch of
 * `RankingSignalOutcome` carries no weight: a seam nobody has filled in cannot
 * quietly become a zero score against every offer.
 *
 * Neither is a registry with a `register…` function, and that is deliberate. A
 * registry would be a place a test-only provider could be installed in
 * production (#62's fixture-adapter reasoning), and both of these are single
 * facts a single owning issue supplies from a table it will create — one
 * function body each, replaced in the change that creates the table.
 */

import type { OfferTaxInclusion } from '@mercaria/shared-types';

/**
 * How far a buyer is from an offer's collection point (#74 ranking input 10,
 * label `best_nearby_pickup`).
 *
 * ALWAYS unavailable today, and the reason is #93's rather than an omission
 * here: pickup fails closed at checkout because no publication, freshness or
 * collectable-inventory state exists for a collection point, so there is no
 * location to measure a distance TO. `assertPickupLocationEligible` refuses
 * every pickup for the same reason.
 *
 * #93 replaces this function's body. The contract it must satisfy: given an
 * offer's pickup availability and the viewer's coarse location, answer a
 * distance in METRES or say why not — and never invent one from a merchant's
 * registered address, because a merchant's office is not where the item is
 * collected from.
 */
export interface PickupProximityRequest {
  readonly offerId: string;
  /** Whether the source said collection is possible at all (#57's three-state). */
  readonly pickupAvailable: boolean;
  /** The viewer's coarse location, when they enabled it. */
  readonly viewerLatitude?: number;
  readonly viewerLongitude?: number;
}

export type PickupProximity =
  | { readonly known: true; readonly metres: number }
  | { readonly known: false; readonly reason: 'pickup_locations_not_published' | 'viewer_location_absent' };

/**
 * Answer a pickup distance, or say why there is none.
 *
 * The viewer-location branch is checked FIRST and answered honestly even though
 * the next line refuses everything anyway: a shopper who has not shared a
 * location should be told that, not told the feature does not exist, and the
 * distinction is what makes the reason code useful the day #93 lands.
 */
export function resolvePickupProximity(request: PickupProximityRequest): PickupProximity {
  if (request.viewerLatitude === undefined || request.viewerLongitude === undefined) {
    return { known: false, reason: 'viewer_location_absent' };
  }
  return { known: false, reason: 'pickup_locations_not_published' };
}

/**
 * Whether an offer's published price includes tax (#74 ranking input 3).
 *
 * ALWAYS `unknown` today, and that is a fact about the DATA rather than a gap in
 * this module: `offers` has no tax column, no ingestion adapter publishes one,
 * and #94's registry reserves `price` and `shipping_cost` as offer facts without
 * reserving a tax-inclusion key. Guessing from the market would be the worst
 * available answer — a Spanish feed usually quotes tax-inclusive and a US one
 * usually does not, and "usually" is exactly the kind of inference that puts a
 * 21% error into a total comparison.
 *
 * Whoever adds the column replaces this body. Until then the signal reports
 * `no_provider` and contributes nothing in either direction, which is the only
 * treatment that is neither a guess nor a penalty.
 */
export function resolveOfferTaxInclusion(): OfferTaxInclusion {
  return 'unknown';
}
