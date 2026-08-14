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
  requestWebhookReregistration,
  disconnect,
  toConnectionDTOWithWebhookFailures,
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
  return store.id;
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
    sendSuccess(res, await toConnectionDTOWithWebhookFailures(conn));
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
    sendSuccess(res, await toConnectionDTOWithWebhookFailures(conn));
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

/**
 * POST /admin/stores/:storeId/channels/:connectionId/webhooks/reregister — ask the
 * platform for this channel's real-time subscriptions again (#262).
 *
 * The remedy for a registration the platform partially refused, or one Mercaria
 * could not conclude anything about, WITHOUT disconnecting and reconnecting the
 * channel — which is what a merchant had to do before, and which costs them the
 * OAuth round trip or a fresh API key for a problem that is usually a scope they
 * have since widened.
 *
 * Validates synchronously (404 for a missing or cross-store connection, 400 for a
 * disconnected, push-in or credential-less one) and then ENQUEUES, exactly like
 * `sync`: the work is a handful of calls to somebody else's platform and does not
 * belong inside the request. The outcome arrives on the connection itself —
 * `webhookFailures` names the topics that still will not arrive and
 * `webhookRegistration` says whether Mercaria is still retrying.
 */
export async function reregisterChannelWebhooksHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    await requestWebhookReregistration(storeId(req), connectionId);
    sendSuccess(res, { status: 'enqueued', connectionId }, 202);
  } catch (err) {
    log.general.error(
      { err, connectionId: req.params.connectionId },
      'Failed to request channel webhook re-registration',
    );
    respondWithError(res, err, 'Failed to request webhook registration');
  }
}

/**
 * DELETE /admin/stores/:storeId/channels/:connectionId — disconnect a channel,
 * keeping its listings.
 *
 * The v1 spelling, and it is a VERSIONED CONTRACT rather than a shim: a shipped
 * dashboard build calls it, and #87 cannot recall one. `keep_listings` is the
 * behaviour this route has always had — it stopped syncing and touched nothing —
 * so mapping it to that policy preserves what every existing caller gets rather
 * than quietly giving them a new one.
 *
 * A merchant choosing a policy uses
 * `POST /admin/stores/:storeId/channels/:connectionId/disconnect`. This route
 * retires when supported dashboard versions have migrated.
 */
export async function disconnectChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const conn = await disconnect(storeId(req), routeParam(req, 'connectionId'), 'keep_listings');
    sendSuccess(res, { id: conn.id, status: conn.status });
  } catch (err) {
    log.general.error({ err, connectionId: req.params.connectionId }, 'Failed to disconnect channel');
    respondWithError(res, err, 'Failed to disconnect channel');
  }
}
