/**
 * Feed controller (THIN).
 *
 * Delegates all assembly to `feed.service`; this handler only wires the request
 * to the service and the response to the canonical envelope.
 */

import type { Request, Response } from 'express';
import { getFeed } from '../services/feed.service.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/** GET /feed — the DB-backed home feed. PUBLIC; viewerId (optional) drives `saved`. */
export async function getHomeFeed(req: Request, res: Response): Promise<void> {
  try {
    const feed = await getFeed(req.user?.id);
    sendSuccess(res, feed);
  } catch (err) {
    log.general.error({ err }, 'Failed to build home feed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to load feed', 500);
  }
}
