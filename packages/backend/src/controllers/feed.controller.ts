/**
 * Feed controller (THIN).
 *
 * Delegates all assembly to `feed.service`; this handler only wires the request
 * to the service and the response to the canonical envelope.
 */

import type { Request, Response } from 'express';
import { getFeed } from '../services/feed.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** GET /feed — the DB-backed home feed. PUBLIC; viewerId (optional) drives `saved`. */
export async function getHomeFeed(req: Request, res: Response): Promise<void> {
  try {
    const feed = await getFeed(req.user?.id);
    sendSuccess(res, feed);
  } catch (err) {
    log.general.error({ err }, 'Failed to build home feed');
    respondWithError(res, err, 'Failed to load feed');
  }
}
