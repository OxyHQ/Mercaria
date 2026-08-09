/**
 * Every outbound call to Awin, and the fleet-wide budget all of them spend
 * (#66 §4).
 *
 * ONE chokepoint, and that is what makes the budget real: a second module that
 * fetched `productdata.awin.com` directly would be a second answer to "how hard
 * may Mercaria knock on Awin", and the loser would be whichever one the
 * dispatcher happens not to go through. `awin-isolation.test.ts` pins the caller
 * list.
 *
 * ## The transport is #63's, not a second one
 *
 * `openFeedStream` gives HTTPS-only, `safeFetch` with a real DNS resolution and
 * a connection PINNED to the validated address (so the DNS-rebind window a
 * check-then-connect leaves open is closed), conditional requests with a
 * `not_modified` branch that carries no bytes, and every failure already
 * classified as a `FeedImportRefusal` from a closed set. Re-implementing any of
 * that would be a second, weaker answer to "is this address safe", which is the
 * hazard rather than the safeguard.
 *
 * ## The URL is a credential and is never returned to a caller
 *
 * Awin puts the product-data key in the PATH. The URL is composed inside these
 * functions from the resolved locator, used once, and never returned, stored,
 * projected or logged; `redactFeedUrl`'s host-only form is what reaches any of
 * those. That is #63's rule, inherited rather than re-decided.
 */

import { config } from '../../config/index.js';
import {
  claimAwinNetworkLease,
  releaseAwinNetworkLease,
  type AwinNetworkBudget,
} from '../../db/awin/awinNetworkLeaseRepository.js';
import { FeedImportRefusal } from '../feed-import/errors.js';
import { openFeedStream, type FeedFetchOutcome, type FeedValidators } from '../feed-import/fetch.js';
import { boundedBytes, type FeedByteMeter } from '../feed-import/bytes.js';
import {
  AWIN_FEED_LIST_MAX_BYTES,
  awinFeedDownloadUrl,
  awinFeedListUrl,
} from './constants.js';
import { readAwinFeedList, type AwinFeedListResult } from './feed-list.js';
import { resolveAwinCredential } from './credential.js';
import type { AwinFeedColumn } from '@mercaria/shared-types';

/**
 * Run one call against Awin's own per-minute allowance.
 *
 * The lease is held across the WHOLE call, download included, because the
 * network's limit counts requests in flight and a lease released at the response
 * headers would let N tasks stream N feeds concurrently under a concurrency
 * bound of two.
 *
 * A refusal is a {@link FeedImportRefusal} with reason `upstream_status`, which
 * `feedRefusalFetchKind` maps to #62's RETRYABLE `source_outage`. Deliberately
 * not `rate_limit`: nothing in this refusal came from Awin. Mercaria declined to
 * make the call, and reporting the provider's word for a decision Mercaria made
 * would send somebody to check a service that is answering perfectly well —
 * `classifyRunOutcome`'s reasoning, one layer down.
 */
export async function withAwinNetworkLease<T>(
  input: { budget: AwinNetworkBudget; leaseOwner: string },
  work: () => Promise<T>,
): Promise<T> {
  const claim = await claimAwinNetworkLease({
    budget: input.budget,
    leaseOwner: input.leaseOwner,
    leaseMs: config.awin.networkLeaseMs,
  });
  if (claim.outcome === 'refused') {
    throw new FeedImportRefusal(
      'upstream_status',
      claim.reason === 'rate_limited'
        ? 'Mercaria has spent this publisher account’s per-minute allowance for Awin; the call ' +
          'was not made. The pass retries from where it stopped.'
        : 'Every concurrency slot for this publisher account is busy; the call was not made.',
      { retryable: true },
    );
  }

  try {
    return await work();
  } finally {
    await releaseAwinNetworkLease({ leaseId: claim.leaseId, leaseOwner: input.leaseOwner });
  }
}

/**
 * Read one publisher's feed list.
 *
 * Bounded independently of a product feed's caps: the list is one row per feed
 * for one publisher, so thirty-two megabytes of it is not a large network, it is
 * a malformed response — and refusing it early keeps a discovery pass from
 * becoming a memory incident.
 *
 * A 304 on the LIST is treated as a refusal rather than as "nothing changed",
 * and the reason is the same one #63 gives for a feed: this call has no
 * validators to present (Mercaria stores none for the list), so a 304 here means
 * the host answered a question nobody asked and the response carries no
 * inventory. Reading it as an empty list would close every advertiser.
 */
export async function fetchAwinFeedList(input: {
  budget: AwinNetworkBudget;
  leaseOwner: string;
  feedCredentialRef: string | null;
  signal?: AbortSignal;
}): Promise<AwinFeedListResult> {
  const credential = resolveAwinCredential(input.feedCredentialRef);
  if (credential.kind === 'unavailable') {
    throw new FeedImportRefusal(
      'unauthorized',
      `The publisher account's product-data key is unavailable (${credential.reason}: ${credential.detail}).`,
    );
  }

  return withAwinNetworkLease(input, async () => {
    const outcome = await openFeedStream({
      url: awinFeedListUrl(config.awin.feedListBaseUrl, credential.secret),
      // The key is IN the path — there is nothing to put in a header, and
      // `none` says that rather than leaving a reader wondering which of two
      // mechanisms carries it.
      authorization: { kind: 'none', secret: null, paramName: null },
      validators: { etag: null, lastModified: null },
      timeoutMs: config.awin.listTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (outcome.kind === 'not_modified') {
      throw new FeedImportRefusal(
        'upstream_status',
        'Awin answered 304 to an unconditional feed-list request. The response carries no ' +
          'inventory, and reading it as an empty list would close every advertiser.',
        { retryable: true },
      );
    }

    try {
      const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };
      return await readAwinFeedList(
        boundedBytes(outcome.bytes, AWIN_FEED_LIST_MAX_BYTES, meter),
      );
    } finally {
      // Every branch, including a refusal mid-stream: a socket left open holds a
      // connection to Awin until the process exits.
      outcome.close();
    }
  });
}

/**
 * Open one advertiser's feed.
 *
 * Returns #63's own outcome, `not_modified` branch included, so the adapter's
 * 304 handling is the one #63 already wrote and tests — and a conditional
 * response can never be mistaken for a completed enumeration of zero records.
 *
 * The lease is NOT released here, because the caller has not finished reading:
 * it is held by {@link withAwinNetworkLease} around the whole staging pass. The
 * caller is `resolve.ts`, and this function is deliberately not exported for
 * general use.
 */
export async function openAwinFeed(input: {
  feedCredentialRef: string | null;
  feedId: string;
  columns: readonly AwinFeedColumn[];
  validators: FeedValidators;
  signal?: AbortSignal;
}): Promise<FeedFetchOutcome> {
  const credential = resolveAwinCredential(input.feedCredentialRef);
  if (credential.kind === 'unavailable') {
    throw new FeedImportRefusal(
      'unauthorized',
      `The publisher account's product-data key is unavailable (${credential.reason}: ${credential.detail}).`,
    );
  }

  return openFeedStream({
    url: awinFeedDownloadUrl({
      baseUrl: config.awin.feedListBaseUrl,
      feedApiKey: credential.secret,
      feedId: input.feedId,
      columns: input.columns,
    }),
    authorization: { kind: 'none', secret: null, paramName: null },
    validators: input.validators,
    timeoutMs: config.feedImport.fetchTimeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
