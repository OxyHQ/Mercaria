/**
 * The unified channel surface (#87) — THIN.
 *
 * Every handler is scoped to the loaded store (`req.store`, set by `loadStore`)
 * and gated on `channels:write` by the router, which is #63's reasoning: a feed
 * is a sales channel's inventory arriving by file, and the permission that gates
 * connecting a Shopify shop is the one that should gate every other way of
 * supplying a catalogue. It is denied to `staff` by the role matrix — deciding
 * where a store's products come from is not a shop-floor act.
 *
 * Business logic lives in `services/channels/`. Nothing here composes a
 * response from a row: every projection names its fields in the service, which
 * is what keeps a credential column from reaching a screen because somebody
 * spread a row.
 */

import type { Request, Response } from 'express';
import type { ChannelDisconnectPolicy, ChannelPauseScope } from '@mercaria/shared-types';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { findConnection, setConnectionPause } from '../../db/connectors/connectionRepository.js';
import { listSyncRunsForConnection } from '../../db/connectors/syncRunRepository.js';
import { recordChannelAuditEvent, listChannelAuditEvents } from '../../db/channels/channelAuditRepository.js';
import { notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { channelTypeForConnection, listChannelTypes } from '../../services/channels/channel-catalog.js';
import { disconnectChannel } from '../../services/channels/channel-disconnect.service.js';
import {
  abandonChannelOnboarding,
  activateChannelOnboarding,
  advanceChannelOnboarding,
  getChannelOnboarding,
  listChannelOnboarding,
  startChannelOnboarding,
} from '../../services/channels/channel-onboarding.service.js';
import { deriveChannelReadiness } from '../../services/channels/channel-readiness.js';
import { reconcileChannel } from '../../services/channels/channel-reconciliation.service.js';
import { listStoreChannels } from '../../services/channels/channel-summary.service.js';
import {
  readSyncRunRecordFailures,
  toSyncRunDTO,
} from '../../services/connector-sync.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { routeParam } from '../../utils/request.js';

/** How many runs one history page carries. */
const RUN_HISTORY_LIMIT = 50;
/** How many audit entries one page carries. */
const AUDIT_PAGE_LIMIT = 100;

/** The loaded store id for the current request (guaranteed by `loadStore`). */
function storeId(req: Request): string {
  const store = req.store;
  if (!store) throw notFound('Store not loaded');
  return store.id;
}

/**
 * The ONE path from a `:connectionId` to a row on this surface.
 *
 * A connection belonging to another store is answered 404 rather than 403 — a
 * distinguishable response would let a store member enumerate which connection
 * ids exist. It is the same shape `assertConfigurationBelongsToStore` (#63) uses
 * one surface over, and `findConnection` makes it structural: the query carries
 * `store_id`, so a cross-store id and an unknown id are literally the same code
 * path and 403 is unreachable.
 */
async function assertConnectionBelongsToStore(req: Request, connectionId: string) {
  const connection = await findConnection(storeId(req), connectionId);
  if (!connection) throw notFound('Connection not found');
  return connection;
}

/** GET /admin/stores/:storeId/channels/catalog — what may be connected, and why not. */
export async function listChannelCatalogHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, listChannelTypes());
  } catch (err) {
    log.general.error({ err }, 'Failed to list the channel catalog');
    respondWithError(res, err, 'Failed to load the channel catalog');
  }
}

/** GET /admin/stores/:storeId/channels/summary — connectors, feeds and native, in one shape. */
export async function listChannelSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listStoreChannels(storeId(req)));
  } catch (err) {
    log.general.error({ err }, 'Failed to summarize store channels');
    respondWithError(res, err, 'Failed to load channels');
  }
}

/**
 * GET /admin/stores/:storeId/channels/readiness — the ONE readiness result.
 *
 * #87 acceptance 7's consumer surface. Derived on every call; see
 * `channel-readiness.ts` for why nothing caches it.
 */
export async function getChannelReadinessHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await deriveChannelReadiness(storeId(req)));
  } catch (err) {
    log.general.error({ err }, 'Failed to derive channel readiness');
    respondWithError(res, err, 'Failed to load channel readiness');
  }
}

/** GET /admin/stores/:storeId/channels/:connectionId/runs — the run history. */
export async function listChannelRunsHandler(req: Request, res: Response): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    await assertConnectionBelongsToStore(req, connectionId);
    const runs = await listSyncRunsForConnection(connectionId, RUN_HISTORY_LIMIT);
    sendSuccess(res, runs.map(toSyncRunDTO));
  } catch (err) {
    log.general.error({ err }, 'Failed to list channel runs');
    respondWithError(res, err, 'Failed to load the sync history');
  }
}

/**
 * GET /admin/stores/:storeId/channels/:connectionId/runs/:runId/record-failures
 * — WHICH records that run refused, and why (#303).
 *
 * A separate call from the run list on purpose: fifty runs each carrying up to
 * two hundred reasons is a payload nobody asked for, and fetching them per
 * listed run is the N+1 #70 made unrepresentable in its own domain. The client's
 * trigger is `counts.failed`, which the list already carries.
 *
 * Two scopes, both required. This asserts the CONNECTION belongs to the store;
 * the service resolves the RUN scoped to that connection, so a run id from
 * another store answers 404 rather than somebody else's refused products.
 */
export async function listChannelRunRecordFailuresHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    const runId = routeParam(req, 'runId');
    await assertConnectionBelongsToStore(req, connectionId);
    sendSuccess(res, await readSyncRunRecordFailures(connectionId, runId));
  } catch (err) {
    log.general.error({ err }, 'Failed to list a run’s record failures');
    respondWithError(res, err, 'Failed to load the records this sync refused');
  }
}

/**
 * GET /admin/stores/:storeId/channels/:connectionId/reconciliation — what is
 * already indexed for this merchant, and where it overlaps.
 */
export async function getChannelReconciliationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    sendSuccess(res, await reconcileChannel(storeId(req), connectionId));
  } catch (err) {
    log.general.error({ err }, 'Failed to reconcile a channel');
    respondWithError(res, err, 'Failed to load the reconciliation report');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:connectionId/pause — pause or resume ONE
 * scope.
 *
 * Idempotent by the repository's CAS: pausing something already paused matches
 * no row, and the handler reads the connection back rather than reporting a
 * conflict for an outcome the merchant asked for and already has.
 */
export async function pauseChannelHandler(req: Request, res: Response): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    const { scope, paused } = req.body as { scope: ChannelPauseScope; paused: boolean };
    const existing = await assertConnectionBelongsToStore(req, connectionId);

    const updated = await setConnectionPause(storeId(req), connectionId, scope, paused);
    if (updated) {
      await recordChannelAuditEvent({
        storeId: storeId(req),
        action:
          scope === 'fetch'
            ? paused
              ? 'fetch_paused'
              : 'fetch_resumed'
            : paused
              ? 'publication_paused'
              : 'publication_resumed',
        actorOxyUserId: getRequiredOxyUserId(req),
        channelType: channelTypeForConnection(existing),
        connectionId,
        changedFields: [scope === 'fetch' ? 'fetchPausedAt' : 'publicationPausedAt'],
      });
    }

    sendSuccess(res, {
      connectionId,
      scope,
      paused,
      changed: updated !== null,
    });
  } catch (err) {
    log.general.error({ err }, 'Failed to change a channel pause state');
    respondWithError(res, err, 'Failed to change the pause state');
  }
}

/**
 * POST /admin/stores/:storeId/channels/:connectionId/disconnect — disconnect
 * with an explicit policy.
 *
 * A POST rather than the pre-#87 `DELETE`, because the policy is a required body
 * and a DELETE carrying one that decides the fate of a catalogue is a request
 * shape nobody expects. `DELETE` remains, mapped to `keep_listings` — see the
 * route file.
 */
export async function disconnectChannelWithPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const connectionId = routeParam(req, 'connectionId');
    const { policy } = req.body as { policy: ChannelDisconnectPolicy };
    const existing = await assertConnectionBelongsToStore(req, connectionId);

    const result = await disconnectChannel(storeId(req), connectionId, policy);

    await recordChannelAuditEvent({
      storeId: storeId(req),
      action: 'disconnected',
      actorOxyUserId: getRequiredOxyUserId(req),
      channelType: channelTypeForConnection(existing),
      connectionId,
      changedFields: ['status', 'disconnectPolicy', 'credentials', 'webhookIds'],
    });

    sendSuccess(res, result);
  } catch (err) {
    log.general.error({ err }, 'Failed to disconnect a channel');
    respondWithError(res, err, 'Failed to disconnect the channel');
  }
}

/** GET /admin/stores/:storeId/channels/audit — who changed what. */
export async function listChannelAuditHandler(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listChannelAuditEvents(storeId(req), { limit: AUDIT_PAGE_LIMIT });
    sendSuccess(
      res,
      rows.map((row) => ({
        id: row.id,
        storeId: row.storeId,
        action: row.action,
        channelType: row.channelType ?? undefined,
        connectionId: row.connectionId ?? undefined,
        feedConfigurationId: row.feedConfigurationId ?? undefined,
        actorOxyUserId: row.actorOxyUserId,
        changedFields: row.changedFields,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list the channel audit trail');
    respondWithError(res, err, 'Failed to load the audit trail');
  }
}

// ── Onboarding ──────────────────────────────────────────────────────────────

/** POST /admin/stores/:storeId/channels/onboarding — start or resume a wizard. */
export async function startChannelOnboardingHandler(req: Request, res: Response): Promise<void> {
  try {
    const { channelType } = req.body as { channelType: Parameters<typeof startChannelOnboarding>[0]['channelType'] };
    const { session } = await startChannelOnboarding({
      storeId: storeId(req),
      channelType,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, session, 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to start channel onboarding');
    respondWithError(res, err, 'Failed to start the connection wizard');
  }
}

/** GET /admin/stores/:storeId/channels/onboarding — this store's sessions. */
export async function listChannelOnboardingHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await listChannelOnboarding(storeId(req)));
  } catch (err) {
    log.general.error({ err }, 'Failed to list channel onboarding sessions');
    respondWithError(res, err, 'Failed to load the connection wizard');
  }
}

/** GET /admin/stores/:storeId/channels/onboarding/:sessionId — one session. */
export async function getChannelOnboardingHandler(req: Request, res: Response): Promise<void> {
  try {
    sendSuccess(res, await getChannelOnboarding(storeId(req), routeParam(req, 'sessionId')));
  } catch (err) {
    log.general.error({ err }, 'Failed to read a channel onboarding session');
    respondWithError(res, err, 'Failed to load the connection wizard');
  }
}

/** PATCH /admin/stores/:storeId/channels/onboarding/:sessionId — advance a step. */
export async function advanceChannelOnboardingHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as Omit<
      Parameters<typeof advanceChannelOnboarding>[0],
      'storeId' | 'sessionId' | 'actorOxyUserId'
    >;
    sendSuccess(
      res,
      await advanceChannelOnboarding({
        storeId: storeId(req),
        sessionId: routeParam(req, 'sessionId'),
        actorOxyUserId: getRequiredOxyUserId(req),
        ...body,
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to advance a channel onboarding session');
    respondWithError(res, err, 'Failed to save the connection wizard');
  }
}

/** POST /admin/stores/:storeId/channels/onboarding/:sessionId/activate. */
export async function activateChannelOnboardingHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await activateChannelOnboarding({
        storeId: storeId(req),
        sessionId: routeParam(req, 'sessionId'),
        actorOxyUserId: getRequiredOxyUserId(req),
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to activate a channel onboarding session');
    respondWithError(res, err, 'Failed to activate the channel');
  }
}

/** DELETE /admin/stores/:storeId/channels/onboarding/:sessionId — abandon it. */
export async function abandonChannelOnboardingHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await abandonChannelOnboarding({
        storeId: storeId(req),
        sessionId: routeParam(req, 'sessionId'),
        actorOxyUserId: getRequiredOxyUserId(req),
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to abandon a channel onboarding session');
    respondWithError(res, err, 'Failed to abandon the connection wizard');
  }
}
