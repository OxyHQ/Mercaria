/**
 * What an operator needs to know about a source's catalogue (#68 §"Source
 * health" 1–8).
 *
 * ## The offer counts are DERIVED, one source at a time
 *
 * There is no stored `warning_offers` column and there must not be: it would be
 * a second representation of a deadline whose authority is the live policy, and
 * the health board is exactly where the two disagreeing would mislead. The
 * counts come from the same `assessOfferFreshness` the comparison read uses, so
 * "the board says 40 current" and "the page shows 40" are the same number by
 * construction.
 *
 * The cost is stated: the read is bounded by {@link HEALTH_OFFER_SCAN_LIMIT}
 * and the counts are "of the offers examined". A source with more than that is
 * one whose exact split nobody is deciding anything from — the decisions this
 * board drives are "is this feed degraded" and "which market is broken", and
 * both are answered by a bounded sample of the newest rows.
 *
 * ## Per-market and per-advertiser, because "unhealthy" is rarely global
 *
 * #68 source health 8 asks for them and the reason is operational: an Awin feed
 * whose Spanish advertiser left the network looks perfectly healthy in
 * aggregate, and the only thing that says otherwise is that one `country` or
 * one `affiliate_program_ref` has gone to zero current offers.
 */

import {
  assessOfferFreshness,
  type CatalogSourceAnomalyKind,
  type SourceAdvertiserHealth,
  type SourceCatalogHealth,
  type SourceMarketHealth,
} from '@mercaria/shared-types';
import { and, desc, eq, ne } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findCatalogSourceConfig } from '../../db/ingestion/catalogSourceConfigRepository.js';
import { listSourceRuns } from '../../db/ingestion/catalogSourceRunRepository.js';
import {
  countOpenRunQuarantines,
  countQuarantinesByKind,
} from '../../db/offerFreshness/runQuarantineRepository.js';
import { readRefreshQueueDepth } from '../../db/offerFreshness/refreshTaskRepository.js';
import { offers } from '../../db/schema/offers.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import { resolveCatalogSourceAdapter } from '../ingestion/registry.js';
import { resolveSourceFreshnessPolicy } from './policy.js';

/**
 * How many of a source's offers the freshness split is computed over.
 *
 * Newest-seen first, so the sample is the part of the catalogue a refresh has
 * touched most recently — which is where a feed that has started going wrong
 * shows it. A count over every offer a source ever published would be a
 * sequential scan on the one table that grows without bound.
 */
export const HEALTH_OFFER_SCAN_LIMIT = 5_000;

/** How many of a source's runs the error classification reads. */
const HEALTH_RUN_WINDOW = 50;

interface FreshnessCounts {
  current: number;
  warning: number;
  expired: number;
  unavailable: number;
  retired: number;
}

/**
 * One source's whole health picture.
 *
 * `undefined` when the source is not configured for ingestion — the
 * `resolveIngestionSource` convention, and the honest answer for a registry row
 * nobody has made an ingesting source.
 */
export async function readSourceCatalogHealth(
  input: { sourceId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SourceCatalogHealth | undefined> {
  const now = input.now ?? new Date();
  const sourceConfig = await findCatalogSourceConfig(db, input.sourceId);
  if (sourceConfig === undefined) return undefined;

  const adapter = resolveCatalogSourceAdapter(sourceConfig.provider);
  const resolved = await resolveSourceFreshnessPolicy(input.sourceId, db);

  /**
   * The offers this source produced, newest-seen first.
   *
   * The join is through `source_records` because an offer names its
   * OBSERVATION, never its source — a copy of the source id on the offer could
   * disagree with the observation's, which is #57's stated reason for not
   * having one.
   */
  const rows = await db
    .select({
      id: offers.id,
      status: offers.status,
      country: offers.country,
      affiliateNetwork: offers.affiliateNetwork,
      affiliateProgramRef: offers.affiliateProgramRef,
      observedAt: offers.observedAt,
      firstSeenAt: offers.firstSeenAt,
      lastSeenAt: offers.lastSeenAt,
      lastConfirmedAt: offers.lastConfirmedAt,
      declaredUnavailableAt: offers.declaredUnavailableAt,
      staleAt: offers.staleAt,
    })
    .from(offers)
    .innerJoin(sourceRecords, eq(sourceRecords.id, offers.sourceRecordId))
    .where(and(eq(sourceRecords.sourceId, input.sourceId), ne(offers.kind, 'native')))
    .orderBy(desc(offers.lastSeenAt))
    .limit(HEALTH_OFFER_SCAN_LIMIT);

  const counts: FreshnessCounts = {
    current: 0,
    warning: 0,
    expired: 0,
    unavailable: 0,
    retired: 0,
  };
  const markets = new Map<string, { current: number; expired: number }>();
  const advertisers = new Map<string, { current: number; expired: number }>();
  let oldestCurrentObservedAt: string | null = null;

  for (const row of rows) {
    if (row.status === 'retired') {
      counts.retired += 1;
      continue;
    }
    const assessment = assessOfferFreshness(
      {
        sourceId: input.sourceId,
        observedAt: row.observedAt,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        lastConfirmedAt: row.lastConfirmedAt,
        declaredUnavailableAt: row.declaredUnavailableAt,
        storedExpiresAt: row.staleAt,
      },
      resolved?.policy ?? null,
      now,
    );

    // `unknown` is counted with `expired` on the BOARD and nowhere else: both
    // are "not being shown", which is what the number is read for, and giving
    // an unresolvable policy its own column would put a configuration problem
    // in the same row as a catalogue one.
    const shown = assessment.level === 'current' || assessment.level === 'warning';
    if (assessment.level === 'current') counts.current += 1;
    else if (assessment.level === 'warning') counts.warning += 1;
    else if (assessment.level === 'unavailable') counts.unavailable += 1;
    else counts.expired += 1;

    const marketKey = row.country ?? '';
    const market = markets.get(marketKey) ?? { current: 0, expired: 0 };
    if (shown) market.current += 1;
    else market.expired += 1;
    markets.set(marketKey, market);

    const advertiserKey = `${row.affiliateNetwork ?? ''}|${row.affiliateProgramRef ?? ''}`;
    const advertiser = advertisers.get(advertiserKey) ?? { current: 0, expired: 0 };
    if (shown) advertiser.current += 1;
    else advertiser.expired += 1;
    advertisers.set(advertiserKey, advertiser);

    if (shown) {
      const observedAt = row.observedAt.toISOString();
      if (oldestCurrentObservedAt === null || observedAt < oldestCurrentObservedAt) {
        oldestCurrentObservedAt = observedAt;
      }
    }
  }

  /**
   * The error classification, counted from the RUNS themselves.
   *
   * Every outcome a run recorded, not just the failures: a board showing only
   * `auth_failure: 3` cannot say whether that is three failures out of four or
   * out of four hundred, and the denominator is what tells a broken credential
   * from one bad night.
   */
  const runs = await listSourceRuns(db, input.sourceId, HEALTH_RUN_WINDOW);
  const errorClassCounts: Record<string, number> = {};
  let lastFailureAt: string | null = null;
  for (const run of runs) {
    if (run.outcome === null) continue;
    errorClassCounts[run.outcome] = (errorClassCounts[run.outcome] ?? 0) + 1;
    if (run.outcome !== 'full_feed_success' && run.finishedAt !== null && lastFailureAt === null) {
      lastFailureAt = run.finishedAt.toISOString();
    }
  }

  const quarantineCounts = await countQuarantinesByKind(db, input.sourceId);
  const anomalyCounts: Record<CatalogSourceAnomalyKind, number> = {
    feed_wide_zero_price: quarantineCounts.feed_wide_zero_price ?? 0,
    currency_change: quarantineCounts.currency_change ?? 0,
    price_scale_shift: quarantineCounts.price_scale_shift ?? 0,
    mass_disappearance: quarantineCounts.mass_disappearance ?? 0,
  };

  const openQuarantines = await countOpenRunQuarantines(db, input.sourceId);
  const queue = await readRefreshQueueDepth(db, { sourceId: input.sourceId, now });

  const marketHealth: SourceMarketHealth[] = [...markets].map(([country, value]) => ({
    country: country === '' ? null : country,
    currentOffers: value.current,
    expiredOffers: value.expired,
  }));
  const advertiserHealth: SourceAdvertiserHealth[] = [...advertisers].map(([key, value]) => {
    const [network, programRef] = key.split('|');
    return {
      affiliateNetwork: network === undefined || network === '' ? null : network,
      affiliateProgramRef: programRef === undefined || programRef === '' ? null : programRef,
      currentOffers: value.current,
      expiredOffers: value.expired,
    };
  });

  return {
    sourceId: input.sourceId,
    provider: sourceConfig.provider,
    adapterRegistered: adapter !== undefined,
    declaredRefreshModes: adapter?.refreshModes ?? [],
    healthState: sourceConfig.healthState,
    lastSuccessAt: sourceConfig.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: sourceConfig.lastAttemptAt?.toISOString() ?? null,
    lastFailureAt,
    consecutiveFailures: sourceConfig.consecutiveFailures,
    errorClassCounts,
    offerCounts: counts,
    oldestCurrentObservedAt,
    queue: {
      pending: queue.pending,
      processing: queue.processing,
      deadLettered: queue.deadLettered,
      oldestPendingLagSeconds: queue.oldestPendingLagSeconds,
    },
    openQuarantines,
    anomalyCounts,
    markets: marketHealth,
    advertisers: advertiserHealth,
  };
}
