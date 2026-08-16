/**
 * THE BOUNDED REFERRAL PILOT (#149) — the wiring between the pure derivations
 * and the four tables.
 *
 * `admission.ts`, `thresholds.ts` and `report.ts` hold every decision; this
 * file reads rows, hands them over and writes what came back. The split is the
 * same one #125 made and for the same reason: a bound whose arithmetic is
 * tangled with its reads is one nobody can drive over its boundaries.
 *
 * ## `assertReferralPilotAdmits` has ONE caller
 *
 * `attributeTouch`, and nowhere else. That is what makes #149 acceptance 5 —
 * "stop new attribution without stranding valid earnings, payouts or appeals" —
 * a property of the CALL GRAPH rather than a rule in a handler: a live stop
 * refuses NEW attribution while conversions, accruals, holds, vesting, payout
 * batches and appeals all carry on, because none of them asks.
 * `referral-pilot-isolation.test.ts` fails the build if a reward, payout,
 * enforcement or ranking module starts calling it.
 */

import type {
  ReferralPilotAdmission,
  ReferralPilotStopMetric,
  ReferralPilotStopScope,
} from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { getDb } from '../../db/postgres.js';
import {
  countReferralPilotEntries,
  findActiveReferralPilotCohort,
  listLiveReferralPilotStops,
  listReferralPilotPartners,
  listReferralPilotThresholds,
  liftReferralPilotStopRow,
  raiseReferralPilotStopRow,
  type ReferralPilotCohortRecord,
} from '../../db/referralPilot/pilotRepository.js';
import {
  EMPTY_REFERRAL_PILOT_AGGREGATES,
  readReferralPilotAggregates,
} from '../../db/referralPilot/measurementRepository.js';
import {
  deriveReferralPilotAdmission,
  type ReferralPilotEntry,
  type ReferralPilotState,
} from './admission.js';
import {
  evaluateReferralPilotThresholds,
  type ReferralPilotMeasurement,
  type ReferralPilotThresholdOutcome,
} from './thresholds.js';
import { composeReferralPilotReport, type ReferralPilotReport } from './report.js';

/** What a deployment with no published bounds looks like. */
const EMPTY_STATE: ReferralPilotState = {
  bounds: null,
  allowlistedPartners: new Set<string>(),
  liveStops: [],
  counts: { total: 0, forPartner: 0 },
};

/**
 * Whether the pilot admits this candidate attribution.
 *
 * With no active cohort it short-circuits after ONE read — the answer is
 * `no_active_cohort` and nothing else needs looking at.
 *
 * The caller passes its own transaction handle, so the entry COUNT is taken
 * inside the attribution's own transaction. That does not make the cap atomic
 * (see `countReferralPilotEntries`) and is not meant to: what it buys is that a
 * refusal and the row it refused cannot straddle a commit.
 */
export async function evaluateReferralPilotAdmission(
  entry: ReferralPilotEntry,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotAdmission> {
  const cohort = await findActiveReferralPilotCohort(entry.programId, db);
  if (!cohort) return deriveReferralPilotAdmission(EMPTY_STATE, entry);

  const [partners, stops, counts] = await Promise.all([
    listReferralPilotPartners(cohort.id, db),
    listLiveReferralPilotStops(cohort.id, db),
    countReferralPilotEntries(
      { programId: cohort.programId, partnerId: entry.partnerId, since: cohort.startsAt },
      db,
    ),
  ]);

  return deriveReferralPilotAdmission(
    {
      bounds: {
        cohortId: cohort.id,
        version: cohort.version,
        subject: cohort.subject,
        programId: cohort.programId,
        startsAt: cohort.startsAt,
        endsAt: cohort.endsAt,
        maxAttributionsPerPartner: cohort.maxAttributionsPerPartner,
        maxAttributionsTotal: cohort.maxAttributionsTotal,
      },
      allowlistedPartners: new Set(partners.map((row) => row.partnerId)),
      liveStops: stops,
      counts,
    },
    entry,
  );
}

/**
 * Evaluate the published thresholds against what was measured, and raise a stop
 * for each breach.
 *
 * Returns EVERY outcome, `unmeasured` included, and logs the unmeasured count
 * separately — because "twelve thresholds, four measured" is the fact an
 * operator needs and "no breaches" is what hides it.
 *
 * It RAISES and never LIFTS. A threshold falling back under its bound is not
 * evidence that whatever caused it was fixed; that is the
 * `payment_discrepancies` detection/repair separation, and a lift is an
 * attributable, dated, explained decision a person makes.
 */
export async function evaluateReferralPilotStopThresholds(
  input: { programId: string; measurements: readonly ReferralPilotMeasurement[]; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ cohortVersion: number; outcomes: readonly ReferralPilotThresholdOutcome[] }> {
  const cohort = await findActiveReferralPilotCohort(input.programId, db);
  if (!cohort) return { cohortVersion: 0, outcomes: [] };

  const thresholds = await listReferralPilotThresholds(cohort.id, db);
  const outcomes = evaluateReferralPilotThresholds(thresholds, input.measurements);

  for (const outcome of outcomes) {
    if (outcome.outcome !== 'breached') continue;
    const { raised } = await raiseReferralPilotStopRow(
      {
        cohortId: cohort.id,
        metric: outcome.metric,
        scope: outcome.scope,
        scopeRef: outcome.scopeRef,
        origin: 'automatic',
        raisedByOxyUserId: null,
        observedValue: outcome.observedValue,
        thresholdValue: outcome.thresholdValue,
        detail: `${outcome.metric} observed ${outcome.observedValue} against ${outcome.thresholdValue}`,
        ...(input.at === undefined ? {} : { at: input.at }),
      },
      db,
    );
    if (raised) {
      log.general.warn(
        {
          cohortVersion: cohort.version,
          metric: outcome.metric,
          scope: outcome.scope,
          observed: outcome.observedValue,
          threshold: outcome.thresholdValue,
        },
        '[ReferralPilot] stop threshold crossed; new attribution is paused for this scope',
      );
    }
  }

  const unmeasured = outcomes.filter((outcome) => outcome.outcome === 'unmeasured');
  if (unmeasured.length > 0) {
    log.general.warn(
      {
        cohortVersion: cohort.version,
        thresholds: outcomes.length,
        unmeasured: unmeasured.length,
        metrics: unmeasured.map((outcome) => outcome.metric),
      },
      '[ReferralPilot] some stop thresholds had no usable measurement',
    );
  }

  return { cohortVersion: cohort.version, outcomes };
}

/** An operator raises a stop by hand. Attributable, always. */
export async function raiseReferralPilotStop(
  input: {
    cohortId: string;
    metric: ReferralPilotStopMetric;
    scope: ReferralPilotStopScope;
    scopeRef: string;
    raisedByOxyUserId: string;
    observedValue: number;
    thresholdValue: number;
    detail: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ raised: boolean }> {
  return await raiseReferralPilotStopRow(
    {
      cohortId: input.cohortId,
      metric: input.metric,
      scope: input.scope,
      scopeRef: input.scopeRef,
      origin: 'operator',
      raisedByOxyUserId: input.raisedByOxyUserId,
      observedValue: input.observedValue,
      thresholdValue: input.thresholdValue,
      detail: input.detail,
    },
    db,
  );
}

/** Lift a live stop. A second lift finds nothing and answers `false`. */
export async function liftReferralPilotStop(
  input: { stopId: string; liftedByOxyUserId: string; reason: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  return await liftReferralPilotStopRow(input, db);
}

/**
 * The pilot report for the active cohort, over its own published window.
 *
 * Bounded to `min(now, endsAt)` so a report taken mid-pilot covers what has
 * happened rather than a window that has not closed — and the report carries
 * both instants, because #149's expansion review turns on "after a complete
 * measurement window" and a reader has to be able to see whether this was one.
 */
export async function readReferralPilotReport(
  input: { programId: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotReport | null> {
  const cohort = await findActiveReferralPilotCohort(input.programId, db);
  if (!cohort) return null;
  return await composeReferralPilotReportFor(cohort, input.at ?? new Date(), db);
}

/** The same report for one named cohort version, active or not. */
export async function composeReferralPilotReportFor(
  cohort: ReferralPilotCohortRecord,
  at: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotReport> {
  const to = at.getTime() < cohort.endsAt.getTime() ? at : cohort.endsAt;
  const aggregates =
    to.getTime() <= cohort.startsAt.getTime()
      ? EMPTY_REFERRAL_PILOT_AGGREGATES
      : await readReferralPilotAggregates(
          { programId: cohort.programId, from: cohort.startsAt, to },
          db,
        );
  return composeReferralPilotReport({
    cohortId: cohort.id,
    cohortVersion: cohort.version,
    from: cohort.startsAt,
    to,
    budgetMinor: cohort.rewardBudgetAmount,
    aggregates,
  });
}
