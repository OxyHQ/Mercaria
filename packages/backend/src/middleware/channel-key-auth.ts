/**
 * Channel API key authentication middleware.
 *
 * Guards the NON-`/admin` ingest mount (`/channels/ingest/...`) that the external
 * push client reaches with only a long-lived channel key — no Oxy user, no store
 * membership. It reads the key from `Authorization: Bearer mck_...` (preferred)
 * or the `X-Mercaria-Channel-Key` header, verifies it via `channel-key.service`
 * (constant-time hash compare, revoked keys rejected), and attaches the resolved
 * `{ storeId, connectionId?, keyId }` to `req.channelKey`. The downstream handler
 * enforces that the target connection belongs to the key's store and is
 * `push_in` (reusing the ingest service's store-scoped resolution).
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyKey, type VerifiedChannelKey } from '../services/channel-key.service.js';
import { sendError, ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireChannelKey` after a channel key verifies. */
      channelKey?: VerifiedChannelKey;
    }
  }
}

/** Extract the presented key from the Authorization bearer or the custom header. */
function extractKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token !== '') {
      return token;
    }
  }
  const custom = req.headers['x-mercaria-channel-key'];
  if (typeof custom === 'string' && custom.trim() !== '') {
    return custom.trim();
  }
  return null;
}

/**
 * Require a valid, non-revoked channel key. Responds 401 when the key is absent
 * or does not verify; on success sets `req.channelKey` and continues.
 */
export async function requireChannelKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = extractKey(req);
  if (raw === null) {
    sendError(res, ErrorCodes.UNAUTHORIZED, 'Channel API key required', 401);
    return;
  }

  try {
    const resolved = await verifyKey(raw);
    if (!resolved) {
      sendError(res, ErrorCodes.UNAUTHORIZED, 'Invalid or revoked channel API key', 401);
      return;
    }
    req.channelKey = resolved;
    next();
  } catch (err) {
    log.auth.error({ err }, 'Channel key verification failed');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Authentication failed', 500);
  }
}
