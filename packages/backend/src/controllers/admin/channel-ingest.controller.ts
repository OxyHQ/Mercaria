/**
 * Channel ingestion (push_in) controller — THIN.
 *
 * Every operation is scoped to the loaded store (`req.store`, set by `loadStore`)
 * and gated on `channels:write` by the router. Business logic lives in
 * `channel-ingest.service`. Handlers only resolve the store id + validated route
 * params/body and shape the response DTO; they never build models or spread the
 * request body.
 */

import type { Request, Response } from 'express';
import type {
  ConnectPushInput,
  IngestInventoryInput,
  IngestProductsInput,
} from '@mercaria/shared-types';
import {
  connectPushIn,
  ingestProducts,
  ingestInventory,
  isKnownConnectorProvider,
} from '../../services/channel-ingest.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError, notFound } from '../../lib/errors/error-codes.js';
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
 * POST /admin/stores/:storeId/channels/:provider/connect-push — establish a
 * `push_in` connection the external client ingests against. Returns
 * `{ connectionId, storeId }`.
 */
export async function connectPushChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const provider = routeParam(req, 'provider');
    if (!isKnownConnectorProvider(provider)) {
      throw notFound(`Connector provider not available: ${provider}`);
    }
    const { shopDomain } = req.body as ConnectPushInput;
    const conn = await connectPushIn(storeId(req), provider, {
      ...(shopDomain ? { shopDomain } : {}),
    });
    sendSuccess(res, { connectionId: String(conn._id), storeId: conn.storeId });
  } catch (err) {
    log.general.error({ err, provider: req.params.provider }, 'Failed to establish push-in channel');
    respondWithError(res, err, 'Failed to establish push-in channel');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:connectionId/ingest/products — idempotent
 * batch upsert of products pushed in by the external client.
 */
export async function ingestProductsHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await ingestProducts(
      storeId(req),
      routeParam(req, 'connectionId'),
      req.body as IngestProductsInput,
    );
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err, connectionId: req.params.connectionId }, 'Failed to ingest products');
    respondWithError(res, err, 'Failed to ingest products');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:connectionId/ingest/inventory — set stock
 * on the mapped variants at the store's default location.
 */
export async function ingestInventoryHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await ingestInventory(
      storeId(req),
      routeParam(req, 'connectionId'),
      req.body as IngestInventoryInput,
    );
    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err, connectionId: req.params.connectionId }, 'Failed to ingest inventory');
    respondWithError(res, err, 'Failed to ingest inventory');
  }
}
