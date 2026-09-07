/**
 * Discovery feed controller (THIN).
 *
 * Delegates all assembly to `services/discovery/feed.service.ts`; this handler
 * only wires the validated request to the service and the response to the
 * canonical envelope — mirroring `feed.controller.ts`.
 */

import type { Request, Response } from 'express';
import type { DiscoveryScope } from '@mercaria/shared-types';
import { getDiscoveryFeed } from '../services/discovery/feed.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/**
 * GET /discovery/feed?scope=root|category:<handle>|deals
 *
 * PUBLIC, and the response is the same for every caller — nothing in this feed
 * is personalised, so no viewer is passed to the service. `scope` arrives
 * already parsed into a {@link DiscoveryScope} by `routes/discovery.ts`'s Zod
 * schema.
 */
export async function getDiscoveryFeedHandler(req: Request, res: Response): Promise<void> {
  const { scope } = req.query as unknown as { scope: DiscoveryScope };
  try {
    const feed = await getDiscoveryFeed(scope);
    sendSuccess(res, feed);
  } catch (err) {
    log.general.error({ err }, 'Failed to build discovery feed');
    respondWithError(res, err, 'Failed to load discovery feed');
  }
}
