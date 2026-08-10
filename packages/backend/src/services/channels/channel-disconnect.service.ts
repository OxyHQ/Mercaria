/**
 * Disconnecting a channel, with an explicit policy for what it produced
 * (#87 management 7, acceptance 4).
 *
 * ## Why the policy is a parameter and not a default
 *
 * The three answers are all defensible and only the merchant knows which they
 * mean. Somebody moving from Shopify to editing in Mercaria wants their listings
 * KEPT and still sellable; somebody who connected the wrong shop wants them
 * gone; somebody pausing for a season wants them off sale but recoverable.
 * Picking one silently is how a merchant loses a catalogue by pressing
 * "disconnect", and picking the safest one silently is how another finds a
 * hundred products still on sale from a shop they no longer own.
 *
 * ## Source-scoped is a property of the QUERY, not a rule
 *
 * Every policy applies through `findListingsBySourceConnection(storeId,
 * connectionId)`, which reads `listings.source_connection_id`. A listing another
 * channel imported carries another connection's id and a listing the merchant
 * typed in carries none, so neither is in the set — #87 acceptance 4
 * ("disconnect behavior is explicit and source-scoped") holds because there is
 * no query here that could reach them, rather than because a filter remembered
 * to exclude them.
 *
 * ## Nothing here deletes an external offer, and the count says so
 *
 * Reconcile requirement 3 preserves source records, clicks and price history,
 * and #84 acceptance 3 keeps external offers historically intact. So the result
 * REPORTS how many external offers were left standing rather than acting on
 * them: the number exists to show a merchant that disconnecting did not destroy
 * the price history their comparison listing is built on. There is deliberately
 * no fourth policy that would.
 */

import type { ChannelDisconnectPolicy, ChannelDisconnectResult } from '@mercaria/shared-types';
import {
  findListingsBySourceConnection,
  setListingStatusIfIn,
} from '../../db/catalog/listingRepository.js';
import { log } from '../../lib/logger.js';
import { disconnect } from '../connector-sync.service.js';
import { syncListingFacets } from '../catalog-write.service.js';
import { countPreservedExternalOffers } from './channel-reconciliation.service.js';

/**
 * The statuses a policy may move a listing OUT of.
 *
 * `restricted` is absent, and that is the load-bearing omission: it is what a
 * CrowdSource jury writes, and `catalog-write.service` already refuses to move a
 * listing out of it so a seller cannot undo an enforcement by editing. A
 * disconnect must not become the way around that — a merchant whose counterfeit
 * listing was restricted could otherwise disconnect the channel, get it
 * archived, reconnect, and have it re-imported as `active`.
 *
 * `sold` is absent too: a sold listing is a historical fact about a transaction,
 * and unpublishing or archiving it would rewrite what a buyer's order points at.
 */
const POLICY_MOVABLE_STATUSES = ['draft', 'active'] as const;

/**
 * Disconnect a connection and apply the merchant's policy to what it imported.
 *
 * ORDER is load-bearing. The connection is disconnected FIRST, so the platform's
 * webhooks are deleted and its credentials are cleared before any listing moves:
 * the reverse order leaves a window in which a webhook arriving mid-policy
 * re-activates a listing the merchant just asked to be archived, and that
 * window is exactly as long as the policy takes over a large catalogue.
 *
 * The policy is then best-effort PER LISTING. A single listing that refuses to
 * move — because a jury restricted it, because it sold — must not abort the
 * whole disconnect and leave the merchant with a half-applied policy and a
 * connection whose state depends on how far the loop got.
 */
export async function disconnectChannel(
  storeId: string,
  connectionId: string,
  policy: ChannelDisconnectPolicy,
): Promise<ChannelDisconnectResult> {
  await disconnect(storeId, connectionId, policy);

  const sourced = await findListingsBySourceConnection(storeId, connectionId);
  let listingsAffected = 0;

  if (policy !== 'keep_listings') {
    const next = policy === 'archive_listings' ? 'archived' : 'draft';
    for (const listing of sourced) {
      const moved = await setListingStatusIfIn(listing.id, next, POLICY_MOVABLE_STATUSES);
      if (!moved) continue;
      listingsAffected += 1;
      // The offer converger is what stops a native offer going on claiming the
      // listing is for sale. `syncListingFacets` is the existing chokepoint
      // #57 named, so this is the same path a seller's own edit takes rather
      // than a second way to converge.
      try {
        await syncListingFacets(listing.id);
      } catch (err) {
        log.general.warn(
          { err, listingId: listing.id, connectionId },
          '[Channels] failed to converge offers after applying a disconnect policy',
        );
      }
    }
  }

  // Counted rather than acted on, and AFTER the policy ran, so the number is
  // what the merchant will see if they look. A failure to count is not a failure
  // to disconnect — the disconnect has already committed and this figure is
  // informational, so it degrades to zero with a log line rather than turning a
  // completed disconnect into an error somebody would retry.
  let externalOffersPreserved = 0;
  try {
    externalOffersPreserved = await countPreservedExternalOffers(storeId);
  } catch (err) {
    log.general.warn({ err, storeId }, '[Channels] failed to count preserved external offers');
  }

  return { connectionId, policy, listingsAffected, externalOffersPreserved };
}
