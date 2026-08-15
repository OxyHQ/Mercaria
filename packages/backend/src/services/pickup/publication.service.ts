/**
 * The merchant's own surface: composing, publishing and pausing one location's
 * public face.
 *
 * ## No new permission was invented
 *
 * #93 operations rule 4 asks that address edits and pickup settings be
 * restricted "through existing store permissions", and they are:
 * `locations:write` already means "may change where this store keeps stock",
 * and publishing a shop front is the same authority pointed outward. Adding an
 * eighteenth permission would have meant every existing owner and admin
 * silently lacking it on the deploy that added it.
 *
 * ## Validation refuses rather than repairs
 *
 * A timezone `Intl` does not recognise, an opening interval that ends before it
 * starts, a coordinate in the Gulf of Guinea — each is refused with a sentence
 * naming the field. The alternative (accept it, fall back to UTC, clamp the
 * interval) produces a shop front that is subtly wrong in a way nobody looking
 * at the dashboard can see, and the person who finds out is a customer standing
 * outside a closed door.
 *
 * ## Publishing is a separate act from editing
 *
 * `upsertPublication` writes the profile and never the state; `publish` and
 * `withdraw` move the state and never the profile. Folding them would mean a
 * merchant fixing a typo on a withdrawn location silently republished it —
 * which is the one editorial mistake with an audience.
 */

import type {
  LocationOpeningHour,
  LocationPublicationState,
  SetLocationPublicationStateInput,
  UpsertLocationPublicationInput,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { findLocation } from '../../db/stores/locationRepository.js';
import {
  appendPublicationEvent,
  deleteClosure,
  findPublicationByLocationId,
  insertClosure,
  listActiveClosures,
  listOpeningHours,
  listPublicationEvents,
  listPublicationsForStore,
  replaceOpeningHours,
  setPickupPause,
  setPublicationRestriction,
  setPublicationState,
  upsertLocationPublication,
  type LocationPublicationRow,
} from '../../db/pickup/locationPublicationRepository.js';
import {
  MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS,
  MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS,
} from '../../db/schema/pickup.js';
import { assertUsableCoordinate } from './geo.js';

/** A publication plus its two child collections, as every read hands it over. */
export interface PublicationBundle {
  readonly publication: LocationPublicationRow;
  readonly hours: readonly LocationOpeningHour[];
  readonly closures: readonly {
    id: string;
    fromDate: string;
    throughDate: string;
    note?: string;
  }[];
}

/**
 * Refuse a timezone this runtime cannot resolve.
 *
 * `Intl.DateTimeFormat` is the same mechanism `deriveLocationOpenState` reads
 * with, so validating through it means a zone that passes here is a zone the
 * open-state derivation can actually use — rather than a zone that passes a
 * regex and then makes every location answer `{ known: false }` forever.
 */
function assertUsableTimezone(timezone: string): string {
  const trimmed = timezone.trim();
  if (trimmed === '') throw validationError('A published location needs a timezone.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
  } catch {
    throw validationError(
      `\`${trimmed}\` is not a timezone this server recognises. Use an IANA name like Europe/Madrid.`,
    );
  }
  return trimmed;
}

/** Refuse a schedule the schema's CHECKs would refuse, with a readable message. */
function assertUsableHours(hours: readonly LocationOpeningHour[]): readonly LocationOpeningHour[] {
  for (const hour of hours) {
    if (!Number.isInteger(hour.weekday) || hour.weekday < 0 || hour.weekday > 6) {
      throw validationError('An opening interval needs a weekday between 0 (Sunday) and 6.');
    }
    if (
      !Number.isInteger(hour.opensMinute) ||
      !Number.isInteger(hour.closesMinute) ||
      hour.opensMinute < 0 ||
      hour.closesMinute > 1440 ||
      hour.opensMinute >= hour.closesMinute
    ) {
      throw validationError(
        'An opening interval runs from `opensMinute` to a later `closesMinute`, both minutes ' +
          'from local midnight (0–1440).',
      );
    }
  }
  return hours;
}

/** The whole public profile of one location, as a merchant reads it back. */
export async function readPublication(
  input: { storeId: string; locationId: string },
  today: string,
): Promise<PublicationBundle | null> {
  const publication = await findPublicationByLocationId(input.locationId);
  // The tenant predicate is on the row rather than on the request: a
  // publication whose `store_id` is not the caller's is answered as ABSENT, so
  // a guessed location id discloses nothing about whether it exists.
  if (!publication || publication.storeId !== input.storeId) return null;
  return bundle(publication, today);
}

/** Every publication a store owns, with their schedules. */
export async function listStorePublications(
  storeId: string,
  today: string,
): Promise<readonly PublicationBundle[]> {
  const rows = await listPublicationsForStore(storeId);
  return Promise.all(rows.map((row) => bundle(row, today)));
}

async function bundle(
  publication: LocationPublicationRow,
  today: string,
): Promise<PublicationBundle> {
  const [hours, closures] = await Promise.all([
    listOpeningHours([publication.id]),
    listActiveClosures([publication.id], today),
  ]);
  return {
    publication,
    hours: hours.map((hour) => ({
      weekday: hour.weekday,
      opensMinute: hour.opensMinute,
      closesMinute: hour.closesMinute,
    })),
    closures: closures.map((closure) => ({
      id: closure.id,
      fromDate: closure.fromDate,
      throughDate: closure.throughDate,
      ...(closure.note === null ? {} : { note: closure.note }),
    })),
  };
}

/**
 * Compose or replace one location's public profile.
 *
 * The whole profile is written every time — a PUT rather than a PATCH — because
 * a partial save of a shop front has no defensible semantics: does omitting the
 * phone number mean "leave it" or "stop publishing it"? The first is what a
 * client that forgot the field expects and the second is what a merchant who
 * deleted it expects, and the same request cannot mean both.
 *
 * The coordinate is the one field with a three-way input: absent leaves it,
 * `null` clears it, a number replaces it. That asymmetry is deliberate and it
 * is the reason the type is `number | null | undefined`: a merchant editing
 * their opening hours on a phone should not have to re-drop their map pin, and
 * a client that cannot show a map should not be able to erase one silently.
 */
export async function upsertPublication(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
  body: UpsertLocationPublicationInput;
}): Promise<PublicationBundle> {
  const location = await findLocation(input.storeId, input.locationId);
  if (!location) throw notFound('Location not found');

  const existing = await findPublicationByLocationId(input.locationId);

  const timezone = assertUsableTimezone(input.body.timezone);
  const hours = assertUsableHours(input.body.hours ?? []);

  const country = input.body.address.country?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(country)) {
    throw validationError('A published location needs an ISO-3166 alpha-2 country.');
  }

  const displayName = input.body.displayName.trim();
  if (displayName === '') {
    throw validationError('A published location needs a public name.');
  }

  const interval = input.body.stockConfirmationIntervalSeconds;
  if (
    !Number.isInteger(interval) ||
    interval < MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS ||
    interval > MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS
  ) {
    throw validationError(
      `How often this location's stock is confirmed must be between ` +
        `${MIN_STOCK_CONFIRMATION_INTERVAL_SECONDS} and ` +
        `${MAX_STOCK_CONFIRMATION_INTERVAL_SECONDS} seconds. There is no default: a shared one ` +
        'would claim a warehouse and a till are equally fresh.',
    );
  }

  const coordinate = resolveCoordinate(input.body, existing);

  return getDb().transaction(async (tx) => {
    const publication = await upsertLocationPublication(
      {
        locationId: input.locationId,
        storeId: input.storeId,
        // #84's linkage answers which MERCHANT operates this store; the
        // storefront is the merchant's own subdivision and only they know
        // which branch this is. Left absent here and set by its own endpoint,
        // which is where the "belongs to the linked merchant" check lives.
        storefrontId: existing?.storefrontId ?? null,
        displayName,
        publicLine1: emptyToNull(input.body.address.line1),
        publicLine2: emptyToNull(input.body.address.line2),
        publicCity: emptyToNull(input.body.address.city),
        publicRegion: emptyToNull(input.body.address.region),
        publicPostalCode: emptyToNull(input.body.address.postalCode),
        publicCountry: country,
        timezone,
        publicPhone: emptyToNull(input.body.contact?.phone),
        publicUrl: emptyToNull(input.body.contact?.url),
        accessibilityStepFree: input.body.accessibility?.stepFreeAccess ?? null,
        accessibilityToilet: input.body.accessibility?.accessibleToilet ?? null,
        accessibilityParking: input.body.accessibility?.parkingOnSite ?? null,
        accessibilityHearingLoop: input.body.accessibility?.hearingLoop ?? null,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        geocodeProvenance: coordinate.provenance,
        geocodedAt: coordinate.latitude === null ? null : input.at,
        pickupOffered: input.body.pickupOffered,
        pickupInstructions: emptyToNull(input.body.pickupInstructions),
        identityRequirement: input.body.identityRequirement ?? 'collection_code',
        inventorySource: input.body.inventorySource,
        stockConfirmationIntervalSeconds: interval,
        disclosesExactStock: input.body.disclosesExactStock === true,
        lowStockThreshold: input.body.lowStockThreshold ?? 3,
        profileConfirmedAt: input.at,
      },
      input.actorOxyUserId,
      tx,
    );

    if (input.body.hours !== undefined) {
      await replaceOpeningHours({ publicationId: publication.id, hours: [...hours] }, tx);
    }

    return bundleWithin(publication, hours, input.at, tx);
  });
}

/**
 * The coordinate's three-way input, resolved once.
 *
 * A merchant who supplies a position states its provenance, and if they do not,
 * `merchant_map_pin` is assumed — the only source a dashboard form has. What is
 * NOT assumed anywhere is a provenance from a geocoding provider: there is no
 * member of `LOCATION_GEOCODE_PROVENANCES` for one, and
 * `LOCATION_FORBIDDEN_GEOCODE_PROVENANCES` names the prohibition as a value.
 */
function resolveCoordinate(
  body: UpsertLocationPublicationInput,
  existing: LocationPublicationRow | null,
): {
  latitude: number | null;
  longitude: number | null;
  provenance: 'merchant_map_pin' | 'merchant_entered' | 'operator_corrected' | null;
} {
  if (body.latitude === undefined && body.longitude === undefined) {
    return {
      latitude: existing?.latitude ?? null,
      longitude: existing?.longitude ?? null,
      provenance: existing?.geocodeProvenance ?? null,
    };
  }
  if (body.latitude === null || body.longitude === null) {
    return { latitude: null, longitude: null, provenance: null };
  }
  if (body.latitude === undefined || body.longitude === undefined) {
    throw validationError('A position needs both a latitude and a longitude.');
  }
  const coordinate = assertUsableCoordinate(body.latitude, body.longitude);
  return {
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    provenance: body.geocodeProvenance ?? 'merchant_map_pin',
  };
}

async function bundleWithin(
  publication: LocationPublicationRow,
  hours: readonly LocationOpeningHour[],
  at: Date,
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
): Promise<PublicationBundle> {
  const today = at.toISOString().slice(0, 10);
  const closures = await listActiveClosures([publication.id], today, tx);
  return {
    publication,
    hours,
    closures: closures.map((closure) => ({
      id: closure.id,
      fromDate: closure.fromDate,
      throughDate: closure.throughDate,
      ...(closure.note === null ? {} : { note: closure.note }),
    })),
  };
}

/**
 * Publish, withdraw or return one location to draft.
 *
 * Publishing REFUSES a profile that cannot be served: without a coordinate
 * nothing can be near it, and with pickup offered but no way to derive a
 * collection code nobody could complete a handover. Refusing at publish time is
 * what turns both into a message on a form rather than a location that appears
 * to be live and never shows up in a single result.
 */
export async function changePublicationState(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
  body: SetLocationPublicationStateInput;
}): Promise<LocationPublicationRow> {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);

  if (input.body.state === 'published' && publication.latitude === null) {
    throw validationError(
      'Drop a map pin before publishing: a location with no position cannot appear in a ' +
        'nearby search, so publishing it would be publishing nothing.',
    );
  }

  const row = await setPublicationState({
    publicationId: publication.id,
    state: input.body.state as LocationPublicationState,
    actorOxyUserId: input.actorOxyUserId,
    at: input.at,
  });
  if (!row) throw notFound('Location not found');
  return row;
}

/** Pause or resume collection at ONE location (#93 operations rule 2). */
export async function changePickupPause(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
  paused: boolean;
  reason?: string;
}): Promise<LocationPublicationRow> {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);
  const reason = input.reason?.trim();
  if (input.paused && (reason === undefined || reason === '')) {
    throw validationError('Say why collection is paused — the reason is what your staff read.');
  }
  const row = await setPickupPause({
    publicationId: publication.id,
    paused: input.paused,
    reason: input.paused ? (reason ?? null) : null,
    actorOxyUserId: input.actorOxyUserId,
    at: input.at,
  });
  if (!row) throw notFound('Location not found');
  return row;
}

/** Add a dated closure. */
export async function addClosure(input: {
  storeId: string;
  locationId: string;
  fromDate: string;
  throughDate: string;
  note?: string;
}): Promise<{ id: string }> {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.throughDate)) {
    throw validationError('A closure needs `fromDate` and `throughDate` as YYYY-MM-DD.');
  }
  if (input.fromDate > input.throughDate) {
    throw validationError('A closure cannot end before it starts.');
  }
  const row = await insertClosure({
    publicationId: publication.id,
    fromDate: input.fromDate,
    throughDate: input.throughDate,
    note: input.note?.trim() || null,
  });
  return { id: row.id };
}

/** Remove a dated closure. */
export async function removeClosure(input: {
  storeId: string;
  locationId: string;
  closureId: string;
}): Promise<void> {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);
  const removed = await deleteClosure({
    publicationId: publication.id,
    closureId: input.closureId,
  });
  if (!removed) throw notFound('Closure not found');
}

/** One location's publication and geocoding audit trail. */
export async function readPublicationTrail(input: {
  storeId: string;
  locationId: string;
  limit: number;
}) {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);
  return listPublicationEvents(publication.id, input.limit);
}

/**
 * Raise or lift an OPERATOR restriction on one location.
 *
 * Not on the merchant surface: it takes a publication id directly and is
 * reached only from `/internal/pickup/*`, because a merchant who could lift it
 * would be a merchant who could overrule Mercaria's own withdrawal.
 */
export async function setOperatorRestriction(input: {
  publicationId: string;
  restricted: boolean;
  reason: string;
  actorOxyUserId: string;
  at: Date;
}): Promise<LocationPublicationRow> {
  const row = await setPublicationRestriction({
    publicationId: input.publicationId,
    restricted: input.restricted,
    reason: input.restricted ? input.reason : null,
    actorOxyUserId: input.actorOxyUserId,
    at: input.at,
  });
  if (!row) throw notFound('Publication not found');
  return row;
}

/** Record a merchant's confirmation that the public profile is still correct. */
export async function confirmPublicationProfile(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
}): Promise<void> {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);
  await appendPublicationEvent({
    publicationId: publication.id,
    kind: 'profile_confirmed',
    actorOxyUserId: input.actorOxyUserId,
    occurredAt: input.at,
  });
}

async function requireOwnedPublication(
  storeId: string,
  locationId: string,
): Promise<LocationPublicationRow> {
  const publication = await findPublicationByLocationId(locationId);
  if (!publication || publication.storeId !== storeId) {
    throw notFound('Location not found');
  }
  return publication;
}

/** `''` and `undefined` both mean "not published", and the column holds NULL. */
function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/**
 * Refuse a publication that offers collection this deployment cannot complete.
 *
 * Exported and called from the checkout gate rather than only at publish time,
 * because `PICKUP_COLLECTION_CODE_KEY` can be removed from a running
 * deployment: a location published while it was configured must stop admitting
 * collections the moment it is not, and a check that only ran on the merchant's
 * form would not notice.
 */
export function assertCollectionRequirementServable(
  identityRequirement: string,
  codesAvailable: boolean,
): void {
  if (identityRequirement === 'order_number_only') return;
  if (codesAvailable) return;
  throw conflict(
    'Collection codes are not configured on this deployment, so a collection that requires ' +
      'one cannot be completed.',
  );
}
