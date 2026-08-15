/**
 * The public "is this collectable near me" answer.
 *
 * ## The shopper's coordinate lives inside ONE function call
 *
 * It arrives on the request, it is passed to PostGIS, and it is gone. What
 * leaves this module is the COARSE CELL (`toLocalArea`) on the echoed origin
 * and in the one structured log line, plus per-location distances rounded
 * outward. Nothing writes it anywhere, no analytics event carries it (#77's
 * schema has no column that could), and `pickup-isolation.test.ts` fails the
 * build if this domain learns to emit one.
 *
 * That is #93 privacy rules 5, 6 and 10, and the reason the cell function is
 * shared with P2P discovery rather than duplicated: a buyer's position and a
 * seller's deserve the same treatment, and one function means a change to the
 * cell size cannot apply to one and miss the other.
 *
 * ## Actor eligibility is a SEPARATE, opt-in half of the response
 *
 * #93 nearby rules 11 and 12. A signed-out shopper browsing gets availability
 * and no `checkoutEligibility` at all; a client about to offer a "collect here"
 * button asks for it explicitly. Keeping them apart is what makes browsing work
 * without an account wall AND stops an anonymous caller getting a different set
 * of locations from a signed-in one — the SET is actor-free, and only the
 * annotation is not.
 *
 * ## Freshness and hours are re-derived here, over the SQL's pre-filter
 *
 * `nearbyRepository` narrows on everything indexable; `deriveLocationDiscoverability`
 * is the authority and drops anything it refuses. The intersection is a subset
 * of what the derivation admits, so the read can only ever show FEWER
 * locations — never one the derivation would refuse. A page may therefore come
 * back shorter than `limit`, which is #68's arrangement and is why the cursor
 * is carried on the last candidate CONSIDERED.
 */

import type {
  CurrencyCode,
  ItemConditionKey,
  Money,
  LocationAvailabilityState,
  NearbyLocationResult,
  NearbyPlaceSuggestion,
  NearbyResponse,
  P2pLocalArea,
  PickupEligibility,
  PublicPickupLocation,
} from '@mercaria/shared-types';
import { P2P_LOCAL_CELL_PRECISION_DEGREES } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { validationError } from '../../lib/errors/error-codes.js';
import {
  findNearbyCollectableLocations,
  findNearbyPlaceSuggestions,
  type NearbyCandidateRow,
  type NearbyCursor,
} from '../../db/pickup/nearbyRepository.js';
import {
  listActiveClosures,
  listOpeningHours,
} from '../../db/pickup/locationPublicationRepository.js';
import { hasGuestMessageTransport } from '../guest-portal/transport.js';
import type { CommerceActor } from '../commerce-actor.js';
import {
  clampNearbyRadius,
  coarsenMetres,
  distanceBandFor,
  localAreaCentre,
  toLocalArea,
  type Coordinate,
} from './geo.js';
import {
  derivePickupEligibility,
  deriveLocationDiscoverability,
  type PickupInventoryFacts,
  type PickupLocationFacts,
} from './eligibility.js';
import { deriveLocationOpenState, type LocationSchedule } from './hours.js';

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
  readonly limit: number;
  readonly cursor?: NearbyCursor;
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

  const candidates = await findNearbyCollectableLocations({
    ...(request.canonicalVariantId === undefined ? {} : { canonicalVariantId: request.canonicalVariantId }),
    ...(request.canonicalProductId === undefined ? {} : { canonicalProductId: request.canonicalProductId }),
    latitude: request.origin.latitude,
    longitude: request.origin.longitude,
    radiusMetres,
    ...(request.country === undefined ? {} : { country: request.country }),
    ...(request.currency === undefined ? {} : { currency: request.currency }),
    ...(request.conditionKeys === undefined ? {} : { conditionKeys: request.conditionKeys }),
    limit: request.limit,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  });

  // The COARSE cell, never the coordinate. This log line is the only place a
  // nearby request's position appears at all, and at 0.1° it names a district.
  log.general.debug(
    {
      cell,
      radiusMetres,
      candidates: candidates.length,
      canonicalVariantId: request.canonicalVariantId,
      canonicalProductId: request.canonicalProductId,
    },
    '[Pickup] nearby availability answered',
  );

  const schedules = await loadSchedules(candidates, at);
  const levers = readLevers();

  const results: NearbyLocationResult[] = [];
  for (const candidate of candidates) {
    const schedule = schedules.get(candidate.publicationId) ?? {
      timezone: candidate.timezone,
      hours: [],
      closures: [],
    };
    const location = locationFactsForNarrowedRow(schedule);
    const inventory = inventoryFacts(candidate);

    // The derivation is the AUTHORITY over the SQL pre-filter — see the module
    // docblock. Its refusals are never reported to the shopper; the location
    // simply is not in the page.
    if (deriveLocationDiscoverability(location, inventory, at).length > 0) continue;

    const eligibility: PickupEligibility | undefined = request.withCheckoutEligibility
      ? derivePickupEligibility({
          location,
          inventory,
          actor: { actorKind: actor.kind, sellerType: 'store' },
          levers,
          at,
        })
      : undefined;

    results.push(projectResult(candidate, schedule, at, eligibility));
  }

  // The cursor names the last candidate CONSIDERED, not the last one served.
  // A location the derivation dropped must not be re-considered on the next
  // page, or a stale shop is re-examined on every page for ever (#70's finding).
  const last = candidates.at(-1);
  const nextCursor =
    candidates.length === request.limit && last !== undefined
      ? encodeCursor({ distanceMetres: last.distanceMetres, publicationId: last.publicationId })
      : undefined;

  return {
    results,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    origin: { source: request.originSource, cell, radiusMetres },
    ...(request.canonicalProductId === undefined ? {} : { canonicalProductId: request.canonicalProductId }),
    ...(request.canonicalVariantId === undefined ? {} : { canonicalVariantId: request.canonicalVariantId }),
  };
}

/**
 * The manual-location fallback (#93 acceptance 5).
 *
 * Every suggestion comes from a location that actually holds the item, so a
 * shopper who declines to share a position can still get a real answer — and
 * cannot be offered a city that turns out to be empty. Selecting one hands back
 * a CELL CENTRE as the next request's origin, so the fallback path never sees a
 * precise coordinate at all.
 */
export async function suggestNearbyPlaces(input: {
  canonicalVariantId?: string;
  canonicalProductId?: string;
  term?: string;
  country?: string;
  limit: number;
}): Promise<readonly NearbyPlaceSuggestion[]> {
  if ((input.canonicalVariantId === undefined) === (input.canonicalProductId === undefined)) {
    throw validationError('Ask about exactly one of `canonicalVariantId` or `canonicalProductId`.');
  }
  const rows = await findNearbyPlaceSuggestions({
    ...(input.canonicalVariantId === undefined ? {} : { canonicalVariantId: input.canonicalVariantId }),
    ...(input.canonicalProductId === undefined ? {} : { canonicalProductId: input.canonicalProductId }),
    ...(input.term === undefined ? {} : { term: input.term }),
    ...(input.country === undefined ? {} : { country: input.country }),
    precisionDegrees: P2P_LOCAL_CELL_PRECISION_DEGREES,
    limit: input.limit,
  });

  return rows.map((row) => ({
    label: row.region === null ? `${row.city}, ${row.country}` : `${row.city}, ${row.region}`,
    city: row.city,
    ...(row.region === null ? {} : { region: row.region }),
    country: row.country,
    cell: {
      latIndex: row.latIndex,
      lonIndex: row.lonIndex,
      precisionDegrees: P2P_LOCAL_CELL_PRECISION_DEGREES,
    },
    locationCount: row.locationCount,
  }));
}

/** The centre of a suggested place, as the next request's origin. */
export function originForPlace(cell: P2pLocalArea): Coordinate {
  return localAreaCentre(cell);
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

/** Every candidate's schedule, in two statements for the whole page. */
async function loadSchedules(
  candidates: readonly NearbyCandidateRow[],
  at: Date,
): Promise<Map<string, LocationSchedule>> {
  const ids = [...new Set(candidates.map((candidate) => candidate.publicationId))];
  if (ids.length === 0) return new Map();

  const today = at.toISOString().slice(0, 10);
  const [hours, closures] = await Promise.all([
    listOpeningHours(ids),
    listActiveClosures(ids, today),
  ]);

  const schedules = new Map<string, LocationSchedule>();
  for (const candidate of candidates) {
    if (schedules.has(candidate.publicationId)) continue;
    schedules.set(candidate.publicationId, {
      timezone: candidate.timezone,
      hours: hours
        .filter((hour) => hour.publicationId === candidate.publicationId)
        .map((hour) => ({
          weekday: hour.weekday,
          opensMinute: hour.opensMinute,
          closesMinute: hour.closesMinute,
        })),
      closures: closures
        .filter((closure) => closure.publicationId === candidate.publicationId)
        .map((closure) => ({
          id: closure.id,
          fromDate: closure.fromDate,
          throughDate: closure.throughDate,
          ...(closure.note === null ? {} : { note: closure.note }),
        })),
    });
  }
  return schedules;
}

/**
 * The publication half of the derivation's inputs, for a row the nearby SQL
 * already narrowed.
 *
 * Every value here is `true` by construction — the pre-filter refused anything
 * else — and they are restated rather than omitted so the DERIVATION stays the
 * single authority. That matters the day somebody relaxes a clause in the SQL:
 * the derivation still refuses, and the page comes back shorter rather than
 * wider. The checkout gate does NOT use this function, because its own read
 * applies no eligibility predicate at all and must report a paused location as
 * paused.
 */
function locationFactsForNarrowedRow(schedule: LocationSchedule): PickupLocationFacts {
  return {
    publicationState: 'published',
    pickupOffered: true,
    pickupPaused: false,
    restricted: false,
    geocoded: true,
    locationActive: true,
    storeActive: true,
    schedule,
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

/**
 * The public availability state.
 *
 * A BOUNDED word by default and a number only where the merchant opted in
 * (#93 inventory rule). The threshold is the location's own, so a shop that
 * carries two of everything is not permanently "low" and a warehouse that
 * carries four hundred is not permanently "in stock" at three.
 */
function availabilityFor(candidate: NearbyCandidateRow): LocationAvailabilityState {
  if (candidate.available <= 0) return 'out_of_stock';
  return candidate.available <= candidate.lowStockThreshold ? 'low_stock' : 'in_stock';
}

function projectResult(
  candidate: NearbyCandidateRow,
  schedule: LocationSchedule,
  at: Date,
  eligibility: PickupEligibility | undefined,
): NearbyLocationResult {
  const location: PublicPickupLocation = {
    locationId: candidate.locationId,
    displayName: candidate.displayName,
    address: {
      ...(candidate.publicLine1 === null ? {} : { line1: candidate.publicLine1 }),
      ...(candidate.publicLine2 === null ? {} : { line2: candidate.publicLine2 }),
      ...(candidate.publicCity === null ? {} : { city: candidate.publicCity }),
      ...(candidate.publicRegion === null ? {} : { region: candidate.publicRegion }),
      ...(candidate.publicPostalCode === null ? {} : { postalCode: candidate.publicPostalCode }),
      country: candidate.publicCountry,
    },
    timezone: candidate.timezone,
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
    openState: deriveLocationOpenState(schedule, at),
    hours: schedule.hours,
    closures: schedule.closures,
    ...(accessibility(candidate) === undefined ? {} : { accessibility: accessibility(candidate) }),
    ...(contact(candidate) === undefined ? {} : { contact: contact(candidate) }),
    ...(candidate.pickupInstructions === null ? {} : { pickupInstructions: candidate.pickupInstructions }),
    identityRequirement: candidate.identityRequirement,
    paymentRequirement: candidate.paymentRequirement,
  };

  return {
    location,
    distanceBand: distanceBandFor(candidate.distanceMetres),
    approximateMetres: coarsenMetres(candidate.distanceMetres),
    availability: availabilityFor(candidate),
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

function accessibility(candidate: NearbyCandidateRow) {
  const facts = {
    ...(candidate.accessibilityStepFree === null ? {} : { stepFreeAccess: candidate.accessibilityStepFree }),
    ...(candidate.accessibilityToilet === null ? {} : { accessibleToilet: candidate.accessibilityToilet }),
    ...(candidate.accessibilityParking === null ? {} : { parkingOnSite: candidate.accessibilityParking }),
    ...(candidate.accessibilityHearingLoop === null
      ? {}
      : { hearingLoop: candidate.accessibilityHearingLoop }),
  };
  return Object.keys(facts).length === 0 ? undefined : facts;
}

function contact(candidate: NearbyCandidateRow) {
  const facts = {
    ...(candidate.publicPhone === null ? {} : { phone: candidate.publicPhone }),
    ...(candidate.publicUrl === null ? {} : { url: candidate.publicUrl }),
  };
  return Object.keys(facts).length === 0 ? undefined : facts;
}

/** A price with no currency is not a cheaper price — it is an unanswerable one. */
function requirePrice(candidate: NearbyCandidateRow): Money {
  if (candidate.priceAmount === null || candidate.priceCurrency === null) {
    throw validationError('This variant has no price and cannot be offered for collection.');
  }
  return { amount: candidate.priceAmount, currency: candidate.priceCurrency as CurrencyCode };
}

/**
 * The keyset cursor.
 *
 * An integer distance and an id, joined by a character neither contains, then
 * base64url. Deliberately not signed or bound to a query fingerprint the way
 * #70's is: this cursor carries no score whose meaning depends on a policy, and
 * a foreign one simply resumes from a distance and an id — which yields a
 * wrong-looking page, never a wider one, since every eligibility predicate is
 * re-applied.
 */
export function encodeCursor(cursor: NearbyCursor): string {
  return Buffer.from(`${cursor.distanceMetres}|${cursor.publicationId}`, 'utf8').toString('base64url');
}

/** Decode a cursor, refusing one that is not the shape this surface emits. */
export function decodeCursor(encoded: string): NearbyCursor {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const distance = Number(decoded.slice(0, separator));
  const publicationId = decoded.slice(separator + 1);
  if (separator < 0 || !Number.isInteger(distance) || distance < 0 || publicationId === '') {
    throw validationError('That page cursor is not one this surface issued.');
  }
  return { distanceMetres: distance, publicationId };
}
