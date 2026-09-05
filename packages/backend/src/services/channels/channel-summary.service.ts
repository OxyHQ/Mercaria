/**
 * One store's channels, in ONE shape (#87 management 1, UX 1).
 *
 * ## Why the three kinds share a projection
 *
 * A connector connection, a feed configuration and the native catalogue are
 * three different rows in three different domains, and rendering them from three
 * DTOs is precisely what produced three screens with three vocabularies — the
 * thing #87 exists to unify. What a merchant asks of each is the same question:
 * is it on, when did it last run, how much did it move, and can I sell through
 * it. So the answer is one type, composed here, and every screen reads it.
 *
 * ## `nextScheduledSyncAt` is ABSENT rather than guessed
 *
 * A push channel has no schedule: the platform calls when it has something.
 * Rendering a time there would be an invented promise, and a merchant who reads
 * one and does not see an update at that minute concludes the channel is broken.
 * The unknown-is-never-zero rule, applied to a clock.
 */

import type {
  ChannelConnectionState,
  ChannelPauseScope,
  ChannelSummary,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findConnectionsByStore, type ConnectionRow } from '../../db/connectors/connectionRepository.js';
import { findLatestSyncRunPerConnection } from '../../db/connectors/syncRunRepository.js';
import { listFeedConfigurationsForOwner } from '../../db/feedImport/feedConfigurationRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { CONNECTOR_RECONCILE_INTERVAL_MS } from '../../queue/constants.js';
import { isQueueEnabled } from '../../queue/connection.js';
import { channelTypeForConnection, describeChannel } from './channel-catalog.js';

/**
 * Every channel this store has, connectors and feeds and the native catalogue.
 *
 * The native row is ALWAYS present, even for a store with no products. That is
 * deliberate: a merchant with no connectors whose channel list is empty
 * concludes Mercaria cannot sell anything for them, when in fact the channel
 * they are already using is the one the list omitted.
 */
export async function listStoreChannels(storeId: string): Promise<ChannelSummary[]> {
  const connections = await findConnectionsByStore(storeId);
  const latestRuns = await findLatestSyncRunPerConnection(
    connections.map((connection) => connection.id),
  );

  const summaries: ChannelSummary[] = connections.map((connection) => {
    const channelType = channelTypeForConnection(connection);
    const run = latestRuns.get(connection.id);
    return {
      id: connection.id,
      channelType,
      state: connectionState(connection, run?.status),
      label: connection.shopDomain ?? describeChannel(channelType).name,
      pausedScopes: pausedScopes(connection),
      lastSyncAt: connection.lastSyncAt?.toISOString(),
      lastRunStatus: run?.status,
      lastRunCounts: run
        ? {
            created: run.countsCreated,
            updated: run.countsUpdated,
            skipped: run.countsSkipped,
            failed: run.countsFailed,
          }
        : undefined,
      // Only a PULL connection has a schedule at all — `reconcileAllConnections`
      // sweeps those and nothing else. A `push_in` connection is called by the
      // platform, so there is no next time to name.
      nextScheduledSyncAt:
        connection.mode === 'pull' && connection.status === 'connected'
          ? nextReconcileAt(connection.lastSyncAt)
          : undefined,
      supportsNativeCheckout: describeChannel(channelType).supportsNativeCheckout,
    };
  });

  if (config.feedImport.enabled) {
    for (const feed of await listFeedConfigurationsForOwner(getDb(), storeId)) {
      summaries.push({
        id: feed.id,
        channelType: 'product_feed',
        // A feed's health lives in its own #62 run history, which the feed
        // surface already serves in full. Reporting `healthy` here off a
        // configuration row would be a claim about a run nobody read — so the
        // list shows it as connected and links to the detail that can answer.
        state: 'healthy',
        label: feed.label,
        pausedScopes: [],
        lastSyncAt: feed.lastFetchedAt?.toISOString(),
        supportsNativeCheckout: false,
      });
    }
  }

  const store = await findStoreById(storeId);
  summaries.push({
    id: 'native',
    channelType: 'native',
    state: 'healthy',
    label: store?.name ?? 'Mercaria catalog',
    pausedScopes: [],
    supportsNativeCheckout: true,
    lastRunCounts: undefined,
    // The native catalogue's "how much did it move" is how many offers it is
    // currently materializing, which is the only counter that means anything for
    // a channel with no runs.
    lastSyncAt: undefined,
    nextScheduledSyncAt: undefined,
  });

  return summaries;
}

/**
 * What a connection is doing, in the merchant's vocabulary.
 *
 * PAUSED wins over a failed run, deliberately: a merchant who paused fetch
 * yesterday and whose last run failed the day before needs to be told it is
 * paused, because that is the fact they can act on. Reporting `attention` there
 * sends them looking for a fault they already stopped.
 */
function connectionState(
  connection: ConnectionRow,
  lastRunStatus: 'running' | 'completed' | 'failed' | undefined,
): ChannelConnectionState {
  if (connection.status === 'disconnected') return 'not_connected';
  if (connection.status === 'error') return 'error';
  if (connection.fetchPausedAt !== null || connection.publicationPausedAt !== null) return 'paused';
  if (lastRunStatus === 'failed') return 'attention';
  return 'healthy';
}

/** Which scopes are paused, as a list rather than two booleans on the wire. */
function pausedScopes(connection: ConnectionRow): ChannelPauseScope[] {
  const scopes: ChannelPauseScope[] = [];
  if (connection.fetchPausedAt !== null) scopes.push('fetch');
  if (connection.publicationPausedAt !== null) scopes.push('publication');
  return scopes;
}

/**
 * When the reconcile sweep will next reach a pull connection.
 *
 * Read from `CONNECTOR_RECONCILE_INTERVAL_MS` — the SAME constant
 * `registerSchedules` gives BullMQ — so the promise on the screen moves when the
 * schedule does rather than being a second number somebody has to remember. It
 * is absent in two cases and both are honest: a connection that has never synced
 * (the first sweep after connecting is not predictable from a `NULL`, and "soon"
 * is not a time), and a deployment with no Redis, where the scheduler does not
 * exist at all and nothing is coming.
 */
function nextReconcileAt(lastSyncAt: Date | null): string | undefined {
  if (lastSyncAt === null || !isQueueEnabled()) return undefined;
  return new Date(lastSyncAt.getTime() + CONNECTOR_RECONCILE_INTERVAL_MS).toISOString();
}
