/**
 * Turning one #62 run into everything the Awin adapter needs (#66).
 *
 * This is the module that HOLDS the database handles, deliberately: it sits
 * outside `services/ingestion/adapters/`, so the adapter itself keeps the
 * property `ingestion-isolation.test.ts` scans that directory for — no
 * repository, no drizzle, no `db/postgres.js`. #63's `register.ts` established
 * the arrangement and the reasoning is unchanged: the wall exists to stop a
 * provider module writing into the COMMERCE GRAPH, and reading an advertiser's
 * feed row and writing a quality snapshot are neither.
 */

import { config } from '../../config/index.js';
import { findIngestionSource } from '../../db/ingestion/catalogSourceConfigRepository.js';
import { findActiveSourcePolicy } from '../../db/ingestion/catalogSourcePolicyRepository.js';
import {
  findAwinAdvertiser,
  type AwinAdvertiserRow,
} from '../../db/awin/awinAdvertiserRepository.js';
import { findAwinAccount, type AwinAccountRow } from '../../db/awin/awinAccountRepository.js';
import {
  clearAwinFeedValidators,
  findPrimaryAwinFeed,
  recordAwinFeedImport,
  recordAwinFeedValidators,
  type AwinFeedRow,
} from '../../db/awin/awinFeedRepository.js';
import { recordAwinQuality } from '../../db/awin/awinQualityRepository.js';
import { getDb } from '../../db/postgres.js';
import { FeedImportRefusal } from '../feed-import/errors.js';
import type { FeedValidators } from '../feed-import/fetch.js';
import type { ResolvedFeedMapping } from '../feed-import/mapping.js';
import { resolveSourceRights } from '../ingestion/rights.js';
import { toPolicyRights } from '../ingestion/source.service.js';
import type { AwinNetworkBudget } from '../../db/awin/awinNetworkLeaseRepository.js';
import { AWIN_FEED_COLUMNS, AWIN_MAPPING_VERSION } from '@mercaria/shared-types';
import type {
  AwinDestinationSwapExample,
  AwinFeedColumn,
  AwinQualityCounts,
  CatalogSourceRightsVerdict,
} from '@mercaria/shared-types';
import { awinParseOptions } from './constants.js';
import { buildAwinMapping } from './mapping.js';
import type { FeedParseOptions } from '../feed-import/parse/types.js';

/** Everything one pass over one advertiser's feed needs. */
export interface ResolvedAwinFeed {
  readonly advertiser: AwinAdvertiserRow;
  readonly account: AwinAccountRow;
  readonly feed: AwinFeedRow;
  readonly rights: CatalogSourceRightsVerdict;
  readonly budget: AwinNetworkBudget;
  readonly validators: FeedValidators;
  /** The columns Mercaria REQUESTS. What arrives decides the mapping. */
  readonly requestedColumns: readonly AwinFeedColumn[];
  readonly parseOptions: FeedParseOptions;
  readonly mappingVersion: number;
}

/**
 * Resolve one run's advertiser, or refuse the pass and say why.
 *
 * `sourceAccountRef` carries the ADVERTISER ROW ID, bound when an operator
 * registers the source — the #63 arrangement, where a feed source binds its
 * configuration id. An absent one and an unresolvable one are the SAME fact
 * (this run has no advertiser) and get ONE refusal, because splitting them
 * would put the distinction in a message nobody can act on differently.
 *
 * Every refusal below is a whole-FEED refusal rather than a per-record one, and
 * each is a state an operator can see and fix rather than a silent degradation:
 * a paused account, a closed advertiser, a feed the list has never mentioned, a
 * feed that stopped declaring the columns its ids are derived from.
 */
export async function resolveAwinFeed(sourceAccountRef: string | null): Promise<ResolvedAwinFeed> {
  const db = getDb();

  const advertiser =
    sourceAccountRef === null ? null : await findAwinAdvertiser(sourceAccountRef, db);
  if (advertiser === null) {
    throw new FeedImportRefusal(
      'configuration_missing',
      'This source names no Awin advertiser. A source is bound to one advertiser when it is ' +
        'registered, and a pass with no binding has no feed to read.',
    );
  }
  if (advertiser.catalogSourceId === null) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'This Awin advertiser has no bound catalogue source. Discovery finds advertisers and ' +
        'registers none of them; binding is an operator act.',
    );
  }

  const account = await findAwinAccount(advertiser.accountId, db);
  if (account === null) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'This advertiser’s publisher account is missing.',
    );
  }
  if (account.state !== 'active') {
    // NOT retryable and NOT an auth failure: a deauthorized or paused account is
    // a decision (Mercaria's or Awin's) rather than a transport fault, and
    // retrying it burns the network's allowance answering the same question.
    // #62 keeps display and retires nothing on this outcome, which is the whole
    // point of separating an account's state from an advertiser's health.
    throw new FeedImportRefusal(
      'configuration_incomplete',
      `The publisher account is ${account.state}; no Awin call is made while it is.`,
    );
  }

  const feed = await findPrimaryAwinFeed(advertiser.id, db);
  if (feed === null) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'Awin’s feed list has never named a feed for this advertiser. Run a discovery pass first.',
    );
  }

  const source = await findIngestionSource(db, advertiser.catalogSourceId);
  if (source === undefined) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'The bound catalogue source has no configuration row.',
    );
  }
  const policy = await findActiveSourcePolicy(db, advertiser.catalogSourceId);
  const rights = resolveSourceRights(
    source.config.status,
    policy === undefined ? null : toPolicyRights(policy),
  );

  return {
    advertiser,
    account,
    feed,
    rights,
    budget: {
      accountId: account.id,
      maxConcurrency: account.maxConcurrency,
      maxCallsPerMinute: account.maxCallsPerMinute,
    },
    // A mapping-version bump FORGETS the validators, so the re-read it
    // schedules actually happens: a 304 answers "your copy of the BYTES is
    // current", which stays true across a mapping change and would otherwise
    // defer the re-read until the advertiser next republished — for a stable
    // catalogue, never.
    validators:
      feed.mappingVersion === AWIN_MAPPING_VERSION
        ? { etag: feed.httpEtag, lastModified: feed.httpLastModified }
        : { etag: null, lastModified: null },
    requestedColumns: AWIN_FEED_COLUMNS,
    parseOptions: awinParseOptions({
      maxRecordBytes: config.feedImport.maxRecordBytes,
      maxRecords: config.feedImport.maxRecords,
    }),
    mappingVersion: AWIN_MAPPING_VERSION,
  };
}

/**
 * The mapping for one pass.
 *
 * Built over the columns Mercaria REQUESTS rather than over the ones a
 * particular header row turned out to carry, and it has to be that way round:
 * the mapping is needed before the first record is read, and reading a record
 * to discover the header is circular. #63's engine treats a mapped column that
 * is absent from a row exactly as it treats an empty one, so an advertiser who
 * mapped fewer columns loses those FIELDS and nothing else. What varies per
 * advertiser is MEASURED and stored (`awin_advertiser_quality`), never
 * configured.
 */
export function awinMappingFor(resolved: ResolvedAwinFeed): ResolvedFeedMapping {
  return buildAwinMapping({
    declared: resolved.requestedColumns,
    defaultCurrency: resolved.feed.currency,
    // The advertiser's PRIMARY REGION, not a Mercaria default. An advertiser
    // whose listing declares neither leaves both absent, because #62's
    // normalizer keeps an unknown fact ABSENT rather than zero.
    defaultCountry: resolved.advertiser.primaryRegion,
    defaultLanguage: resolved.feed.language,
  });
}

/** What one completed staging pass recorded about the feed and its data. */
export interface AwinImportOutcome {
  readonly digest: string;
  readonly declaredColumns: readonly AwinFeedColumn[];
  readonly consumedLastImportedAt: Date | null;
  readonly validators: FeedValidators;
  readonly counts: AwinQualityCounts;
  /** The first swapped row's two hosts, when the pass found one. */
  readonly swapExample: AwinDestinationSwapExample | null;
  readonly runId: string | null;
}

/**
 * Record what one pass read and what it measured.
 *
 * The feed row and the quality snapshot are written in ONE transaction. They
 * are two halves of one fact — this feed was read, and this is what was in it —
 * and a crash between them leaves either an import nobody measured or a
 * measurement of an import that is not recorded, both of which are worse than
 * neither.
 */
export async function recordAwinImport(
  resolved: ResolvedAwinFeed,
  outcome: AwinImportOutcome,
  now: Date = new Date(),
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await recordAwinFeedImport(
      {
        feedRowId: resolved.feed.id,
        digest: outcome.digest,
        consumedLastImportedAt: outcome.consumedLastImportedAt,
        declaredColumns: outcome.declaredColumns,
        mappingVersion: resolved.mappingVersion,
        now,
      },
      tx,
    );
    await recordAwinFeedValidators(
      {
        feedRowId: resolved.feed.id,
        etag: outcome.validators.etag,
        lastModified: outcome.validators.lastModified,
        now,
      },
      tx,
    );
    await recordAwinQuality(
      {
        advertiserRowId: resolved.advertiser.id,
        feedRowId: resolved.feed.id,
        runId: outcome.runId,
        mappingVersion: resolved.mappingVersion,
        counts: outcome.counts,
        swapExample: outcome.swapExample,
        measuredAt: now,
      },
      tx,
    );
  });
}

/** Forget a feed's conditional-request validators. Exported for the operator surface. */
export async function forgetAwinFeedValidators(feedRowId: string): Promise<void> {
  await clearAwinFeedValidators({ feedRowId });
}
