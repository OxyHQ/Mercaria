/**
 * The measurement sweep (#82 monitoring 1, 2, 3 and 6) — leased, bounded,
 * resumable, and it repairs NOTHING.
 *
 * It exists because the four things monitoring asks for cannot be answered by a
 * live read: coverage over time, the insufficient-data rate, the distribution of
 * labels, and whether a policy or feed change moved a great many signals at once.
 * A live derivation answers "what is true now" and none of those is a question
 * about now.
 *
 * ## It is a MEASUREMENT and never a cache
 *
 * Nothing serves a shopper or a merchant from `price_signal_evaluations`. The
 * public read and the merchant read both derive live, because the inputs live on
 * tables in four other domains and a cached "good price" survives the moderation
 * restriction, the rights withdrawal and the retirement that should have
 * withdrawn it. `price-signal-isolation.test.ts` fails the build if a read path
 * starts selecting from the table.
 *
 * ## The vacuity floor is a CHECK, not a comment
 *
 * `price_signal_runs_subject_counters_check` forces the three subject outcomes to
 * SUM to `subjects_scanned` by equality, and the signal counters likewise, so a
 * page that swallowed a subject cannot write a row at all. A sweep that measured
 * nothing and a sweep that went perfectly produce identical-looking output, and
 * that constraint plus `signalsFromRecords` is what stands between them.
 */

import { PRICE_SIGNAL_POLICY_KEY, type CurrencyCode, type PriceSignal } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  findPriceSignalPolicyById,
  toPriceSignalPolicy,
} from '../../db/priceSignals/priceSignalPolicyRepository.js';
import {
  advancePriceSignalRun,
  claimPriceSignalRun,
  failPriceSignalRun,
  insertPriceSignalEvaluations,
  listCohortProductIds,
  type InsertPriceSignalEvaluation,
  type PriceSignalRunRow,
} from '../../db/priceSignals/priceSignalRunRepository.js';
import { PRICE_SIGNAL_EVIDENCE_MAX_IDS } from '../../db/schema/priceSignals.js';
import { buildPriceSignalContext } from './context.service.js';
import { derivePriceSignals } from './signals.js';

/** The segments a sweep measures. Every #90 group a subject could carry. */
const SWEPT_SEGMENTS = ['new', 'refurbished', 'used'] as const;

/**
 * Run one page of one claimed sweep.
 *
 * @returns `true` when this dispatcher still owned the lease at the end. A
 * `false` is not an error: a slower page than the lease allows means a successor
 * has taken the run over, and writing counters over it would double-count into a
 * CHECK that refuses the row.
 */
export async function runPriceSignalSweepPage(
  run: PriceSignalRunRow,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const versionRow = await findPriceSignalPolicyById(run.policyVersionId);
  if (versionRow === undefined) {
    await failPriceSignalRun(run.id, leaseOwner, 'policy version missing');
    return false;
  }
  const policy = toPriceSignalPolicy(versionRow);

  const productIds = await listCohortProductIds({
    ...(run.cursorCanonicalProductId === null
      ? {}
      : { afterId: run.cursorCanonicalProductId }),
    limit: config.priceSignals.sweepBatchSize,
  });

  let subjectsScanned = 0;
  let subjectsMeasured = 0;
  let subjectsUnmeasured = 0;
  let subjectsFailed = 0;
  let signalsEvaluated = 0;
  let signalsMeasured = 0;
  let signalsNotPresent = 0;
  let signalsUnmeasured = 0;
  const evaluations: InsertPriceSignalEvaluation[] = [];

  for (const canonicalProductId of productIds) {
    for (const segment of SWEPT_SEGMENTS) {
      subjectsScanned += 1;
      try {
        const context = await buildPriceSignalContext({
          canonicalProductId,
          segment,
          ...(run.market === null ? {} : { market: run.market }),
          currency: run.displayCurrency as CurrencyCode,
          policy,
          now,
        });
        const signals = derivePriceSignals(context.input);

        let anyMeasured = false;
        for (const signal of signals) {
          signalsEvaluated += 1;
          if (signal.state === 'measured') {
            signalsMeasured += 1;
            anyMeasured = true;
          } else if (signal.state === 'not_present') signalsNotPresent += 1;
          else signalsUnmeasured += 1;

          evaluations.push(
            toEvaluationRow({
              runId: run.id,
              policyVersionId: run.policyVersionId,
              canonicalProductId,
              market: run.market,
              displayCurrency: run.displayCurrency,
              signal,
              evaluatedAt: now,
            }),
          );
        }
        if (anyMeasured) subjectsMeasured += 1;
        else subjectsUnmeasured += 1;
      } catch (error) {
        // Per-subject isolation, #60's `examineSubject` rule: a page that aborted
        // on its worst product would leave the cursor stuck on it forever, and
        // the counter CHECK is what makes the failure visible rather than
        // swallowed.
        subjectsFailed += 1;
        log.general.warn(
          { canonicalProductId, segment, runId: run.id, error: String(error) },
          '[PriceSignals] subject evaluation failed',
        );
      }
    }
  }

  await insertPriceSignalEvaluations(evaluations);

  const lastId = productIds[productIds.length - 1];
  const finished = productIds.length < config.priceSignals.sweepBatchSize;
  const advanced = await advancePriceSignalRun({
    runId: run.id,
    leaseOwner,
    ...(lastId === undefined ? {} : { cursorCanonicalProductId: lastId }),
    subjectsScanned,
    subjectsMeasured,
    subjectsUnmeasured,
    subjectsFailed,
    signalsEvaluated,
    signalsMeasured,
    signalsNotPresent,
    signalsUnmeasured,
    finished,
    ...(finished ? { finishedAt: now } : {}),
    ...(finished
      ? {}
      : { leaseUntil: new Date(now.getTime() + config.priceSignals.sweepLeaseMs) }),
  });

  return advanced !== undefined;
}

/** One evaluation row, from one derived signal. */
function toEvaluationRow(input: {
  readonly runId: string;
  readonly policyVersionId: string;
  readonly canonicalProductId: string;
  readonly market: string | null;
  readonly displayCurrency: string;
  readonly signal: PriceSignal;
  readonly evaluatedAt: Date;
}): InsertPriceSignalEvaluation {
  const signal = input.signal;
  const base = {
    runId: input.runId,
    policyVersionId: input.policyVersionId,
    scopeKind: 'canonical_product' as const,
    canonicalProductId: input.canonicalProductId,
    segment: signal.subject.segment,
    market: input.market,
    displayCurrency: input.displayCurrency as CurrencyCode,
    signalKind: signal.kind,
    sampleObservations: signal.sample.observations,
    sampleDistinctSellers: signal.sample.distinctSellers,
    sampleDistinctOffers: signal.sample.distinctOffers,
    sampleCoverageDays: signal.sample.coverageDays,
    sampleOutliersExcluded: signal.sample.outliersExcluded,
    sampleDeduplicated: signal.sample.deduplicated,
    evaluatedAt: input.evaluatedAt,
  };

  if (signal.state === 'unmeasured') {
    return { ...base, state: 'unmeasured', unmeasuredReason: signal.reason };
  }
  if (signal.state === 'not_present') {
    return { ...base, state: 'not_present' };
  }

  const value = signal.value;
  return {
    ...base,
    state: 'measured',
    ...(value.measure === 'money' ? { valueAmount: value.value.money.amount } : {}),
    ...(value.measure === 'money_range'
      ? { valueLowAmount: value.low.money.amount, valueHighAmount: value.high.money.amount }
      : {}),
    ...(value.measure === 'relative'
      ? {
          valueAmount: value.current.money.amount,
          deltaBps: value.deltaBps,
          position: value.position,
        }
      : {}),
    ...(value.measure === 'drop'
      ? { valueAmount: value.current.money.amount, deltaBps: value.deltaBps }
      : {}),
    ...(value.measure === 'label'
      ? {
          valueAmount: value.current.money.amount,
          deltaBps: value.deltaBps,
          label: value.label,
          confidence: value.confidence,
        }
      : {}),
    evidenceObservationIds: signal.evidence.observationIds.slice(0, PRICE_SIGNAL_EVIDENCE_MAX_IDS),
    evidenceOfferIds: signal.evidence.offerIds.slice(0, PRICE_SIGNAL_EVIDENCE_MAX_IDS),
    excludedOutlierObservationIds: signal.evidence.excludedOutlierObservationIds.slice(0, PRICE_SIGNAL_EVIDENCE_MAX_IDS),
  };
}

/**
 * Claim and run one page, if there is one.
 *
 * @returns whether any work was found, so the dispatcher can poll rather than
 * spin.
 */
export async function drainPriceSignalSweep(leaseOwner: string, now = new Date()): Promise<boolean> {
  const run = await claimPriceSignalRun(
    leaseOwner,
    new Date(now.getTime() + config.priceSignals.sweepLeaseMs),
    now,
  );
  if (run === undefined) return false;

  try {
    await runPriceSignalSweepPage(run, leaseOwner, now);
  } catch (error) {
    await failPriceSignalRun(run.id, leaseOwner, String(error));
    log.general.error(
      { runId: run.id, policyKey: PRICE_SIGNAL_POLICY_KEY, error: String(error) },
      '[PriceSignals] sweep page failed',
    );
  }
  return true;
}
