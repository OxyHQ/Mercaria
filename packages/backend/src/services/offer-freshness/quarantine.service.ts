/**
 * The PRE-PUBLICATION gate: a page's output is judged before any of it becomes
 * an offer (#68 anomaly 2 and 5).
 *
 * ## Where this sits in #62's pipeline, and why exactly there
 *
 * #62's page loop was persist-then-advance per record: an observation was
 * stored and immediately matched, linked and materialised into an offer. #68
 * splits it, because "never overwrite prior current offers with unvalidated
 * anomalous records" is not something a per-record check can promise — the four
 * findings are statements about a DISTRIBUTION, and by the time the last record
 * of a page has shown the distribution to be wrong, the first ninety-nine have
 * already replaced ninety-nine live prices.
 *
 * So: every record of a page is PERSISTED (provenance is never lost, whatever
 * the verdict), the page's distribution is compared against the source's stored
 * baseline, and only then is the page ADVANCED. A quarantined page advances
 * nothing, which makes the guarantee a property of the call graph rather than
 * of a branch somebody remembers.
 *
 * ## A quarantine is about CONTENT, so re-delivery does not answer it
 *
 * #62's per-object rule, restated for a pass. The same feed arriving again
 * produces the same distribution and the same finding; what clears it is an
 * operator releasing it explicitly, or a LATER run whose distribution the
 * detectors accept. Those two are recorded differently and deliberately —
 * `catalog_source_run_quarantines_actor_shape_check` makes the actor mandatory
 * on one and forbidden on the other.
 */

import type {
  SourceAnomalyFinding,
  SourceAnomalyThresholds,
  SourceObservationDistribution,
} from '@mercaria/shared-types';
import { CATALOG_SOURCE_ANOMALY_KINDS, detectSourceAnomalies } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findSourceDistribution,
  recordSourceDistribution,
  toObservationDistribution,
} from '../../db/offerFreshness/sourceDistributionRepository.js';
import {
  correctRunQuarantines,
  countOpenRunQuarantines,
  openRunQuarantine,
} from '../../db/offerFreshness/runQuarantineRepository.js';

/** Whether this source has any finding still open — one existence read. */
async function sourceHasOpenQuarantine(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<boolean> {
  return (await countOpenRunQuarantines(db, sourceId)) > 0;
}

/** What the gate decided about one page. */
export interface PagePublicationVerdict {
  /** `true` when the page's objects may be advanced into offers. */
  readonly mayPublish: boolean;
  readonly findings: readonly SourceAnomalyFinding[];
}

/**
 * Judge one page's distribution and, when it fails, hold it.
 *
 * The verdict is computed by the PURE detector and this function only stores
 * it, which is what keeps "would a sale trip this" a question about
 * `detectSourceAnomalies` and its fixtures rather than about a database.
 *
 * `unseenPriorObjects` is `null` for every mode but a COMPLETE snapshot, and
 * that is #68 acceptance 3 one layer up: an incremental feed that did not
 * mention nine tenths of the catalogue has said nothing about them, so there is
 * no disappearance to measure.
 */
export async function judgePagePublication(
  db: DatabaseOrTransaction,
  input: {
    runId: string;
    sourceId: string;
    distribution: SourceObservationDistribution;
    thresholds: SourceAnomalyThresholds;
    unseenPriorObjects: number | null;
    /**
     * How many objects this source was known to publish, counted NOW.
     *
     * Supplied only by the run-closing call, where the disappearance detector
     * runs. It overrides the count stored beside the baseline because the
     * question at close is "how much of what we currently hold did this pass
     * fail to mention", and the baseline's count is as old as the baseline. The
     * page-level call passes nothing and the stored count is used, which is
     * correct there: the price detectors do not read it at all.
     */
    priorObjectCountOverride?: number;
    heldObjects: number;
    now: Date;
  },
): Promise<PagePublicationVerdict> {
  const stored = await findSourceDistribution(db, input.sourceId);
  const prior = stored === undefined ? null : toObservationDistribution(stored);

  const findings = detectSourceAnomalies({
    current: input.distribution,
    prior,
    thresholds: input.thresholds,
    unseenPriorObjects: input.unseenPriorObjects,
    priorObjectCount: input.priorObjectCountOverride ?? stored?.objectCount ?? 0,
  });

  if (findings.length === 0) return { mayPublish: true, findings };

  for (const finding of findings) {
    await openRunQuarantine(db, {
      runId: input.runId,
      sourceId: input.sourceId,
      finding,
      heldObjects: input.heldObjects,
      now: input.now,
    });
  }
  log.general.warn(
    {
      sourceId: input.sourceId,
      runId: input.runId,
      kinds: findings.map((finding) => finding.kind),
    },
    '[OfferFreshness] page quarantined before publication',
  );
  return { mayPublish: false, findings };
}

/**
 * Close out a run: adopt its distribution as the new baseline, and resolve the
 * findings it no longer trips.
 *
 * The ORDER is load-bearing. Corrections are applied for the kinds this run did
 * NOT produce, and only then is the baseline replaced — because
 * `recordSourceDistribution` refuses a baseline from a quarantined run, and
 * resolving first would let a run that is still quarantined for one kind
 * install its distribution as normal for every other.
 *
 * A correction is scoped to one kind: a feed whose currency came back has not
 * thereby answered a mass-disappearance finding, and closing both would tell an
 * operator a problem was solved that nobody looked at.
 */
export async function settleRunQuarantines(
  db: DatabaseOrTransaction,
  input: {
    runId: string;
    sourceId: string;
    distribution: SourceObservationDistribution;
    objectCount: number;
    findings: readonly SourceAnomalyFinding[];
    now: Date;
  },
): Promise<{ corrected: number }> {
  const tripped = new Set(input.findings.map((finding) => finding.kind));
  let corrected = 0;
  /**
   * The corrections run only when this source HAS an open finding.
   *
   * One cheap existence read instead of four unconditional `UPDATE`s per run
   * close, and the healthy path — which is every run of a feed nobody has ever
   * quarantined — does none of them. That is not only cheaper: a run that ends
   * in a fetch failure closes through here too, and issuing four writes to
   * resolve findings that do not exist is work whose only observable effect is
   * to hold locks other passes are waiting for.
   */
  if (await sourceHasOpenQuarantine(db, input.sourceId)) {
    // Iterated from the TUPLE, so a fifth detector added later is corrected by
    // this run too rather than staying open forever because nobody listed it.
    for (const kind of CATALOG_SOURCE_ANOMALY_KINDS) {
      if (tripped.has(kind)) continue;
      corrected += await correctRunQuarantines(db, {
        sourceId: input.sourceId,
        kind,
        note: `resolved by run ${input.runId}`,
        now: input.now,
      });
    }
  }

  /**
   * A pass that MEASURED NOTHING does not become the baseline.
   *
   * An empty distribution is not evidence about a feed's shape — it is what a
   * fetch failure, a rights suspension and an empty final page all produce —
   * and adopting one would silence every comparative detector on the next run,
   * because the prior's sample would sit below the floor. The previous baseline
   * survives instead, which is the honest answer: nothing new was learned.
   */
  if (input.distribution.sampleSize > 0) {
    await recordSourceDistribution(db, {
      sourceId: input.sourceId,
      runId: input.runId,
      distribution: input.distribution,
      objectCount: input.objectCount,
      quarantined: input.findings.length > 0,
      now: input.now,
    });
  }

  return { corrected };
}
