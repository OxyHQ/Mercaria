/**
 * P2P proximity — a seller saying roughly where an item is, and nothing more.
 *
 * ## This is NOT a collection promise, and the types keep it that way
 *
 * #93 P2P rule 6: local P2P discovery is separate from a merchant pickup
 * promise. `NearbyP2pListingResult` carries no location, no hours, no pickup
 * instructions and no eligibility verdict, because a private seller has no
 * counter, no staff and no publication. There is no shape here a client could
 * render as "collect from" — which is stronger than a rule saying not to.
 *
 * ## A precise coordinate exists for microseconds and is never stored
 *
 * The write accepts a position because the alternative is worse: a client that
 * rounds badly, or forgets to, would be the only thing between a seller's home
 * and a public response. The server rounds, stores CELL INDICES, and has
 * nowhere to put the original — `listing_local_discovery` has no coordinate
 * column at all. #93 P2P rule 2 ("never expose a seller's home address before
 * the transaction flow requires it") is therefore not a filter anybody applies;
 * the address was never taken.
 *
 * ## Guest P2P stays refused, with no lever here
 *
 * #93 P2P rule 8 and acceptance 13. Nothing in this module touches checkout;
 * a guest reaching a P2P seller is refused at group construction by
 * `assertGuestP2PCheckoutAllowed` (`services/guest-p2p/gate.ts`, ADR 0003 D18),
 * and `derivePickupEligibility` refuses a `user` seller for every actor. So
 * local discovery being ON cannot make P2P guest pickup reachable, and there
 * is no flag that would — #112 evaluated the reversal and its answer is
 * no-go (`docs/guest-p2p/2026-08-10-guest-p2p-checkout-decision.md`).
 */

import type {
  ListingLocalDiscovery,
  NearbyP2pListingResult,
  SetListingLocalDiscoveryInput,
} from '@mercaria/shared-types';
import { P2P_LOCAL_CELL_PRECISION_DEGREES } from '@mercaria/shared-types';
import type { CurrencyCode, ItemConditionKey } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import { findListingById } from '../../db/catalog/listingRepository.js';
import {
  findLocalDiscovery,
  findNearbyLocalListings,
  upsertLocalDiscovery,
  type ListingLocalDiscoveryRow,
} from '../../db/pickup/localDiscoveryRepository.js';
import { assertUsableCoordinate, distanceBandFor, haversineMetres, localAreaCentre, toLocalArea } from './geo.js';
import type { Coordinate } from './geo.js';

/** How many cells out a local search looks — three cells ≈ 33 km at 0.1°. */
const DEFAULT_RING_CELLS = 3;

/** Project one opt-in row. */
function project(row: ListingLocalDiscoveryRow): ListingLocalDiscovery {
  return {
    listingId: row.listingId,
    enabled: row.enabled,
    area: {
      latIndex: row.cellLatIndex,
      lonIndex: row.cellLonIndex,
      precisionDegrees: row.cellPrecisionDegrees,
    },
    areaLabel: row.areaLabel,
    country: row.country,
    ...(row.region === null ? {} : { region: row.region }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A seller reading their own listing's opt-in. */
export async function readListingLocalDiscovery(input: {
  listingId: string;
  sellerOxyUserId: string;
}): Promise<ListingLocalDiscovery | null> {
  await requireOwnedP2pListing(input);
  const row = await findLocalDiscovery(input.listingId);
  return row === null ? null : project(row);
}

/**
 * A seller opting one listing into (or out of) local discovery.
 *
 * `enabled: false` keeps the area, so turning it back on is one switch rather
 * than re-entering a place — and, more importantly, so "off" and "never asked"
 * stay distinguishable. #93 P2P rule 4 asks that seller and buyer be able to
 * disable location-based discovery independently; this is the seller's half,
 * and the buyer's half is simply not invoking nearby discovery, which is why
 * there is no stored buyer preference here for it to disagree with.
 */
export async function setListingLocalDiscovery(input: {
  listingId: string;
  sellerOxyUserId: string;
  body: SetListingLocalDiscoveryInput;
}): Promise<ListingLocalDiscovery> {
  await requireOwnedP2pListing(input);

  const label = input.body.areaLabel.trim();
  if (label === '') {
    throw validationError('Name the area — a neighbourhood or a town, never a street.');
  }
  const country = input.body.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw validationError('Local discovery needs an ISO-3166 alpha-2 country.');
  }

  // Rounded HERE, on the server, and the precise pair is not passed on. The
  // repository's signature takes indices, so there is no call this function
  // could make that would carry the original through.
  const area = toLocalArea(
    assertUsableCoordinate(input.body.latitude, input.body.longitude),
    P2P_LOCAL_CELL_PRECISION_DEGREES,
  );

  const row = await upsertLocalDiscovery({
    listingId: input.listingId,
    enabled: input.body.enabled,
    cellLatIndex: area.latIndex,
    cellLonIndex: area.lonIndex,
    cellPrecisionDegrees: area.precisionDegrees,
    areaLabel: label,
    country,
    region: input.body.region?.trim() || null,
  });
  return project(row);
}

/**
 * P2P listings near a coarse position.
 *
 * The distance is CELL CENTRE to CELL CENTRE and is reported only as a BAND —
 * no metre figure at all, because a cell-to-cell estimate is accurate to
 * roughly the cell size and a number beside it would claim a precision that
 * does not exist. #93 P2P rule 3 permits an approximate distance and this is
 * what "approximate" honestly means for data rounded to 11 km.
 */
export async function findNearbyP2pListings(input: {
  origin: Coordinate;
  country?: string;
  limit: number;
}): Promise<readonly NearbyP2pListingResult[]> {
  if (!config.pickup.p2pLocalDiscoveryEnabled) return [];

  const viewerCell = toLocalArea(input.origin);
  const viewerCentre = localAreaCentre(viewerCell);

  const rows = await findNearbyLocalListings({
    latIndex: viewerCell.latIndex,
    lonIndex: viewerCell.lonIndex,
    ringCells: DEFAULT_RING_CELLS,
    ...(input.country === undefined ? {} : { country: input.country }),
    limit: input.limit,
  });

  return rows
    .filter((row) => row.priceAmount !== null && row.priceCurrency !== null)
    .map((row) => {
      const centre = localAreaCentre({
        latIndex: row.cellLatIndex,
        lonIndex: row.cellLonIndex,
        precisionDegrees: row.cellPrecisionDegrees,
      });
      return {
        listingId: row.listingId,
        title: row.title,
        price: {
          amount: row.priceAmount as number,
          currency: row.priceCurrency as CurrencyCode,
        },
        condition: row.condition as ItemConditionKey,
        areaLabel: row.areaLabel,
        distanceBand: distanceBandFor(haversineMetres(viewerCentre, centre)),
        sellerOxyUserId: row.sellerOxyUserId,
      };
    })
    .sort((left, right) => left.distanceBand.localeCompare(right.distanceBand));
}

/**
 * A listing the caller personally owns, and which is a P2P one.
 *
 * A STORE listing is refused rather than silently accepted: a store's stock has
 * a publication and a collection desk, and letting one carry a coarse "area"
 * beside that would be two answers to where it is. #93 P2P rule 9's converse —
 * "store guest pickup eligibility cannot be inherited by a P2P seller" — has a
 * mirror worth holding too.
 */
async function requireOwnedP2pListing(input: {
  listingId: string;
  sellerOxyUserId: string;
}): Promise<void> {
  const listing = await findListingById(input.listingId);
  if (!listing) throw notFound('Listing not found');
  if (listing.ownerType !== 'user' || listing.oxyUserId !== input.sellerOxyUserId) {
    // ONE indistinguishable answer for "not yours" and "not a P2P listing", so
    // the endpoint is not an oracle for whether a listing id exists.
    throw forbidden('That listing is not yours.');
  }
}
