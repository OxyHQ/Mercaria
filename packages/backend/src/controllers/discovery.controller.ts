/**
 * Discovery feed controller (THIN).
 *
 * Delegates all assembly to `services/discovery/feed.service.ts`; this handler
 * only wires the validated request to the service and the response to the
 * canonical envelope — mirroring `feed.controller.ts`.
 */

import type { Request, Response } from 'express';
import type { DiscoveryScope, DiscoverySignal } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDiscoveryFeed } from '../services/discovery/feed.service.js';
import {
  getDiscoverySignalPage,
  type DiscoverySignalScope,
} from '../services/discovery/signal.service.js';
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

/**
 * GET /discovery/signal?signal=<DiscoverySignal>&scope=root|category:<handle>&limit=&offset=
 *
 * PUBLIC, the "see all" a shelf's heading links to. `routes/discovery.ts`'s
 * schema already refused an unknown `signal`, a `scope=deals` and an
 * out-of-range `limit`/`offset`, so this handler only fills in the two
 * defaults a bound query parameter is allowed to omit.
 */
export async function getDiscoverySignalPageHandler(req: Request, res: Response): Promise<void> {
  const { signal, scope, limit, offset } = req.query as unknown as {
    signal: DiscoverySignal;
    scope: DiscoverySignalScope;
    limit?: number;
    offset?: number;
  };
  try {
    const page = await getDiscoverySignalPage({
      signal,
      scope,
      limit: limit ?? config.pagination.defaultPageSize,
      offset: offset ?? 0,
    });
    sendSuccess(res, page);
  } catch (err) {
    log.general.error({ err }, 'Failed to build discovery signal page');
    respondWithError(res, err, 'Failed to load discovery signal page');
  }
}
