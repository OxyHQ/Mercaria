/**
 * The trust rule, asked on a merchant's behalf: does this location's GoWay
 * place name it back (ADR 0013)?
 *
 * The public reads apply the same rule silently — a location that fails it is
 * simply not discoverable — so this module is the one place that EXPLAINS it,
 * to the merchant who owns the location: which conditions fail, what GoWay
 * shows, and the link to edit the place there. It is what
 * `POST …/locations/:id/place-link/verify` answers and what publishing runs
 * first.
 *
 * ## The one write: following a merge
 *
 * GoWay merges duplicate places and keeps a one-hop pointer from the absorbed
 * id to the survivor. The public reads never follow it, so a merged place is
 * unlinked until somebody does; this module does, rewrites the stored id and
 * audits the move (`place_merge_followed`). The survivor still has to name the
 * location back — GoWay moves the absorbed place's capabilities to the
 * survivor unless it already held its own, and then the survivor's statement
 * wins — so following a merge never by itself makes a location discoverable.
 *
 * ## What it cannot see
 *
 * A pending claim. Claims are visible only to whoever acts for the claiming
 * account, and Mercaria reads GoWay with no session at all; the dashboard asks
 * GoWay for the store's claims itself, with the merchant's own session, and
 * shows them beside this verdict.
 */

import type { LocationPlaceLink } from '@mercaria/shared-types';
import { notFound } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import { findLocation } from '../../db/stores/locationRepository.js';
import {
  findPublicationByLocationId,
  setLocationPlaceLink,
} from '../../db/pickup/locationPublicationRepository.js';
import { readPlaceFollowingMerge } from '../goway/places.js';
import { placeLinkGaps, type PlaceLookup } from '../goway/place-facts.js';

/**
 * Check one location's place link now, following a merge if GoWay made one.
 *
 * @throws `notFound` for a location that is not this store's.
 */
export async function verifyLocationPlaceLink(input: {
  storeId: string;
  locationId: string;
  actorOxyUserId: string | null;
  at: Date;
}): Promise<LocationPlaceLink> {
  const location = await findLocation(input.storeId, input.locationId);
  if (!location) throw notFound('Location not found');
  if (location.goWayPlaceId === null) {
    return describePlaceLink({ locationId: location.id, goWayPlaceId: null, lookup: null });
  }

  const read = await readPlaceFollowingMerge(location.goWayPlaceId, { fresh: true });
  if (read.mergedFrom !== undefined && read.lookup.kind === 'found') {
    const publication = await findPublicationByLocationId(location.id);
    if (publication) {
      await getDb().transaction((tx) =>
        setLocationPlaceLink(
          {
            storeId: input.storeId,
            locationId: location.id,
            publicationId: publication.id,
            goWayPlaceId: read.placeId,
            previousGoWayPlaceId: location.goWayPlaceId,
            kind: 'place_merge_followed',
            actorOxyUserId: input.actorOxyUserId,
            at: input.at,
          },
          tx,
        ),
      );
    }
    return describePlaceLink({
      locationId: location.id,
      goWayPlaceId: read.placeId,
      lookup: read.lookup,
      mergedFrom: read.mergedFrom,
    });
  }

  return describePlaceLink({ locationId: location.id, goWayPlaceId: location.goWayPlaceId, lookup: read.lookup });
}

/** The verdict and what GoWay shows, as the merchant reads it. */
export function describePlaceLink(input: {
  locationId: string;
  goWayPlaceId: string | null;
  lookup: PlaceLookup | null;
  mergedFrom?: string;
}): LocationPlaceLink {
  const missing = placeLinkGaps(input);
  const place = input.lookup?.kind === 'found' ? input.lookup.place : null;
  return {
    locationId: input.locationId,
    ...(input.goWayPlaceId === null ? {} : { goWayPlaceId: input.goWayPlaceId }),
    ...(input.mergedFrom === undefined ? {} : { followedMergeFrom: input.mergedFrom }),
    verdict: missing.length === 0 ? 'linked' : 'unlinked',
    missing,
    ...(place === null
      ? {}
      : {
          place: {
            name: place.name,
            status: place.status,
            address: place.address,
            ...(place.timezone === undefined ? {} : { timezone: place.timezone }),
            url: place.url,
          },
          ...(place.storeLink === undefined ? {} : { storeLink: place.storeLink }),
        }),
  };
}
