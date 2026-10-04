/**
 * The merchant's own surface: linking one location to its GoWay place, and
 * composing, publishing and pausing its commerce profile.
 *
 * ## No new permission was invented
 *
 * #93 operations rule 4 asks that address edits and pickup settings be
 * restricted "through existing store permissions", and they are:
 * `locations:write` already means "may change where this store keeps stock",
 * and publishing a shop front is the same authority pointed outward.
 *
 * ## Where the shop IS is edited in GoWay, not here (ADR 0013)
 *
 * Name, address, map pin, hours and their exceptions, contact and
 * accessibility are the GoWay place's, and the dashboard edits them there with
 * the merchant's own Oxy session. What this module writes is Mercaria's alone:
 * WHICH place the location trades from, whether it offers collection and on
 * what terms, and how fresh its stock claims are.
 *
 * ## Validation refuses rather than repairs
 *
 * A place GoWay has never heard of, a stock interval outside the bounds the
 * CHECK holds — each is refused with a sentence naming the field. The
 * alternative produces a shop front that is subtly wrong in a way nobody
 * looking at the dashboard can see, and the person who finds out is a customer
 * standing outside a closed door.
 *
 * ## Publishing is a separate act from editing
 *
 * `upsertPublication` writes the profile and never the state; `publish` and
 * `withdraw` move the state and never the profile. Folding them would mean a
 * merchant fixing a typo on a withdrawn location silently republished it —
 * which is the one editorial mistake with an audience. Publishing runs the
 * trust rule first and refuses a location whose place does not name it back.
 */

import type {
  LocationPublicationState,
  MerchantLocationPublication,
  PlaceLinkGap,
  SetLocationPublicationStateInput,
  UpsertLocationPublicationInput,
} from '@mercaria/shared-types';
import { isUniqueViolation } from '@oxy.so/db';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { findLocation, findLocationsByStore, type LocationRecord } from '../../db/stores/locationRepository.js';
import {
  findPublicationByLocationId,
  listPublicationEvents,
  listPublicationsForStore,
  setLocationPlaceLink,
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
import { GoWayUnavailableError, readPlaceFollowingMerge } from '../goway/places.js';
import { verifyLocationPlaceLink } from './place-link.service.js';

/** The whole commerce profile of one location, as the merchant who owns it reads it back. */
export async function readPublication(input: {
  storeId: string;
  locationId: string;
}): Promise<MerchantLocationPublication | null> {
  const location = await findLocation(input.storeId, input.locationId);
  if (!location) return null;
  const publication = await findPublicationByLocationId(input.locationId);
  // The tenant predicate is on the row rather than on the request: a
  // publication whose `store_id` is not the caller's is answered as ABSENT, so
  // a guessed location id discloses nothing about whether it exists.
  if (!publication || publication.storeId !== input.storeId) return null;
  return projectPublication(publication, location);
}

/** Every publication a store owns. */
export async function listStorePublications(storeId: string): Promise<readonly MerchantLocationPublication[]> {
  const [rows, locations] = await Promise.all([listPublicationsForStore(storeId), findLocationsByStore(storeId)]);
  const byId = new Map(locations.map((location) => [location.id, location]));
  return rows.flatMap((row) => {
    const location = byId.get(row.locationId);
    return location === undefined ? [] : [projectPublication(row, location)];
  });
}

/**
 * Link a location to its GoWay place and compose or replace its commerce
 * profile.
 *
 * The whole profile is written every time — a PUT rather than a PATCH —
 * because a partial save of a shop front has no defensible semantics.
 *
 * The place is checked against GoWay first: it must EXIST (a merged one is
 * followed to its survivor, which is what gets stored). Whether it names the
 * location back is not required to SAVE — the merchant may assert that in
 * GoWay after choosing the place, and the dashboard saves before it can — only
 * to PUBLISH. GoWay unable to answer is a `503`: storing an id nobody could
 * check would leave the merchant to discover a typo at publish time.
 */
export async function upsertPublication(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
  body: UpsertLocationPublicationInput;
}): Promise<MerchantLocationPublication> {
  const location = await findLocation(input.storeId, input.locationId);
  if (!location) throw notFound('Location not found');

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

  const goWayPlaceId = await resolveChosenPlace(input.body.goWayPlaceId.trim());
  const existing = await findPublicationByLocationId(input.locationId);

  try {
    const publication = await getDb().transaction(async (tx) => {
      const row = await upsertLocationPublication(
        {
          locationId: location.id,
          storeId: location.storeId,
          // #84's linkage answers which MERCHANT operates this store; the
          // storefront is the merchant's own subdivision and only they know
          // which branch this is. Left as it was here and set by its own
          // endpoint, which is where the "belongs to the linked merchant"
          // check lives.
          storefrontId: existing?.storefrontId ?? null,
          pickupOffered: input.body.pickupOffered,
          pickupInstructions: emptyToNull(input.body.pickupInstructions),
          identityRequirement: input.body.identityRequirement ?? 'collection_code',
          inventorySource: input.body.inventorySource,
          stockConfirmationIntervalSeconds: interval,
          disclosesExactStock: input.body.disclosesExactStock === true,
          lowStockThreshold: input.body.lowStockThreshold ?? 3,
        },
        tx,
      );
      await setLocationPlaceLink(
        {
          storeId: location.storeId,
          locationId: location.id,
          publicationId: row.id,
          goWayPlaceId,
          previousGoWayPlaceId: location.goWayPlaceId,
          kind: 'place_linked',
          actorOxyUserId: input.actorOxyUserId,
          at: input.at,
        },
        tx,
      );
      return row;
    });
    return projectPublication(publication, { ...location, goWayPlaceId });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(
        'Another of this store\'s locations already trades from that GoWay place. A place names ' +
          'one location back, so unlink the other location first.',
      );
    }
    throw error;
  }
}

/**
 * The id a merchant chose, checked against GoWay: the place itself, or the
 * survivor GoWay merged it into.
 */
async function resolveChosenPlace(placeId: string): Promise<string> {
  if (placeId === '') throw validationError('Choose the GoWay place this location trades from.');
  const read = await readPlaceFollowingMerge(placeId, { fresh: true });
  switch (read.lookup.kind) {
    case 'found':
      return read.placeId;
    case 'unavailable':
      throw new GoWayUnavailableError(
        'GoWay could not confirm that place right now, so the location was not saved. Try again in a minute.',
      );
    case 'not_found':
    case 'gone':
      throw validationError('GoWay has no such place. Search for the shop again, or create it.');
  }
}

/**
 * Publish, withdraw or return one location to draft.
 *
 * Publishing REFUSES a location the trust rule refuses (ADR 0013), naming
 * every missing condition: a location whose place does not name it back can
 * never be discovered, so publishing it would be publishing nothing — and the
 * merchant would find out from a shopper rather than from the form. The check
 * is fresh (it follows a GoWay merge if there was one), and GoWay being unable
 * to answer refuses too, rather than publishing on trust.
 */
export async function changePublicationState(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
  body: SetLocationPublicationStateInput;
}): Promise<MerchantLocationPublication> {
  const publication = await requireOwnedPublication(input.storeId, input.locationId);

  if (input.body.state === 'published') {
    const link = await verifyLocationPlaceLink({
      storeId: input.storeId,
      locationId: input.locationId,
      actorOxyUserId: input.actorOxyUserId,
      at: input.at,
    });
    if (link.missing.includes('goway_unavailable')) {
      throw new GoWayUnavailableError(
        'GoWay could not confirm this location\'s place right now, so it was not published. Try again in a minute.',
      );
    }
    if (link.verdict !== 'linked') throw unpublishable(link.missing);
  }

  const row = await setPublicationState({
    publicationId: publication.id,
    state: input.body.state as LocationPublicationState,
    actorOxyUserId: input.actorOxyUserId,
    at: input.at,
  });
  if (!row) throw notFound('Location not found');
  return projectOwned(input.storeId, row);
}

/** Pause or resume collection at ONE location (#93 operations rule 2). */
export async function changePickupPause(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string;
  at: Date;
  paused: boolean;
  reason?: string;
}): Promise<MerchantLocationPublication> {
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
  return projectOwned(input.storeId, row);
}

/** One location's publication and place-link audit trail. */
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

async function projectOwned(storeId: string, row: LocationPublicationRow): Promise<MerchantLocationPublication> {
  const location = await findLocation(storeId, row.locationId);
  if (!location) throw notFound('Location not found');
  return projectPublication(row, location);
}

/**
 * The merchant's read of a publication. The operator who restricted it is NOT
 * named: the restriction and its reason are the merchant's to see, the staff
 * member behind it is Mercaria's.
 */
function projectPublication(
  row: LocationPublicationRow,
  location: Pick<LocationRecord, 'goWayPlaceId'>,
): MerchantLocationPublication {
  return {
    id: row.id,
    locationId: row.locationId,
    ...(location.goWayPlaceId === null ? {} : { goWayPlaceId: location.goWayPlaceId }),
    ...(row.storefrontId === null ? {} : { storefrontId: row.storefrontId }),
    publicationState: row.publicationState,
    pickupOffered: row.pickupOffered,
    ...(row.pickupInstructions === null ? {} : { pickupInstructions: row.pickupInstructions }),
    identityRequirement: row.identityRequirement,
    paymentRequirement: row.paymentRequirement,
    ...(row.pickupPausedAt === null ? {} : { pickupPausedAt: row.pickupPausedAt.toISOString() }),
    ...(row.pickupPauseReason === null ? {} : { pickupPauseReason: row.pickupPauseReason }),
    restricted: row.restrictedAt !== null,
    ...(row.restrictionReason === null ? {} : { restrictionReason: row.restrictionReason }),
    inventorySource: row.inventorySource,
    stockConfirmationIntervalSeconds: row.stockConfirmationIntervalSeconds,
    disclosesExactStock: row.disclosesExactStock,
    lowStockThreshold: row.lowStockThreshold,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The refusal a publish gets, naming every condition the trust rule found missing. */
function unpublishable(missing: readonly PlaceLinkGap[]): Error {
  return validationError(
    `This location cannot be published until its GoWay place names it: ${missing.join(', ')}. ` +
      'Check the place link for what to fix.',
  );
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
