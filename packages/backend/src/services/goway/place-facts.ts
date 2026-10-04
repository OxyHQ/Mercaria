/**
 * A GoWay place, as Mercaria reads it — and the trust rule that decides whether
 * a location may trade from it (ADR 0013).
 *
 * PURE: no client, no configuration, no cache, no database. The projection and
 * the rule are exercised against every shape of place without a network, and
 * the pickup derivations (`services/pickup/eligibility.ts`, which reads nothing
 * either) can import them without learning about I/O.
 *
 * ## Why a Mercaria shape rather than GoWay's `Place`
 *
 * Feature code never sees `@goway.to/sdk`. `PlaceFacts` is the part of a place
 * Mercaria uses, projected ONCE when it is read: the address in the shape an
 * order snapshot freezes, the accessibility facts as the four flags shoppers
 * already see, the `commerce.mercaria.store` back-reference reduced to its
 * strongest assertion. The one thing kept in GoWay's own shape is the opening
 * schedule, because `openingStatusAt` — GoWay's evaluation, shared with the
 * GoWay app and API — reads it, and a second evaluation of "open now" is how
 * the map and the shop would come to disagree.
 *
 * Everything here is JSON-safe, because it is what the place cache stores.
 */

import {
  CAPABILITY_VERIFICATIONS,
  capabilityHolds,
  openingStatusAt,
  placeDisplayName,
  strongestCapability,
  type CapabilityVerification,
  type OpeningFacts,
  type Place,
} from '@goway.to/sdk';
import type {
  LocationAccessibilityFacts,
  LocationOpenState,
  LocationPublicContact,
  PickupAddress,
  PickupBlockReason,
  PickupHoursException,
  PickupOpeningInterval,
  PlaceLinkGap,
} from '@mercaria/shared-types';

/** The capability a GoWay place carries to say "this is Mercaria location X". */
export const MERCARIA_STORE_CAPABILITY = 'commerce.mercaria.store';

/**
 * The tiers at which a back-reference proves anything.
 *
 * `business_asserted` is written only by whoever acts for an APPROVED claim on
 * the place — in practice the store's own Oxy organization — and `oxy_verified`
 * only by GoWay's moderators. A community report or an imported source can say
 * the same words and prove nothing about who controls the store.
 */
const VOUCHING_TIERS: readonly CapabilityVerification[] = ['business_asserted', 'oxy_verified'];

/** A place's weekly hours, exceptions and zone, in GoWay's own shape (see the docblock). */
export type PlaceOpening = OpeningFacts;

/** The part of a GoWay place Mercaria uses. */
export interface PlaceFacts {
  readonly id: string;
  /** The DEFAULT name — what is written on the shopfront. What an order snapshot freezes. */
  readonly name: string;
  /** The name for the locale the read asked for, falling back to {@link name}. */
  readonly displayName: string;
  readonly status: 'active' | 'closed' | 'proposed';
  /** Every part optional, the country included; {@link pickupAddressOf} insists on one. */
  readonly address: Partial<PickupAddress>;
  readonly timezone?: string;
  readonly opening: PlaceOpening;
  readonly contact: LocationPublicContact;
  readonly accessibility: LocationAccessibilityFacts;
  /** The strongest `commerce.mercaria.store` assertion, when the place carries one. */
  readonly storeLink?: { readonly locationId: string; readonly verification: CapabilityVerification };
  /** `https://goway.to/place/<id>`. */
  readonly url: string;
}

/**
 * What one place read came back with.
 *
 * `stale` marks a last-good copy served because GoWay could not answer: good
 * enough to describe a collection point, and stated so the caller can say so.
 */
export type PlaceLookup =
  | { readonly kind: 'found'; readonly place: PlaceFacts; readonly stale: boolean }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'gone'; readonly mergedInto: string | null }
  | { readonly kind: 'unavailable' };

/** The four GoWay accessibility keys that absorbed Mercaria's four flags. */
const ACCESSIBILITY_KEYS = [
  ['accessibility.step_free_entrance', 'stepFreeAccess'],
  ['accessibility.toilets_wheelchair', 'accessibleToilet'],
  ['accessibility.parking_accessible', 'parkingOnSite'],
  ['accessibility.hearing_loop', 'hearingLoop'],
] as const;

/**
 * Countries whose addresses put the house number BEFORE the street.
 *
 * GoWay publishes the two as separate parts and leaves the order to the
 * reader. This is a display convention, not a fact about the place: getting it
 * wrong reads oddly and loses nothing, and everywhere not listed reads
 * "street number", the continental order.
 */
const NUMBER_FIRST_COUNTRIES: ReadonlySet<string> = new Set([
  'AU', 'CA', 'FR', 'GB', 'IE', 'IL', 'IN', 'LU', 'MY', 'NZ', 'PH', 'SG', 'US', 'ZA',
]);

/** Project one GoWay place, as the SDK parsed it. */
export function placeFactsOf(place: Place, url: string): PlaceFacts {
  const address = place.address ?? {};
  const country = address.countryCode?.trim().toUpperCase();
  const street = address.street?.trim();
  const number = address.houseNumber?.trim();
  const line1 =
    street && number
      ? country !== undefined && NUMBER_FIRST_COUNTRIES.has(country)
        ? `${number} ${street}`
        : `${street} ${number}`
      : street || undefined;

  const link = strongestCapability(place, MERCARIA_STORE_CAPABILITY);
  const accessibility: Record<string, boolean> = {};
  for (const [key, flag] of ACCESSIBILITY_KEYS) {
    const strongest = strongestCapability(place, key);
    if (strongest !== undefined) accessibility[flag] = capabilityHolds(key, strongest.value);
  }

  return {
    id: place.id,
    name: place.name,
    displayName: placeDisplayName(place),
    status: place.status,
    address: {
      ...(line1 === undefined ? {} : { line1 }),
      ...(nonEmpty(address.locality) === undefined ? {} : { line2: nonEmpty(address.locality) }),
      ...(nonEmpty(address.city) === undefined ? {} : { city: nonEmpty(address.city) }),
      ...(nonEmpty(address.region) === undefined ? {} : { region: nonEmpty(address.region) }),
      ...(nonEmpty(address.postalCode) === undefined ? {} : { postalCode: nonEmpty(address.postalCode) }),
      ...(country === undefined || !/^[A-Z]{2}$/.test(country) ? {} : { country }),
    },
    ...(place.timezone === undefined ? {} : { timezone: place.timezone }),
    opening: {
      ...(place.openingHours === undefined ? {} : { openingHours: place.openingHours }),
      ...(place.timezone === undefined ? {} : { timezone: place.timezone }),
      ...(place.hoursExceptions === undefined ? {} : { hoursExceptions: place.hoursExceptions }),
    },
    contact: {
      ...(nonEmpty(place.contact?.phone) === undefined ? {} : { phone: nonEmpty(place.contact?.phone) }),
      ...(nonEmpty(place.contact?.website) === undefined ? {} : { url: nonEmpty(place.contact?.website) }),
    },
    accessibility,
    ...(link !== undefined && typeof link.value === 'string' && link.value !== ''
      ? { storeLink: { locationId: link.value, verification: link.verification } }
      : {}),
    url,
  };
}

/**
 * The trust rule: what stands between a location and the place it names.
 *
 * `[]` means linked. Called with the place's OWN read (`readPlace` of the id
 * the location stores), so "is it the right place" is "does the location name
 * this id" — which the caller already knows — and the rule is about what the
 * place says back. A MERGED place answers `place_gone` here; following a merge
 * is the verify act's, because it rewrites the stored id.
 */
export function placeLinkGaps(input: {
  locationId: string;
  goWayPlaceId: string | null;
  lookup: PlaceLookup | null;
}): PlaceLinkGap[] {
  if (input.goWayPlaceId === null || input.goWayPlaceId === '' || input.lookup === null) {
    return ['place_not_set'];
  }
  switch (input.lookup.kind) {
    case 'unavailable':
      return ['goway_unavailable'];
    case 'not_found':
      return ['place_not_found'];
    case 'gone':
      return ['place_gone'];
    case 'found':
      break;
  }

  const place = input.lookup.place;
  const gaps: PlaceLinkGap[] = [];
  if (place.status !== 'active') gaps.push('place_not_active');
  if (place.storeLink === undefined) {
    gaps.push('store_link_missing');
  } else if (place.storeLink.locationId !== input.locationId) {
    gaps.push('store_link_names_other_location');
  } else if (!VOUCHING_TIERS.includes(place.storeLink.verification)) {
    gaps.push('store_link_unverified');
  }
  if (place.address.country === undefined) gaps.push('place_country_missing');
  if (place.timezone === undefined) gaps.push('place_timezone_missing');
  return gaps;
}

/**
 * The trust rule's gaps as collection block reasons — one reason per REMEDY,
 * which is the grain a merchant's dashboard and an operator trace act on.
 */
export function placeLinkBlockers(gaps: readonly PlaceLinkGap[]): PickupBlockReason[] {
  const reasons = new Set<PickupBlockReason>();
  for (const gap of gaps) {
    switch (gap) {
      case 'place_not_set':
        reasons.add('place_not_linked');
        break;
      case 'place_not_found':
      case 'place_gone':
      case 'place_not_active':
      case 'goway_unavailable':
        reasons.add('place_unavailable');
        break;
      case 'store_link_missing':
      case 'store_link_names_other_location':
      case 'store_link_unverified':
        reasons.add('place_link_unverified');
        break;
      case 'place_country_missing':
      case 'place_timezone_missing':
        reasons.add('place_incomplete');
        break;
    }
  }
  return [...reasons];
}

/** The address an order snapshot freezes, or `null` for a place with no country. */
export function pickupAddressOf(place: PlaceFacts): PickupAddress | null {
  const { country, ...rest } = place.address;
  return country === undefined ? null : { ...rest, country };
}

/**
 * Whether the place opens at all inside the week ahead — the nearby read's
 * `location_closed` test.
 *
 * "Closed right now" would hide every shop in a city at 11pm, the hour people
 * browse. What is excluded is a place shut for the whole horizon `openingStatusAt`
 * looks across (a week): a refit, a long holiday. A place with no weekly hours
 * has told nobody when it is shut, and inventing "never open" from silence
 * would delist it for an empty form — so it, and an `unknown`, answer yes.
 */
export function opensWithinHorizon(opening: PlaceOpening, at: Date): boolean {
  if ((opening.openingHours?.intervals ?? []).length === 0) return true;
  const status = openingStatusAt(opening, at);
  if (status.state !== 'closed') return true;
  return status.nextChange !== undefined;
}

/** Open right now, and when that changes today — GoWay's evaluation, in the shopper's words. */
export function openStateOf(opening: PlaceOpening, at: Date): LocationOpenState {
  const status = openingStatusAt(opening, at);
  if (status.state === 'unknown') return { known: false };
  const changesAt =
    status.nextChange !== undefined && status.nextChange.localDate === status.localDate
      ? status.nextChange.localTime
      : undefined;
  const note = status.exception?.note;
  return {
    known: true,
    open: status.state === 'open',
    ...(changesAt === undefined ? {} : { changesAt }),
    ...(note === undefined ? {} : { exceptionNote: note }),
  };
}

/** The weekly hours, as shoppers read them. */
export function weeklyHoursOf(opening: PlaceOpening): PickupOpeningInterval[] {
  return (opening.openingHours?.intervals ?? []).map((interval) => ({
    day: interval.day,
    opens: interval.opens,
    closes: interval.closes,
  }));
}

/**
 * The exceptions that have not ended, earliest first, as shoppers read them.
 *
 * Where two tiers state the same dates the STRONGER one is shown — the one
 * `openingStatusAt` obeys — so the list never contradicts the open state
 * printed above it.
 */
export function hoursExceptionsOf(opening: PlaceOpening): PickupHoursException[] {
  const strongest = new Map<string, NonNullable<OpeningFacts['hoursExceptions']>[number]>();
  for (const exception of opening.hoursExceptions ?? []) {
    const key = `${exception.startsOn}/${exception.endsOn}`;
    const held = strongest.get(key);
    if (held === undefined || tierOf(exception.verification) > tierOf(held.verification)) {
      strongest.set(key, exception);
    }
  }
  return [...strongest.values()]
    .sort((left, right) => left.startsOn.localeCompare(right.startsOn))
    .map((exception) => ({
      startsOn: exception.startsOn,
      endsOn: exception.endsOn,
      closed: exception.closed,
      intervals: exception.intervals.map((range) => ({ opens: range.opens, closes: range.closes })),
      ...(exception.note === undefined ? {} : { note: exception.note }),
    }));
}

function tierOf(verification: CapabilityVerification): number {
  return CAPABILITY_VERIFICATIONS.indexOf(verification);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
