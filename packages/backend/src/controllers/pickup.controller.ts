/**
 * Nearby discovery and P2P proximity — the PUBLIC handlers (#93).
 *
 * Thin: every decision lives in `services/pickup/`. What the controller owns is
 * the two things a service must not — the HTTP cache posture and the actor.
 *
 * ## `Cache-Control: private, no-store`, deliberately, on every response here
 *
 * #93 nearby rule 14 permits caching "only with market, freshness and
 * privacy-safe geospatial boundaries". A nearby answer is keyed on a shopper's
 * own position and carries per-location stock freshness, so a shared cache
 * would be a store of who was where — and a browser cache of it would survive
 * on a shared device. No server-side cache exists either; the read is two
 * indexed statements and the honest posture is not to keep it.
 *
 * ## Signed out is a first-class caller
 *
 * #93 nearby rule 11 and client rule 9: browsing nearby availability must not
 * require an account. `resolveCommerceActor` is used rather than
 * `authenticateToken`, so an `anonymous` actor gets availability exactly as a
 * signed-in one does; the only thing an actor changes is the OPT-IN
 * `checkoutEligibility` annotation.
 */

import type { Request, Response } from 'express';
import type { ItemConditionKey } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { assertUsableCoordinate } from '../services/pickup/geo.js';
import {
  decodeCursor,
  findNearbyAvailability,
  suggestNearbyPlaces,
} from '../services/pickup/nearby.service.js';
import { findNearbyP2pListings } from '../services/pickup/local-discovery.service.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** The posture every response in this file carries — see the module docblock. */
function withoutCaching(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
}

/** `GET /nearby` — is this collectable near me. */
export async function nearbyHandler(req: Request, res: Response): Promise<void> {
  withoutCaching(res);
  const query = req.query as unknown as {
    canonicalVariantId?: string;
    canonicalProductId?: string;
    latitude: number;
    longitude: number;
    originSource?: 'device' | 'map_area' | 'published_place';
    radiusMetres?: number;
    country?: string;
    currency?: string;
    conditionKeys?: ItemConditionKey[];
    withCheckoutEligibility?: 'true' | 'false';
    limit?: number;
    cursor?: string;
  };

  try {
    const origin = assertUsableCoordinate(query.latitude, query.longitude);
    const response = await findNearbyAvailability(
      {
        ...(query.canonicalVariantId === undefined
          ? {}
          : { canonicalVariantId: query.canonicalVariantId }),
        ...(query.canonicalProductId === undefined
          ? {}
          : { canonicalProductId: query.canonicalProductId }),
        origin,
        originSource: query.originSource ?? 'device',
        ...(query.radiusMetres === undefined ? {} : { radiusMetres: query.radiusMetres }),
        ...(query.country === undefined ? {} : { country: query.country }),
        ...(query.currency === undefined ? {} : { currency: query.currency }),
        ...(query.conditionKeys === undefined ? {} : { conditionKeys: query.conditionKeys }),
        limit: query.limit ?? 20,
        ...(query.cursor === undefined ? {} : { cursor: decodeCursor(query.cursor) }),
        withCheckoutEligibility: query.withCheckoutEligibility === 'true',
      },
      req.commerceActor ?? { kind: 'anonymous' },
      new Date(),
    );
    sendSuccess(res, response);
  } catch (err) {
    respondWithError(res, err, 'Failed to answer a nearby search');
  }
}

/**
 * `GET /nearby/places` — the manual-location fallback (#93 acceptance 5).
 *
 * Answers with the cities that actually hold the item, which is why it needs no
 * gazetteer and why Mercaria calls no geocoding provider. A city here always
 * yields results when picked, because the suggestion and the result read share
 * one `where`.
 */
export async function nearbyPlacesHandler(req: Request, res: Response): Promise<void> {
  withoutCaching(res);
  const query = req.query as unknown as {
    canonicalVariantId?: string;
    canonicalProductId?: string;
    q?: string;
    country?: string;
    limit?: number;
  };

  try {
    const places = await suggestNearbyPlaces({
      ...(query.canonicalVariantId === undefined
        ? {}
        : { canonicalVariantId: query.canonicalVariantId }),
      ...(query.canonicalProductId === undefined
        ? {}
        : { canonicalProductId: query.canonicalProductId }),
      ...(query.q === undefined ? {} : { term: query.q }),
      ...(query.country === undefined ? {} : { country: query.country }),
      limit: query.limit ?? 10,
    });
    sendSuccess(res, { places });
  } catch (err) {
    respondWithError(res, err, 'Failed to suggest nearby places');
  }
}

/**
 * `GET /nearby/p2p` — coarse local discovery of P2P listings.
 *
 * A 404 rather than an empty list when the lever is off: a surface this
 * deployment has not rolled out is a page that does not exist here, and an
 * empty list would read as "nobody near you is selling anything", which is a
 * different and wrong claim.
 */
export async function nearbyP2pHandler(req: Request, res: Response): Promise<void> {
  withoutCaching(res);
  if (!config.pickup.p2pLocalDiscoveryEnabled) {
    sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
    return;
  }

  const query = req.query as unknown as { latitude: number; longitude: number; country?: string; limit?: number };
  try {
    const listings = await findNearbyP2pListings({
      origin: assertUsableCoordinate(query.latitude, query.longitude),
      ...(query.country === undefined ? {} : { country: query.country }),
      limit: query.limit ?? 20,
    });
    sendSuccess(res, { listings });
  } catch (err) {
    respondWithError(res, err, 'Failed to answer a local search');
  }
}
