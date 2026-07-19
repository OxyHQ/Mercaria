/**
 * Channel-key ingestion controller — THIN. Serves the NON-`/admin` ingest mount
 * (`/channels/ingest/:connectionId/*`) authenticated by a channel key
 * (`requireChannelKey` set `req.channelKey`).
 *
 * It REUSES the exact same idempotent, provenance-stamping ingest logic as the
 * token-authed admin path by delegating to `channel-ingest.service`. Store
 * scoping comes from the KEY (`req.channelKey.storeId`), never the client — and
 * the service resolves the target connection by `{ _id, storeId }`, so a key can
 * never ingest into another store's connection or a non-`push_in` channel. When
 * the key is bound to a specific connection, a request for any OTHER connection
 * id is rejected before any work is done.
 */

import type { Request, Response } from 'express';
import type { IngestInventoryInput, IngestProductsInput } from '@mercaria/shared-types';
import { ingestProducts, ingestInventory } from '../services/channel-ingest.service.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError, forbidden, notFound } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { log } from '../lib/logger.js';

/**
 * Resolve the target connection id for a key-authed ingest, enforcing the key's
 * binding. A connection-bound key may only address its own connection; a
 * store-scoped key may address any of the store's push-in connections (the
 * service validates store ownership + `push_in`).
 */
function targetConnectionId(req: Request): { storeId: string; connectionId: string } {
  const key = req.channelKey;
  if (!key) {
    throw notFound('Channel key not resolved');
  }
  const connectionId = routeParam(req, 'connectionId');
  if (key.connectionId !== undefined && key.connectionId !== connectionId) {
    throw forbidden('This channel key is not authorized for that connection');
  }
  return { storeId: key.storeId, connectionId };
}

/**
 * POST /channels/ingest/:connectionId/products — idempotent batch upsert of
 * products, authenticated by a channel key.
 */
export async function keyIngestProductsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, connectionId } = targetConnectionId(req);
    const result = await ingestProducts(storeId, connectionId, req.body as IngestProductsInput);
    sendSuccess(res, result);
  } catch (err) {
    log.general.error(
      { err, connectionId: req.params.connectionId },
      'Failed to ingest products via channel key',
    );
    respondWithError(res, err, 'Failed to ingest products');
  }
}

/**
 * POST /channels/ingest/:connectionId/inventory — set stock on the mapped
 * variants, authenticated by a channel key.
 */
export async function keyIngestInventoryHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, connectionId } = targetConnectionId(req);
    const result = await ingestInventory(storeId, connectionId, req.body as IngestInventoryInput);
    sendSuccess(res, result);
  } catch (err) {
    log.general.error(
      { err, connectionId: req.params.connectionId },
      'Failed to ingest inventory via channel key',
    );
    respondWithError(res, err, 'Failed to ingest inventory');
  }
}
