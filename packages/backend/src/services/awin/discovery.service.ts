/**
 * Discovering advertisers and feeds, and reconciling the ones that went away
 * (#66 feed lifecycle 1 and 8).
 *
 * ## Discovery finds advertisers and REGISTERS none of them
 *
 * A pass over a network with thirty thousand advertisers must not be able to
 * start publishing them. Creating a #62 source would mean creating a merchant
 * and a storefront for a retailer nobody reviewed, and #62's own rule is that a
 * source with no merchant produces no offers — so the honest shape is an
 * advertiser row with no source until an operator binds one. That is also what
 * makes Awin's pre-join preview useful: an advertiser can be discovered, its
 * identifier coverage measured and its deep links sampled before any
 * application is sent.
 *
 * ## Closure is inferred from ABSENCE, which is why an unreadable row is SEEN
 *
 * `readAwinFeedList` returns two kinds of entry and both carry the advertiser
 * and feed ids, because a row Mercaria could not fully parse — a membership word
 * Awin added last week — must not read as an advertiser that left the network.
 * This pass marks both kinds SEEN and applies a membership change only from the
 * understood ones, which is the difference between "we do not recognise this
 * word" and "this programme is over".
 */

import { log } from '../../lib/logger.js';
import type { AwinAccountRow } from '../../db/awin/awinAccountRepository.js';
import {
  recordAwinListPoll,
  recordAwinListPollFailure,
} from '../../db/awin/awinAccountRepository.js';
import {
  changeAwinActivation,
  discoverAwinAdvertiser,
  listAwinAdvertisers,
} from '../../db/awin/awinAdvertiserRepository.js';
import { discoverAwinFeed } from '../../db/awin/awinFeedRepository.js';
import { AWIN_TERMINATED_MEMBERSHIPS } from '@mercaria/shared-types';
import { FeedImportRefusal } from '../feed-import/errors.js';
import { redactFeedMessage } from '../feed-import/redact.js';
import { fetchAwinFeedList } from './network.js';

/** What one discovery pass did. */
export interface AwinDiscoveryResult {
  readonly advertisersSeen: number;
  readonly feedsSeen: number;
  readonly unreadableRows: number;
  readonly advertisersClosed: number;
  readonly digest: string;
}

/**
 * Poll one publisher's feed list and reconcile everything it names.
 *
 * The whole pass runs against ONE `polledAt` instant rather than `new Date()`
 * per write, because closure is decided by comparing `last_seen_in_list_at`
 * against it — and a pass that stamped each row with its own clock would leave
 * the rows written first looking older than the poll that wrote them, which is
 * how a discovery pass closes the advertisers it processed first.
 */
export async function runAwinDiscovery(input: {
  account: AwinAccountRow;
  now?: Date;
}): Promise<AwinDiscoveryResult> {
  const polledAt = input.now ?? new Date();
  const leaseOwner = `awin-discovery-${input.account.id}`;

  let list;
  try {
    list = await fetchAwinFeedList({
      budget: {
        accountId: input.account.id,
        maxConcurrency: input.account.maxConcurrency,
        maxCallsPerMinute: input.account.maxCallsPerMinute,
      },
      leaseOwner,
      feedCredentialRef: input.account.feedCredentialRef,
    });
  } catch (error: unknown) {
    // Recorded and rethrown, never swallowed. `redactFeedMessage` is what
    // reaches the column: an Awin URL carries the product-data key in its PATH,
    // so a raw message here would put a credential in a row an operator surface
    // reads.
    const message =
      error instanceof FeedImportRefusal || error instanceof Error
        ? redactFeedMessage(error.message)
        : 'The feed list could not be read.';
    await recordAwinListPollFailure({ accountId: input.account.id, error: message, now: polledAt });
    throw error;
  }

  const advertisers = new Set<string>();
  let feedsSeen = 0;
  let unreadableRows = 0;

  for (const entry of list.entries) {
    if (entry.kind === 'unreadable') {
      unreadableRows += 1;
      log.general.warn(
        {
          accountId: input.account.id,
          advertiserId: entry.advertiserId,
          feedId: entry.feedId,
          reason: entry.reason,
          observedToken: entry.observedToken,
        },
        '[Awin] a feed-list row was not fully readable; the advertiser is marked SEEN and its ' +
          'membership is left unchanged',
      );
      if (entry.advertiserId === '' || entry.feedId === '') continue;
      // Seen, so the closure reconciliation does not read it as absent — but
      // with no membership to apply, so a word nobody recognises cannot silently
      // become a state.
      const existing = await discoverAwinAdvertiserSeenOnly({
        accountId: input.account.id,
        advertiserId: entry.advertiserId,
        advertiserName: entry.advertiserName,
        now: polledAt,
      });
      if (existing !== null) {
        advertisers.add(entry.advertiserId);
        await discoverAwinFeed({
          advertiserRowId: existing,
          feedId: entry.feedId,
          feedName: `Feed ${entry.feedId}`,
          now: polledAt,
        });
        feedsSeen += 1;
      }
      continue;
    }

    const listing = entry.listing;
    const advertiser = await discoverAwinAdvertiser({
      accountId: input.account.id,
      advertiserId: listing.advertiserId,
      displayName: listing.advertiserName,
      membershipStatus: listing.membershipStatus,
      primaryRegion: listing.primaryRegion,
      vertical: listing.vertical,
      now: polledAt,
    });
    advertisers.add(listing.advertiserId);

    await discoverAwinFeed({
      advertiserRowId: advertiser.id,
      feedId: listing.feedId,
      feedName: listing.feedName,
      language: listing.language,
      currency: listing.currency,
      productCount: listing.productCount,
      listedLastImportedAt: listing.lastImported === null ? null : new Date(listing.lastImported),
      now: polledAt,
    });
    feedsSeen += 1;
  }

  await recordAwinListPoll({
    accountId: input.account.id,
    digest: list.digest,
    feedCount: list.entries.length,
    now: polledAt,
  });

  const advertisersClosed = await closeDepartedAdvertisers({
    accountId: input.account.id,
    polledAt,
  });

  return {
    advertisersSeen: advertisers.size,
    feedsSeen,
    unreadableRows,
    advertisersClosed,
    digest: list.digest,
  };
}

/**
 * Mark an advertiser SEEN without touching its membership.
 *
 * The `unreadable` path. It reuses `discoverAwinAdvertiser` for an advertiser
 * that already exists and creates NOTHING for one that does not: a row whose
 * membership word Mercaria cannot read is not an advertiser anybody should be
 * offered, and creating it with a fabricated `not_joined` would put a state Awin
 * never reported into a column whose whole contract is "what Awin says".
 *
 * @returns the advertiser row id, or `null` when there was none to mark.
 */
async function discoverAwinAdvertiserSeenOnly(input: {
  accountId: string;
  advertiserId: string;
  advertiserName: string;
  now: Date;
}): Promise<string | null> {
  const existing = (await listAwinAdvertisers({ accountId: input.accountId })).find(
    (row) => row.advertiserId === input.advertiserId,
  );
  if (existing === undefined) return null;
  await discoverAwinAdvertiser({
    accountId: input.accountId,
    advertiserId: input.advertiserId,
    displayName: existing.displayName,
    // Its OWN current membership, re-applied. `membership_changed_at` moves only
    // when the value actually moves, so this is a genuine no-op on that column.
    membershipStatus: existing.membershipStatus,
    primaryRegion: existing.primaryRegion,
    vertical: existing.vertical,
    declaredHost: existing.declaredHost,
    now: input.now,
  });
  return existing.id;
}

/**
 * Close advertisers this poll did not name, and those Awin says are over.
 *
 * Two conditions, one action, and they are genuinely the same fact: an
 * advertiser the list stopped mentioning has left the publisher's visible set,
 * and one whose membership is `declined`, `suspended` or `left` has said so
 * explicitly. Both revoke Mercaria's right to display the feed (#64 §6, Awin
 * rule 1) and neither deletes anything — the observations, runs, quality
 * snapshots and every published rights version survive.
 *
 * `candidate` advertisers are deliberately left alone. They publish nothing, so
 * closing them buys no safety and would churn a status column every time Awin
 * rotated which pre-join previews it exposes.
 */
async function closeDepartedAdvertisers(input: {
  accountId: string;
  polledAt: Date;
}): Promise<number> {
  const advertisers = await listAwinAdvertisers({ accountId: input.accountId });
  let closed = 0;

  for (const advertiser of advertisers) {
    if (advertiser.activation === 'closed' || advertiser.activation === 'candidate') continue;

    const absent =
      advertiser.lastSeenInListAt === null ||
      advertiser.lastSeenInListAt.getTime() < input.polledAt.getTime();
    const terminated = AWIN_TERMINATED_MEMBERSHIPS.includes(advertiser.membershipStatus);
    if (!absent && !terminated) continue;

    await changeAwinActivation({
      advertiserRowId: advertiser.id,
      activation: 'closed',
      // The discovery LOOP, not a person. Attributing it to an operator would be
      // a false audit trail — `catalog_source_runs_requested_by_check`'s rule.
      actorOxyUserId: AWIN_DISCOVERY_ACTOR,
      note: absent
        ? 'Awin’s feed list stopped naming this advertiser.'
        : `Awin reports the programme as ${advertiser.membershipStatus}.`,
      now: input.polledAt,
    });
    closed += 1;
  }

  return closed;
}

/**
 * The actor a discovery-driven closure is attributed to.
 *
 * A literal rather than an Oxy id, because no Oxy account asked for it. It is
 * recognisable in an audit and cannot collide with an account id, which is a
 * UUIDv7. #63's `system:feed-import` established the shape.
 */
export const AWIN_DISCOVERY_ACTOR = 'system:awin-discovery';
