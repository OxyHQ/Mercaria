/**
 * Channel API keys admin controller — THIN. Serves the dashboard's key
 * management surface under `/admin/stores/:storeId/channel-keys`, gated on
 * `channels:write` (owner + admin) by the router. Business logic — hashing,
 * constant-time verification, store scoping — lives in `channel-key.service`.
 *
 * Handlers resolve the loaded store id (`loadStore` set `req.store`) and the
 * authenticated Oxy user (`getRequiredOxyUserId`), pass the validated body
 * through, and shape the response. The plaintext key is returned ONLY by the
 * generate handler and ONLY once.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { GenerateChannelApiKeyInput } from '@mercaria/shared-types';
import { generateKey, listKeys, revokeKey } from '../../services/channel-key.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
import type { GenerateChannelKeyBody } from '../../middleware/channels-schemas.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) {
    throw notFound('Store not loaded');
  }
  return String((store as { _id: unknown })._id);
}

/**
 * POST /admin/stores/:storeId/channel-keys — mint a channel key. Returns the
 * plaintext key ONCE alongside its metadata (HTTP 201).
 */
export async function generateChannelKeyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as GenerateChannelKeyBody;
    const input: GenerateChannelApiKeyInput = {
      label: body.label,
      ...(body.connectionId !== undefined ? { connectionId: body.connectionId } : {}),
    };
    const result = await generateKey(storeId(req), input, getRequiredOxyUserId(req));
    sendSuccess(res, result, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to generate channel key');
    respondWithError(res, err, 'Failed to generate channel key');
  }
}

/** GET /admin/stores/:storeId/channel-keys — list the store's active keys (metadata only). */
export async function listChannelKeysHandler(req: Request, res: Response): Promise<void> {
  try {
    const keys = await listKeys(storeId(req));
    sendSuccess(res, keys);
  } catch (err) {
    log.general.error({ err }, 'Failed to list channel keys');
    respondWithError(res, err, 'Failed to list channel keys');
  }
}

/** DELETE /admin/stores/:storeId/channel-keys/:keyId — revoke a key. */
export async function revokeChannelKeyHandler(req: Request, res: Response): Promise<void> {
  try {
    const key = await revokeKey(storeId(req), routeParam(req, 'keyId'));
    sendSuccess(res, key);
  } catch (err) {
    log.general.error({ err, keyId: req.params.keyId }, 'Failed to revoke channel key');
    respondWithError(res, err, 'Failed to revoke channel key');
  }
}
