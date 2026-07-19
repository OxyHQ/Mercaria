/**
 * Store channels (connectors) controller — THIN.
 *
 * Every operation is scoped to the loaded store (`req.store`, set by `loadStore`)
 * and gated on `channels:write` by the router. Business logic lives in
 * `connector-sync.service`. Connection responses are the credential-free
 * `Connection` DTO; the sync trigger returns the `SyncRun` DTO. Credentials never
 * appear in any response.
 */

import type { Request, Response } from 'express';
import type { UpdateSyncSettingsInput } from '@mercaria/shared-types';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { ConnectKeyChannelInput } from '../../middleware/channels-schemas.js';
import {
  listConnections,
  buildConnectAuthorizeUrl,
  connectWithApiKey,
  updateSyncSettings,
  requestBackfill,
  disconnect,
  toConnectionDTO,
} from '../../services/connector-sync.service.js';
import { isImplementedProvider } from '../../connectors/registry.js';
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

/** GET /admin/stores/:storeId/channels — the store's connections. */
export async function listChannelsHandler(req: Request, res: Response): Promise<void> {
  try {
    const connections = await listConnections(storeId(req));
    sendSuccess(res, connections);
  } catch (err) {
    log.general.error({ err }, 'Failed to list store channels');
    respondWithError(res, err, 'Failed to load channels');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:provider/connect — begin an OAuth
 * connect. Returns the platform authorize URL the dashboard redirects to.
 */
export async function connectChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const provider = routeParam(req, 'provider');
    if (!isImplementedProvider(provider)) {
      throw notFound(`Connector provider not available: ${provider}`);
    }
    const { shopDomain } = req.body as { shopDomain: string };
    const authorizeUrl = buildConnectAuthorizeUrl({
      storeId: storeId(req),
      providerId: provider,
      userId: getRequiredOxyUserId(req),
      shopDomain,
    });
    sendSuccess(res, { authorizeUrl });
  } catch (err) {
    log.general.error({ err, provider: req.params.provider }, 'Failed to start channel connect');
    respondWithError(res, err, 'Failed to start channel connect');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:provider/connect-key — connect an API-key
 * provider (WooCommerce). Verifies the merchant-supplied consumer key/secret,
 * stores them encrypted, and returns the credential-free `Connection` DTO. Unlike
 * the OAuth `connect` flow there is no browser redirect — the connection is
 * established synchronously.
 */
export async function connectKeyChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const provider = routeParam(req, 'provider');
    if (!isImplementedProvider(provider)) {
      throw notFound(`Connector provider not available: ${provider}`);
    }
    const { shopDomain, consumerKey, consumerSecret } = req.body as ConnectKeyChannelInput;
    const conn = await connectWithApiKey(storeId(req), provider, {
      shopDomain,
      consumerKey,
      consumerSecret,
    });
    sendSuccess(res, toConnectionDTO(conn));
  } catch (err) {
    log.general.error({ err, provider: req.params.provider }, 'Failed to connect channel with API key');
    respondWithError(res, err, 'Failed to connect channel');
  }
}

/** PATCH /admin/stores/:storeId/channels/:connectionId/settings — update sync settings. */
export async function patchChannelSettingsHandler(req: Request, res: Response): Promise<void> {
  try {
    const conn = await updateSyncSettings(
      storeId(req),
      routeParam(req, 'connectionId'),
      req.body as UpdateSyncSettingsInput,
    );
    sendSuccess(res, toConnectionDTO(conn));
  } catch (err) {
    log.general.error({ err, connectionId: req.params.connectionId }, 'Failed to update channel settings');
    respondWithError(res, err, 'Failed to update channel settings');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:connectionId/sync — trigger a backfill.
 * Validates the connection synchronously (404/400), then ENQUEUES the backfill on
 * the `marketplace-sync` queue (inline fallback when Redis is off). Progress is
 * delivered over the `store:${storeId}` Socket.IO room (`sync:progress`).
 */
export async function syncChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    await requestBackfill(storeId(req), connectionId);
    sendSuccess(res, { status: 'enqueued', connectionId }, 202);
  } catch (err) {
    log.general.error({ err, connectionId: req.params.connectionId }, 'Failed to run channel sync');
    respondWithError(res, err, 'Failed to run channel sync');
  }
}

/** DELETE /admin/stores/:storeId/channels/:connectionId — disconnect a channel. */
export async function disconnectChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const conn = await disconnect(storeId(req), routeParam(req, 'connectionId'));
    sendSuccess(res, { id: String(conn._id), status: conn.status });
  } catch (err) {
    log.general.error({ err, connectionId: req.params.connectionId }, 'Failed to disconnect channel');
    respondWithError(res, err, 'Failed to disconnect channel');
  }
}
