/**
 * The public "is this collectable near me" answer.
 *
 * ## Two halves, two owners (ADR 0013)
 *
 * GoWay answers WHERE: which places near the shopper carry
 * `commerce.mercaria.store`, nearest first, each naming a Mercaria location at
 * a claimant's tier (`findStorePlacesNear`). Mercaria answers WHAT: which of
 * those locations name the same place back and hold a collectable unit, under
 * every commerce predicate it always applied (`findCollectableAtLocations`).
 * GoWay's list already carries each place in full — its hours exceptions
 * included — so nothing is read twice, and `deriveLocationDiscoverability`, the
 * authority, has the last word over that same place.
 *
 * ## The shopper's coordinate lives inside ONE function call
 *
 * It arrives on the request, it is forwarded to GoWay for the length of one
 * request (exactly as the shopper's own browser would send it), and it is gone.
 * What leaves this module is the COARSE CELL (`toLocalArea`) on the echoed
 * origin and in the one structured log line, plus per-location distances
 * rounded outward. Nothing writes it anywhere: the place cache is keyed on
 * place ids and a nearby page is never cached, no analytics event carries it
 * (#77's schema has no column that could), and `pickup-isolation.test.ts`
 * fails the build if this domain learns to emit one.
 *
 * ## Actor eligibility is a SEPARATE, opt-in half of the response
 *
 * #93 nearby rules 11 and 12. A signed-out shopper browsing gets availability
 * and no `checkoutEligibility` at all; a client about to offer a "collect here"
 * button asks for it explicitly. The SET is actor-free, and only the
 * annotation is not.
 *
 * ## Paging is GoWay's
 *
 * A page is one GoWay page of `limit` places. Each place yields every
 * collectable (location, variant) pair the caller asked about, or nothing, so a
 * page may come back shorter than `limit` — or empty — with a next cursor:
 * #68's arrangement, with the cursor carried on the last place CONSIDERED. The
 * cursor is GoWay's own, passed through untouched; GoWay binds it to the point
 * and the radius and refuses it with anything else.
 */

import type {
  CurrencyCode,
  ItemConditionKey,
  Money,
  NearbyLocationResult,
  NearbyPlaceSuggestion,
  NearbyResponse,
  PickupEligibility,
  PublicPickupLocation,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { validationError } from '../../lib/errors/error-codes.js';
import {
  countCollectableAtLocations,
  findCanonicalProductsCollectableAtLocations,
  findCollectableAtLocations,
  findCollectableVariantLocations,
  type NearbyCandidateRow,
  type PlaceLink,
} from '../../db/pickup/nearbyRepository.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findStorePlacesNear, findTowns, type StorePlaceNear } from '../goway/places.js';
import {
  hoursExceptionsOf,
  openStateOf,
  pickupAddressOf,
  placeLinkGaps,
  weeklyHoursOf,
  type PlaceFacts,
  type PlaceLookup,
} from '../goway/place-facts.js';
import { hasGuestMessageTransport } from '../guest-portal/transport.js';
import type { CommerceActor } from '../commerce-actor.js';
import {
  clampNearbyRadius,
  coarsenMetres,
  DEFAULT_NEARBY_RADIUS_METRES,
  distanceBandFor,
  toLocalArea,
  type Coordinate,
} from './geo.js';
import {
  derivePickupEligibility,
  deriveLocationDiscoverability,
  locationAvailabilityState,
  type PickupInventoryFacts,
  type PickupLocationFacts,
} from './eligibility.js';

/** What the route hands over, already parsed. */
export interface NearbyRequest {
  readonly canonicalVariantId?: string;
  readonly canonicalProductId?: string;
  readonly origin: Coordinate;
  readonly originSource: 'device' | 'map_area' | 'published_place';
  readonly radiusMetres?: number;
  readonly country?: string;
  readonly currency?: string;
  readonly conditionKeys?: readonly ItemConditionKey[];
  /** BCP 47 tag each location's name resolves against. */
  readonly locale?: string;
  readonly limit: number;
  /** GoWay's own opaque cursor, as the previous page returned it. */
  readonly cursor?: string;
  /**
   * Whether the caller wants an actor-specific verdict beside each location.
   *
   * Opt-in rather than always: #93 nearby rule 12 asks for the two to be
   * requestable separately, and computing an eligibility nobody reads would
   * mean a browse spending the levers and the guest-transport read per page for
   * nothing.
   */
  readonly withCheckoutEligibility: boolean;
}

/** One page of nearby availability, plus the coarse origin it was answered for. */
export async function findNearbyAvailability(
  request: NearbyRequest,
  actor: CommerceActor,
  at: Date,
): Promise<NearbyResponse> {
  if ((request.canonicalVariantId === undefined) === (request.canonicalProductId === undefined)) {
    throw validationError('Ask about exactly one of `canonicalVariantId` or `canonicalProductId`.');
  }

  const radiusMetres = clampNearbyRadius(request.radiusMetres);
  const cell = toLocalArea(request.origin);

  const page = await findStorePlacesNear({
    latitude: request.origin.latitude,
    longitude: request.origin.longitude,
    radiusMetres,
    limit: request.limit,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.locale === undefined ? {} : { locale: request.locale }),
  });

  const candidates = await findCollectableAtLocations({
    ...(request.canonicalVariantId === undefined ? {} : { canonicalVariantId: request.canonicalVariantId }),
    ...(request.canonicalProductId === undefined ? {} : { canonicalProductId: request.canonicalProductId }),
    links: page.items.map(toLink),
    ...(request.currency === undefined ? {} : { currency: request.currency }),
    ...(request.conditionKeys === undefined ? {} : { conditionKeys: request.conditionKeys }),
  });

  // The COARSE cell, never the coordinate. This log line is the only place a
  // nearby request's position appears at all, and at 0.1° it names a district.
  log.general.debug(
    {
      cell,
      radiusMetres,
      places: page.items.length,
      candidates: candidates.length,
      canonicalVariantId: request.canonicalVariantId,
      canonicalProductId: request.canonicalProductId,
    },
    '[Pickup] nearby availability answered',
  );

  // The place each candidate was found through, exactly as GoWay's list carried it.
  const places = new Map<string, PlaceLookup>(
    page.items.map((item) => [item.placeId, { kind: 'found', place: item.place, stale: false }]),
  );
  const distances = new Map(page.items.map((item) => [linkKey(item), item.distanceMetres]));
  const levers = request.withCheckoutEligibility ? readLevers() : null;

  const results: NearbyLocationResult[] = [];
  for (const candidate of orderByDistance(candidates, distances)) {
    const lookup = places.get(candidate.goWayPlaceId) ?? null;
    const location = locationFactsForNarrowedRow(candidate, lookup);
    const inventory = inventoryFacts(candidate);

    // The derivation is the AUTHORITY over the SQL pre-filter and over the
    // list GoWay returned — see the module docblock. Its refusals are never
    // reported to the shopper; the location simply is not in the page.
    if (deriveLocationDiscoverability(location, inventory, at).length > 0) continue;
    // Narrowing for the compiler: the derivation refuses every lookup but `found`.
    if (lookup?.kind !== 'found') continue;
    const place = lookup.place;
    if (request.country !== undefined && place.address.country !== request.country) continue;

    const eligibility: PickupEligibility | undefined =
      levers === null
        ? undefined
        : derivePickupEligibility({
            location,
            inventory,
            actor: { actorKind: actor.kind, sellerType: 'store' },
            levers,
            at,
          });

    results.push(projectResult(candidate, place, distanceOf(candidate, distances), at, eligibility));
  }

  return {
    results,
    ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
    origin: { source: request.originSource, cell, radiusMetres },
    ...(request.canonicalProductId === undefined ? {} : { canonicalProductId: request.canonicalProductId }),
    ...(request.canonicalVariantId === undefined ? {} : { canonicalVariantId: request.canonicalVariantId }),
  };
}

/** How many towns GoWay is asked for, before each is checked for stock. */
const TOWN_CANDIDATES = 5;

/** How many GoWay places one town check considers — GoWay's own page maximum. */
const TOWN_PLACE_SCAN = 200;

/**
 * The manual-location fallback (#93 acceptance 5).
 *
 * The town a shopper TYPED, resolved by GoWay's geocoder — the gazetteer #93
 * asked for, now that where things are is GoWay's to say (ADR 0013) — and kept
 * only when something is collectable around it: each candidate's cell centre
 * is asked exactly the question picking it will ask (`DEFAULT_NEARBY_RADIUS_METRES`,
 * the same GoWay read and the same SQL predicate), so a town offered here
 * yields results when picked rather than being a dead end wearing a search
 * box. Selecting one hands back a CELL as the next request's origin, so the
 * fallback path never sees a precise coordinate at all.
 *
 * Without a term there is nothing to resolve, and the answer is empty.
 */
export async function suggestNearbyPlaces(input: {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  term?: string;
  country?: string;
  locale?: string;
  limit: number;
}): Promise<readonly NearbyPlaceSuggestion[]> {
  if ((input.canonicalVariantId === undefined) === (input.canonicalProductId === undefined)) {
    throw validationError('Ask about exactly one of `canonicalVariantId` or `canonicalProductId`.');
  }
  const term = input.term?.trim() ?? '';
  if (term === '') return [];

  const towns = (
    await findTowns({
      term,
      limit: TOWN_CANDIDATES,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    })
  ).filter((town) => input.country === undefined || town.country === input.country);

  const suggestions: NearbyPlaceSuggestion[] = [];
  for (const town of towns.slice(0, input.limit)) {
    const cell = toLocalArea(town);
    const near = await findStorePlacesNear({
      ...centreOf(cell),
      radiusMetres: DEFAULT_NEARBY_RADIUS_METRES,
      limit: TOWN_PLACE_SCAN,
    });
    const locationCount = await countCollectableAtLocations({
      ...(input.canonicalVariantId === undefined ? {} : { canonicalVariantId: input.canonicalVariantId }),
      ...(input.canonicalProductId === undefined ? {} : { canonicalProductId: input.canonicalProductId }),
      links: near.items.map(toLink),
    });
    if (locationCount === 0) continue;
    suggestions.push({
      label: town.label,
      ...(town.city === undefined ? {} : { city: town.city }),
      ...(town.region === undefined ? {} : { region: town.region }),
      ...(town.country === undefined ? {} : { country: town.country }),
      cell,
      locationCount,
    });
  }
  return suggestions;
}

/**
 * How many GoWay pages a set-shaped proximity read walks before it stops.
 *
 * Search's nearby filter and the ranking's nearest-collection label ask "is
 * anything collectable within the radius", not for a page, so they walk
 * GoWay's pages — but not without bound: 3 × 200 places is every Mercaria
 * place in a dense city's 50 km, and a radius holding more than that answers
 * from the nearest 600, which is what "near" means anyway.
 */
const LINKED_LOCATION_PAGE_CAP = 3;

/**
 * The Mercaria locations GoWay vouches for within a radius of a point, each with
 * its exact distance — the shared first half of search's nearby filter and the
 * ranking's nearest-collection fact.
 *
 * @throws {GoWayUnavailableError} When GoWay cannot answer. The caller decides
 *   what that means for its own question.
 */
export async function findLinkedLocationsNear(input: {
  latitude: number;
  longitude: number;
  radiusMetres: number;
}): Promise<readonly StorePlaceNear[]> {
  const found: StorePlaceNear[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LINKED_LOCATION_PAGE_CAP; page += 1) {
    const result = await findStorePlacesNear({
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMetres: clampNearbyRadius(input.radiusMetres),
      limit: TOWN_PLACE_SCAN,
      ...(cursor === undefined ? {} : { cursor }),
    });
    found.push(...result.items);
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return found;
}

/**
 * The distance to the nearest collection point holding each of a set of NATIVE
 * variants — #74's `best_nearby_pickup` input.
 *
 * GoWay measures, Mercaria filters (`findCollectableVariantLocations`), and the
 * minimum per variant is kept. The opening-hours half is deliberately NOT
 * applied — a label saying "nearest collection point" is about geography, and
 * dropping a shop because it is shut at the moment somebody browsed would make
 * the label flicker with the clock.
 *
 * @throws {GoWayUnavailableError} When GoWay cannot answer.
 */
export async function findNearestCollectionByVariant(
  input: { variantIds: readonly string[]; latitude: number; longitude: number; radiusMetres: number },
  db?: DatabaseOrTransaction,
): Promise<ReadonlyMap<string, number>> {
  if (input.variantIds.length === 0) return new Map();
  const near = await findLinkedLocationsNear(input);
  const pairs = await findCollectableVariantLocations({ variantIds: input.variantIds, links: near.map(toLink) }, db);
  const distances = new Map(near.map((item) => [linkKey(item), item.distanceMetres]));

  const nearest = new Map<string, number>();
  for (const pair of pairs) {
    const metres = distances.get(linkKey(pair));
    if (metres === undefined) continue;
    const held = nearest.get(pair.variantId);
    if (held === undefined || metres < held) nearest.set(pair.variantId, Math.round(metres));
  }
  return nearest;
}

/**
 * Which canonical products are collectable within a radius of a point — #70's
 * nearby search filter. A MEMBERSHIP answer, never an ordering.
 *
 * @throws {GoWayUnavailableError} When GoWay cannot answer.
 */
export async function findCanonicalProductsCollectableNear(
  input: { canonicalProductIds: readonly string[]; latitude: number; longitude: number; radiusMetres: number },
  db?: DatabaseOrTransaction,
): Promise<ReadonlySet<string>> {
  if (input.canonicalProductIds.length === 0) return new Set();
  const near = await findLinkedLocationsNear(input);
  return findCanonicalProductsCollectableAtLocations(
    { canonicalProductIds: input.canonicalProductIds, links: near.map(toLink) },
    db,
  );
}

/** The link a GoWay result asserts, as the commerce reads join it. */
export function toLink(item: StorePlaceNear): PlaceLink {
  return { locationId: item.locationId, placeId: item.placeId };
}

function centreOf(cell: ReturnType<typeof toLocalArea>): Coordinate {
  return {
    latitude: (cell.latIndex + 0.5) * cell.precisionDegrees,
    longitude: (cell.lonIndex + 0.5) * cell.precisionDegrees,
  };
}

/**
 * One link's key. A location and the PLACE are the pair: two places may both
 * claim one location, and only the one the location names back joins.
 */
function linkKey(link: { locationId: string; placeId: string }): string {
  return `${link.locationId}|${link.placeId}`;
}

function distanceOf(candidate: NearbyCandidateRow, distances: ReadonlyMap<string, number>): number {
  return distances.get(linkKey({ locationId: candidate.locationId, placeId: candidate.goWayPlaceId })) ?? 0;
}

/** Nearest first, as GoWay measured; location then variant breaks a tie, so a page never reorders. */
function orderByDistance(
  candidates: readonly NearbyCandidateRow[],
  distances: ReadonlyMap<string, number>,
): NearbyCandidateRow[] {
  return [...candidates].sort(
    (left, right) =>
      distanceOf(left, distances) - distanceOf(right, distances) ||
      left.locationId.localeCompare(right.locationId) ||
      left.variantId.localeCompare(right.variantId),
  );
}

/** The levers, read once per page rather than per location. */
function readLevers() {
  return {
    storePickupEnabled: config.pickup.storePickupEnabled,
    guestPickupEnabled: config.pickup.guestPickupEnabled,
    // #85 has not landed and there is no table to read: `false` is
    // `unrecorded`, and whether that blocks is the flag's decision. Shared with
    // #107's gate rather than duplicated — see `eligibility.ts`.
    guestSellerActivated: false,
    guestSellerActivationRequired: config.guest.checkoutRollout.sellerActivationRequired,
    guestNotificationTransportAvailable: hasGuestMessageTransport(),
    guestNotificationTransportRequired: config.pickup.guestPickupRequiresNotificationTransport,
  };
}

/**
 * The derivation's location inputs, for a row the nearby SQL already narrowed.
 *
 * The publication and location values are `true` by construction — the
 * pre-filter refused anything else — and they are restated rather than omitted
 * so the DERIVATION stays the single authority. The place half is NOT assumed:
 * it is the trust rule over the place's own read, so a place that stopped
 * naming the location since GoWay's list was built, or went away, is refused
 * here. The checkout gate does not use this function, because its own read
 * applies no eligibility predicate at all and must report a paused location as
 * paused.
 */
function locationFactsForNarrowedRow(
  candidate: NearbyCandidateRow,
  lookup: PlaceLookup | null,
): PickupLocationFacts {
  return {
    publicationState: 'published',
    pickupOffered: true,
    pickupPaused: false,
    restricted: false,
    placeLinkGaps: placeLinkGaps({
      locationId: candidate.locationId,
      goWayPlaceId: candidate.goWayPlaceId,
      lookup,
    }),
    locationActive: true,
    storeActive: true,
    ...(lookup?.kind === 'found' ? { opening: lookup.place.opening } : {}),
  };
}

/** The stock half of the derivation's inputs. */
function inventoryFacts(candidate: NearbyCandidateRow): PickupInventoryFacts {
  return {
    listingActive: true,
    availableQuantity: candidate.available,
    stockConfirmedAt: candidate.stockConfirmedAt,
    stockConfirmationIntervalSeconds: candidate.stockConfirmationIntervalSeconds,
  };
}

function projectResult(
  candidate: NearbyCandidateRow,
  place: PlaceFacts,
  distanceMetres: number,
  at: Date,
  eligibility: PickupEligibility | undefined,
): NearbyLocationResult {
  const address = pickupAddressOf(place);
  // Unreachable while the trust rule refuses a place with no country or zone;
  // a projection that guessed either would describe a place nobody published.
  if (address === null || place.timezone === undefined) {
    throw new Error(`GoWay place ${place.id} passed the trust rule without a country or a timezone`);
  }

  const location: PublicPickupLocation = {
    locationId: candidate.locationId,
    goWayPlaceId: place.id,
    displayName: place.displayName,
    address,
    timezone: place.timezone,
    ...(candidate.merchantId === null || candidate.merchantName === null || candidate.merchantSlug === null
      ? {}
      : {
          merchant: {
            id: candidate.merchantId,
            name: candidate.merchantName,
            slug: candidate.merchantSlug,
          },
        }),
    ...(candidate.storefrontId === null || candidate.storefrontName === null
      ? {}
      : { storefront: { id: candidate.storefrontId, name: candidate.storefrontName } }),
    openState: openStateOf(place.opening, at),
    hours: weeklyHoursOf(place.opening),
    hoursExceptions: hoursExceptionsOf(place.opening),
    ...(Object.keys(place.accessibility).length === 0 ? {} : { accessibility: place.accessibility }),
    ...(Object.keys(place.contact).length === 0 ? {} : { contact: place.contact }),
    ...(candidate.pickupInstructions === null ? {} : { pickupInstructions: candidate.pickupInstructions }),
    identityRequirement: candidate.identityRequirement,
    paymentRequirement: candidate.paymentRequirement,
  };

  return {
    location,
    distanceBand: distanceBandFor(distanceMetres),
    approximateMetres: coarsenMetres(distanceMetres),
    availability: locationAvailabilityState(candidate.available, candidate.lowStockThreshold),
    ...(candidate.disclosesExactStock ? { exactQuantity: candidate.available } : {}),
    inventorySource: candidate.inventorySource,
    stockConfirmedAt: candidate.stockConfirmedAt.toISOString(),
    listingId: candidate.listingId,
    variantId: candidate.variantId,
    // A variant with no price cannot be sold, so it cannot appear — but the
    // column is nullable and reading `null` as zero is exactly the "unknown is
    // never free" mistake, so it is refused rather than defaulted.
    price: requirePrice(candidate),
    condition: candidate.condition,
    ...(eligibility === undefined ? {} : { checkoutEligibility: eligibility }),
  };
}

/** A price with no currency is not a cheaper price — it is an unanswerable one. */
function requirePrice(candidate: NearbyCandidateRow): Money {
  if (candidate.priceAmount === null || candidate.priceCurrency === null) {
    throw validationError('This variant has no price and cannot be offered for collection.');
  }
  return { amount: candidate.priceAmount, currency: candidate.priceCurrency as CurrencyCode };
}
