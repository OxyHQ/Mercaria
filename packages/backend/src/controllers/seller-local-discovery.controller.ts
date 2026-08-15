/**
 * A P2P seller's own local-discovery opt-in (#93 P2P rules 1 and 4).
 *
 * Two handlers and no list route, deliberately: local discovery is a property
 * of ONE listing, and "show me every listing I have opted in" is a filter on the
 * seller's own listing list rather than a second surface with its own
 * authorization to get wrong.
 *
 * There is no route here that returns anybody ELSE's area, coarse or otherwise.
 * The public read is `GET /nearby/p2p`, which answers with an area LABEL and a
 * distance BAND and carries no cell indices at all.
 */

import type { Request, Response } from 'express';
import type { SetListingLocalDiscoveryInput } from '@mercaria/shared-types';
import { respondWithError } from '../lib/errors/error-codes.js';
import {
  readListingLocalDiscovery,
  setListingLocalDiscovery,
} from '../services/pickup/local-discovery.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';

/** GET /seller/listings/:id/local-discovery. */
export async function getLocalDiscoveryHandler(req: Request, res: Response): Promise<void> {
  try {
    const discovery = await readListingLocalDiscovery({
      listingId: routeParam(req, 'id'),
      sellerOxyUserId: req.userId ?? '',
    });
    sendSuccess(res, { discovery });
  } catch (err) {
    respondWithError(res, err, 'Failed to load local discovery');
  }
}

/** PUT /seller/listings/:id/local-discovery. */
export async function putLocalDiscoveryHandler(req: Request, res: Response): Promise<void> {
  try {
    const discovery = await setListingLocalDiscovery({
      listingId: routeParam(req, 'id'),
      sellerOxyUserId: req.userId ?? '',
      body: req.body as SetListingLocalDiscoveryInput,
    });
    sendSuccess(res, { discovery });
  } catch (err) {
    respondWithError(res, err, 'Failed to save local discovery');
  }
}
