/**
 * What an operator can see about the domain's health (#82 §"Monitoring").
 *
 * Four answers, and each one is a fact about a RUN rather than about "now":
 *
 * 1. Coverage and the insufficient-data rate, with the unmeasured reasons beside
 *    them — a falling coverage rate that does not say WHY is an alert nobody can
 *    act on.
 * 2. The distribution of labels, with #80's disclosure floor applied: a breakdown
 *    over a market carrying four products is that market's catalogue with a
 *    percentage sign on it.
 * 3. Sudden mass changes between two comparable runs — REPORTED, never repaired.
 * 4. The correction reports merchants filed, by reason and by outcome.
 *
 * ## The vacuity check, and why it is two counts rather than one
 *
 * `signalsFromRecords` is counted off the evidence rows; `signalsEvaluated` is
 * the run's own counter. #60's device: a sweep whose page swallowed a subject
 * reports perfectly healthy counters, and the only thing that can see it is a
 * second count taken from what actually landed. `countsAgree` is reported beside
 * both rather than asserted, because an operator reading a disagreement needs the
 * two numbers and not an exception.
 */

import {
  disclosePriceSignalCount,
  PRICE_QUALITY_LABELS,
  type PriceQualityLabel,
  type PriceSignalKind,
  type PriceSignalCoverageMetrics,
  type PriceSignalDistributionBucket,
  type PriceSignalMassChangeFinding,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { findPriceSignalPolicyById } from '../../db/priceSignals/priceSignalPolicyRepository.js';
import {
  countPriceSignalEvaluations,
  findPreviousPriceSignalRun,
  findPriceSignalRun,
  listRunVerdicts,
  summarizeLabelsByMarket,
  summarizeUnmeasuredReasons,
} from '../../db/priceSignals/priceSignalRunRepository.js';
import { summarizePriceSignalFeedback } from '../../db/priceSignals/priceSignalFeedbackRepository.js';

/** Coverage and the insufficient-data rate for one run (issue monitoring 1). */
export async function readPriceSignalCoverage(
  runId: string,
): Promise<PriceSignalCoverageMetrics | undefined> {
  const run = await findPriceSignalRun(runId);
  if (run === undefined) return undefined;
  const version = await findPriceSignalPolicyById(run.policyVersionId);

  const [fromRecords, unmeasuredByReason] = await Promise.all([
    countPriceSignalEvaluations(runId),
    summarizeUnmeasuredReasons(runId),
  ]);

  return {
    runId: run.id,
    policyVersion: version?.version ?? 'unknown',
    mode: run.mode,
    subjectsScanned: run.subjectsScanned,
    signalsEvaluated: run.signalsEvaluated,
    signalsMeasured: run.signalsMeasured,
    signalsNotPresent: run.signalsNotPresent,
    signalsUnmeasured: run.signalsUnmeasured,
    // ABSENT rather than zero when nothing was evaluated: a run that measured
    // nothing and a run in which nothing could be measured are different facts,
    // and reporting 0% for the first makes a broken sweep indistinguishable from
    // a catalogue with no comparable data in it.
    ...(run.signalsEvaluated === 0
      ? {}
      : {
          coverageRate: run.signalsMeasured / run.signalsEvaluated,
          insufficientDataRate: run.signalsUnmeasured / run.signalsEvaluated,
        }),
    unmeasuredByReason,
    signalsFromRecords: fromRecords,
    countsAgree: fromRecords === run.signalsEvaluated,
  };
}

/**
 * The label distribution by MARKET (issue monitoring 2).
 *
 * The market is the dimension this table carries directly. `source` and
 * `category` are the issue's other two and are deliberately NOT stored on an
 * evaluation: both are properties of the OFFERS behind a signal rather than of
 * the signal, they are answerable by joining what the catalogue already holds,
 * and copying them onto every evaluation row would be a denormalized second
 * representation that a merge or a re-categorisation puts out of step.
 */
export async function readPriceSignalLabelDistribution(
  runId: string,
): Promise<PriceSignalDistributionBucket[]> {
  const rows = await summarizeLabelsByMarket(runId);
  return rows.map((row) => ({
    dimension: 'market' as const,
    key: row.market ?? 'all_markets',
    label: isQualityLabel(row.label) ? row.label : ('unlabelled' as const),
    count: disclosePriceSignalCount(row.total),
  }));
}

function isQualityLabel(value: string | null): value is PriceQualityLabel {
  return value !== null && (PRICE_QUALITY_LABELS as readonly string[]).includes(value);
}

/**
 * Whether a great many signals changed between this run and the comparable one
 * before it (issue monitoring 3).
 *
 * Compares the INTERSECTION of the two runs' subjects. A subject present in one
 * and absent from the other has not changed its label — it has entered or left
 * the cohort — and counting that as a change would make every catalogue growth
 * look like an incident, which is how a monitor gets muted.
 *
 * It reports and repairs NOTHING. The interesting fact is the COINCIDENCE with a
 * policy or feed change, which is why `policyVersionChanged` travels beside the
 * rate; a domain that reacted to its own instability would be suppressing the
 * evidence of it.
 */
export async function detectPriceSignalMassChange(
  runId: string,
): Promise<PriceSignalMassChangeFinding[]> {
  const run = await findPriceSignalRun(runId);
  if (run === undefined) return [];
  const previous = await findPreviousPriceSignalRun(run);
  if (previous === undefined) return [];

  // The LABEL is the only verdict whose mass movement is a signal about the
  // policy rather than about the catalogue: a lowest-observed figure moves every
  // time somebody discounts something, which is the market working.
  const kinds: readonly PriceSignalKind[] = ['price_quality_label'];
  const limit = config.priceSignals.massChangeSampleLimit;
  const [current, before] = await Promise.all([
    listRunVerdicts(run.id, kinds, limit),
    listRunVerdicts(previous.id, kinds, limit),
  ]);

  const beforeByKey = new Map(
    before.map((row) => [`${row.subjectKey}|${row.signalKind}`, row] as const),
  );

  const findings: PriceSignalMassChangeFinding[] = [];
  for (const kind of kinds) {
    let compared = 0;
    let changed = 0;
    for (const row of current) {
      if (row.signalKind !== kind) continue;
      const prior = beforeByKey.get(`${row.subjectKey}|${row.signalKind}`);
      if (prior === undefined) continue;
      compared += 1;
      if (prior.state !== row.state || prior.label !== row.label) changed += 1;
    }
    if (compared === 0) continue;
    findings.push({
      kind: 'price_quality_label',
      previousRunId: previous.id,
      currentRunId: run.id,
      subjectsCompared: compared,
      subjectsChanged: changed,
      changeRate: changed / compared,
      policyVersionChanged: previous.policyVersionId !== run.policyVersionId,
    });
  }
  return findings;
}

/** The correction reports merchants filed, by reason and by outcome (monitoring 4). */
export async function readPriceSignalFeedbackSummary(): Promise<
  { reason: string; status: string; total: number }[]
> {
  return summarizePriceSignalFeedback();
}
