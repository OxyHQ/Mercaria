/**
 * One authoritative channel-readiness result (#87 acceptance 7).
 *
 * ## What it replaces
 *
 * Before #87 every surface answered "can this merchant sell yet" for itself, out
 * of whatever it happened to have: the dashboard from a hard-coded `available`
 * flag per connector, the activation work (#85) from provider-specific client
 * state, and nothing from the product feed at all. Acceptance 7 asks for one
 * result those consumers read instead.
 *
 * ## It is DERIVED and never stored, and that is the #57 divergence
 *
 * The house rule is one stored verdict per fact — `provider_accounts`'
 * `onboarding_state` is the model, and it is stored because its inputs sit on
 * the row being verdicted. Readiness has no such row: its inputs are
 * `connections`, `sync_runs`, `feed_configurations`, `listings` and
 * `provider_accounts` — five tables in four domains, none of which this one
 * owns. A stored verdict would be a sixth representation, and it would go stale
 * at exactly the moment that matters, which is the instant Stripe restricts a
 * seller's account. So this is `deriveNativeCheckoutEligibility`'s divergence
 * (#57), taken for the same reason and stated in the same place.
 *
 * ## THREE axes, because #87 UX 5 and 6 ask for exactly that
 *
 * "Distinguish a connected catalog from payment readiness" and "distinguish a
 * healthy sync from native-checkout activation" are the same instruction twice.
 * Collapsing them into one boolean is what leaves a merchant with a perfect
 * Shopify sync wondering why nothing can be bought — the answer is Stripe, and a
 * single verdict cannot say so.
 *
 * ## It reads payment readiness and NEVER re-derives it
 *
 * `isSellerPaymentReady` is #46's stored verdict, and this module calls it. A
 * second reading of `charges_enabled` or a requirements count here would be the
 * two-representations failure that rule exists to prevent, in the one place it
 * must not happen: a gate telling a merchant they can sell.
 */

import { and, count, eq } from 'drizzle-orm';
import type {
  ChannelHealthState,
  ChannelReadiness,
  ChannelReadinessBlocker,
  ChannelTypeId,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  findConnectionsByStore,
  findConnectionWebhookFailures,
} from '../../db/connectors/connectionRepository.js';
import { findLatestSyncRunPerConnection } from '../../db/connectors/syncRunRepository.js';
import { listFeedConfigurationsForStore } from '../../db/feedImport/feedConfigurationRepository.js';
import { listings } from '../../db/schema/catalog.js';
import { isSellerPaymentReady } from '../payments/provider-account.service.js';
import { channelTypeForConnection, describeChannel } from './channel-catalog.js';

/**
 * Derive one store's readiness.
 *
 * Every read is live. Nothing is cached, because the cost of a stale answer is
 * asymmetric: a merchant told they cannot sell when they can loses a few minutes
 * and refreshes; a merchant told they CAN sell when they cannot takes orders
 * whose money has nowhere to go.
 */
export async function deriveChannelReadiness(storeId: string): Promise<ChannelReadiness> {
  const connections = await findConnectionsByStore(storeId);

  // A channel is supplying a catalogue when it is connected AND its fetch is not
  // paused. A paused-for-fetch connection is deliberately excluded: it is
  // working and the merchant has asked it to stop, so counting it as a live
  // catalogue source would make the pause invisible in the one place a merchant
  // looks to find out why nothing is updating.
  const live = connections.filter(
    (connection) => connection.status === 'connected' && connection.fetchPausedAt === null,
  );

  const feeds = config.feedImport.enabled ? await listFeedConfigurationsForStore(getDb(), storeId) : [];

  const connectedChannelTypes: ChannelTypeId[] = [
    ...live.map((connection) => channelTypeForConnection(connection)),
    ...(feeds.length > 0 ? (['product_feed'] as const) : []),
  ];

  const latestRuns = await findLatestSyncRunPerConnection(live.map((connection) => connection.id));
  const successes = [...latestRuns.values()].filter((run) => run.status === 'completed');
  const anyRunFailed = [...latestRuns.values()].some((run) => run.status === 'failed');
  // #218: a live connection whose last registration could not subscribe a topic
  // is a catalogue that stops tracking the platform between scheduled syncs,
  // with every run reporting `completed`. That is precisely the state a run
  // status cannot express and a merchant discovers as "my prices are stale", so
  // it degrades the axis rather than being visible only on the channel's own
  // screen. The refused TOPICS are on the connection DTO; this is the alarm.
  const webhookFailures = await findConnectionWebhookFailures(
    live.map((connection) => connection.id),
  );
  const anyWebhookRefused = [...webhookFailures.values()].some((topics) => topics.length > 0);
  const lastSuccessfulSyncAt = successes
    .map((run) => run.finishedAt ?? run.startedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const nativeCheckoutCapable = connectedChannelTypes.filter(
    (channelType) => describeChannel(channelType).supportsNativeCheckout,
  );

  const publishableListings = await countPublishableListings(storeId);

  // The native catalogue is always available and always supports checkout, so a
  // store with listings and no connector is legitimately ready. It is added to
  // the connected list only when it is actually supplying something — a store
  // with nothing in it has not "connected" the native catalogue in any sense a
  // merchant would recognise.
  if (publishableListings > 0 && !connectedChannelTypes.includes('native')) {
    connectedChannelTypes.push('native');
    nativeCheckoutCapable.push('native');
  }

  const paymentsReady = await isSellerPaymentReady(`store:${storeId}`);
  const railEnabled = config.payments.stripe.enabled;

  const blockers: ChannelReadinessBlocker[] = [];
  if (connectedChannelTypes.length === 0) {
    blockers.push('no_connected_channel');
  } else if (nativeCheckoutCapable.length === 0) {
    // Every connected channel produces external offers only — a product feed
    // and nothing else. The catalogue is real and none of it can be bought here,
    // which is UX requirement 3's case and the one a single boolean hides.
    blockers.push('no_native_checkout_channel');
  }
  if (live.length > 0 && successes.length === 0) {
    blockers.push('no_successful_sync');
  }
  if (publishableListings === 0) {
    blockers.push('no_publishable_listing');
  }
  if (!paymentsReady) {
    blockers.push('payments_not_ready');
  }

  return {
    storeId,
    catalog: {
      state: catalogState(
        connectedChannelTypes.length,
        anyRunFailed || anyWebhookRefused,
        successes.length,
      ),
      connectedChannelTypes,
      nativeCheckoutCapableCount: nativeCheckoutCapable.length,
      lastSuccessfulSyncAt: lastSuccessfulSyncAt?.toISOString(),
    },
    payments: {
      state: paymentsReady ? 'healthy' : 'blocked',
      railEnabled,
    },
    nativeCheckout: {
      state: blockers.length === 0 ? 'healthy' : 'blocked',
      blockers,
    },
  };
}

/**
 * The catalogue axis.
 *
 * `degraded` rather than `blocked` when something did not land but earlier
 * passes succeeded: the products are there, which is a different thing from
 * having no catalogue at all — and a merchant who cannot tell the two apart
 * either panics about a transient failure or ignores a real one.
 */
function catalogState(
  connectedCount: number,
  anythingNotLanding: boolean,
  successCount: number,
): ChannelHealthState {
  if (connectedCount === 0) return 'blocked';
  if (anythingNotLanding || successCount === 0) return 'degraded';
  return 'healthy';
}

/**
 * How many listings this store could actually sell.
 *
 * `active` excludes `restricted`, which is what a CrowdSource takedown writes,
 * and excludes `draft`, `sold` and `archived`. A store whose entire catalogue is
 * restricted has zero here — correct, and the reason `no_publishable_listing`
 * is a separate blocker from `no_connected_channel`: the channel is fine and
 * there is nothing to sell through it.
 */
async function countPublishableListings(storeId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(listings)
    .where(and(eq(listings.storeId, storeId), eq(listings.status, 'active')));
  return row?.total ?? 0;
}
