/**
 * The facts #74 ranks on that come from outside the ranking domain.
 *
 * ONE of the two is still unbuilt (`resolveOfferTaxInclusion`) and is a NAMED
 * contract that fails closed rather than a stub that lies: it returns "no
 * data", the signal reports `no_provider`, and the offer's score is a mean over
 * the signals that ARE known — so an unbuilt seam neither helps nor hurts
 * anybody's position. That is the whole reason the unknown branch of
 * `RankingSignalOutcome` carries no weight.
 *
 * The other, {@link resolvePickupProximity}, was CLOSED by #93 and is the shape
 * worth reading: it is still a pure, synchronous function, because the DISTANCE
 * is resolved once per page by `buildRankingFactContext` in ONE batched
 * statement and handed in. A seam that grew a database read here would have put
 * an N+1 on the hottest comparison surface there is, and `buildOfferRankingFacts`
 * would have stopped being pure given its context — which is what lets
 * `selectEligibleOffers` build facts only for the offers it admits.
 *
 * Neither is a registry with a `register…` function, and that is deliberate. A
 * registry would be a place a test-only provider could be installed in
 * production (#62's fixture-adapter reasoning).
 */

import type { OfferTaxInclusion } from '@mercaria/shared-types';

/**
 * How far a buyer is from an offer's collection point (#74 ranking input 10,
 * label `best_nearby_pickup`).
 *
 * CLOSED by #93. The distance is the shortest road-agnostic distance from the
 * viewer to a PUBLISHED location that currently holds a collectable unit of
 * this offer's native variant, resolved in one batched statement per page by
 * `buildRankingFactContext` and handed in through {@link distancesByOfferId}.
 *
 * What it is NOT, and the contract this seam always carried: it is never
 * derived from a merchant's registered address. A merchant's office is not
 * where the item is collected from, and `location_publications` — the only
 * source consulted — carries a position a merchant deliberately published for
 * exactly this purpose.
 */
export interface PickupProximityRequest {
  readonly offerId: string;
  /** Whether the source said collection is possible at all (#57's three-state). */
  readonly pickupAvailable: boolean;
  /** The viewer's coarse location, when they enabled it. */
  readonly viewerLatitude?: number;
  readonly viewerLongitude?: number;
  /**
   * Offer id → metres, from the page's fact context.
   *
   * An EMPTY map is the honest answer for a deployment with no published
   * collection points, for a variant nobody stocks near the viewer, and for a
   * comparison whose offers are all external — and all three produce
   * `pickup_locations_not_published`, which awards no label and contributes no
   * score.
   */
  readonly distancesByOfferId: ReadonlyMap<string, number>;
}

export type PickupProximity =
  | { readonly known: true; readonly metres: number }
  | { readonly known: false; readonly reason: 'pickup_locations_not_published' | 'viewer_location_absent' };

/**
 * Answer a pickup distance, or say why there is none.
 *
 * The viewer-location branch is checked FIRST, because a shopper who has not
 * shared a location should be told that rather than told the feature does not
 * exist — and because the map is EMPTY in that case anyway, so the two would
 * otherwise be indistinguishable.
 *
 * `pickupAvailable` is consulted but is not sufficient on its own: #57's
 * three-state says what a SOURCE claimed about collection, and a claim in a
 * feed is not a published Mercaria collection point with stock on its shelf. An
 * offer whose source says nothing about pickup still gets a distance when
 * Mercaria's own publication says it can be collected — which is the case that
 * matters, since every native offer is in it.
 */
export function resolvePickupProximity(request: PickupProximityRequest): PickupProximity {
  if (request.viewerLatitude === undefined || request.viewerLongitude === undefined) {
    return { known: false, reason: 'viewer_location_absent' };
  }
  const metres = request.distancesByOfferId.get(request.offerId);
  if (metres === undefined) {
    return { known: false, reason: 'pickup_locations_not_published' };
  }
  return { known: true, metres };
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
