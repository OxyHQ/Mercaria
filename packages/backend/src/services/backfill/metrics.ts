/**
 * The rollout metrics (#60 job behaviour 5: throughput, ambiguity, unmatched
 * rate and orphaned offers).
 *
 * ## Every rate is `null` when its denominator is zero
 *
 * `match_benchmark_categories`' rule, and it is the whole reason these numbers
 * are worth reading: "nothing was scanned" is not "the unmatched rate is 0%",
 * and a dashboard that cannot tell them apart reports a healthy migration for a
 * job that never ran. A `0` here would be exactly that lie.
 *
 * ## The ambiguity rate excludes the consistency stage
 *
 * Every consistency FINDING is `review_required`, because a disagreement between
 * a listing and its offer needs a person. Those are not matching ambiguity, and
 * folding them in would make the number an operator watches to decide "is the
 * matcher working" move for reasons that have nothing to do with the matcher.
 * They are reported on their own, as `openFindings`.
 *
 * ## Two counts of the same thing, from two sources
 *
 * `scanned` comes from the run rows' counters; `scannedFromRecords` counts the
 * evidence rows. They should agree, and the surface shows both — because a
 * broken runner can fake one number and not two, which is the only defence
 * against a report that is wrong in the direction nobody checks.
 */

import type {
  CatalogBackfillMetrics,
  CatalogBackfillMode,
  CatalogConsistencyFindingKind,
} from '@mercaria/shared-types';
import { CATALOG_CONSISTENCY_FINDING_KINDS } from '@mercaria/shared-types';
import { listBackfillRuns } from '../../db/backfill/backfillRunRepository.js';
import { tallyBackfillRecords } from '../../db/backfill/backfillRecordRepository.js';
import { countOpenConsistencyFindings } from '../../db/backfill/consistencyFindingRepository.js';
import { CATALOG_BACKFILL_MAPPING_VERSION } from './mapping-version.js';
import { toBackfillRunDTO } from './dto.js';

/**
 * The finding kinds that mean an active native offer has no valid active native
 * source — #60 acceptance 6's exact phrasing, as a set.
 *
 * `attached_variant_without_offer` is deliberately NOT one of them: it is the
 * opposite direction (a source with no offer), and counting it as an orphaned
 * offer would make the acceptance criterion unfalsifiable in the direction it
 * cares about.
 */
const ORPHAN_KINDS: ReadonlySet<CatalogConsistencyFindingKind> = new Set([
  'offer_without_active_listing',
  'offer_without_active_link',
  'offer_canonical_variant_mismatch',
]);

/** A rate, or `null` when nothing was measured. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface BackfillSummary extends CatalogBackfillMetrics {
  /** The same count, taken from the evidence rows instead of the counters. */
  readonly scannedFromRecords: number;
  /** `true` when the two counts agree — the vacuity floor, surfaced. */
  readonly countsAgree: boolean;
}

/**
 * Read the migration's health.
 *
 * Scoped to ONE mode, because a dry run's numbers and an apply's are not
 * comparable in aggregate: mixing them would let a rehearsal's clean prediction
 * dilute a real run's failures.
 */
export async function summarizeBackfill(
  options: { mode: CatalogBackfillMode; mappingVersion?: number } = { mode: 'apply' },
): Promise<BackfillSummary> {
  const mappingVersion = options.mappingVersion ?? CATALOG_BACKFILL_MAPPING_VERSION;
  const allRuns = await listBackfillRuns({ mappingVersion, limit: 200 });
  const runs = allRuns.filter((run) => run.mode === options.mode);

  let scanned = 0;
  let reviewRequiredExcludingConsistency = 0;
  let scannedExcludingConsistency = 0;
  let unmatched = 0;
  let failed = 0;
  let elapsedMs = 0;

  for (const run of runs) {
    scanned += run.scanned;
    unmatched += run.unmatched;
    failed += run.failed;
    if (run.stage !== 'consistency') {
      scannedExcludingConsistency += run.scanned;
      reviewRequiredExcludingConsistency += run.reviewRequired;
    }
    if (run.startedAt !== null) {
      const end = run.completedAt ?? run.lastRunAt ?? run.startedAt;
      elapsedMs += Math.max(0, end.getTime() - run.startedAt.getTime());
    }
  }

  const tallies = await tallyBackfillRecords({ mappingVersion, mode: options.mode });
  const scannedFromRecords = tallies.reduce((total, tally) => total + tally.records, 0);

  const openByKind = await countOpenConsistencyFindings();
  const findings = new Map(openByKind.map((row) => [row.kind, row.open]));

  // Built by reducing over the KIND TUPLE rather than over what the query
  // returned, so a kind with no open findings reports 0 instead of being absent
  // — an absent key and a zero read very differently on a dashboard.
  const openFindings: Record<CatalogConsistencyFindingKind, number> = {
    attached_variant_without_offer: 0,
    offer_without_active_listing: 0,
    offer_without_active_link: 0,
    offer_canonical_variant_mismatch: 0,
  };
  let orphanedNativeOffers = 0;
  for (const kind of CATALOG_CONSISTENCY_FINDING_KINDS) {
    const open = findings.get(kind) ?? 0;
    openFindings[kind] = open;
    if (ORPHAN_KINDS.has(kind)) orphanedNativeOffers += open;
  }

  return {
    mappingVersion,
    scanned,
    scannedFromRecords,
    countsAgree: scanned === scannedFromRecords,
    // Seconds, not milliseconds, because a migration's throughput is a
    // records-per-second number an operator reasons about; a zero elapsed time
    // (every run opened and not yet paged) yields `null` rather than infinity.
    throughputPerSecond: rate(scanned, elapsedMs / 1_000),
    ambiguityRate: rate(reviewRequiredExcludingConsistency, scannedExcludingConsistency),
    unmatchedRate: rate(unmatched, scanned),
    failureRate: rate(failed, scanned),
    openFindings,
    orphanedNativeOffers,
    runs: runs.map(toBackfillRunDTO),
  };
}
