/**
 * The ONLY writer of the four `referral_pilot_*` tables (#149).
 *
 * What is deliberately ABSENT is the design. There is no `updateCohort`, no
 * `addPartnerToActiveCohort`, no `raiseCapOnActiveCohort`, no `clearStop` and
 * no delete of any kind. A published bound is what the pilot RAN UNDER, and a
 * function able to edit one would make every reading of this table a reading of
 * whatever it says today rather than of what was decided — which is the whole
 * reason #149's bounds are rows rather than environment variables.
 *
 * Widening is `createReferralPilotCohortDraft` plus
 * `publishReferralPilotCohortVersion`, which supersedes the incumbent. Lifting
 * a stop is a CAS that keeps the row.
 */

import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { SelectedRow } from '@oxyhq/db';
import type {
  CurrencyCode,
  ReferralPilotCohortStatus,
  ReferralPilotReviewDecision,
  ReferralPilotStopMetric,
  ReferralPilotStopOrigin,
  ReferralPilotStopScope,
  ReferralPilotSubject,
  ReferralPilotThresholdUnit,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  referralPilotCohorts,
  referralPilotPartners,
  referralPilotStopThresholds,
  referralPilotStops,
} from '../schema/referralPilot.js';
import { referralAttributions } from '../schema/referrals.js';

const COHORT_COLUMNS = {
  id: referralPilotCohorts.id,
  cohortKey: referralPilotCohorts.cohortKey,
  version: referralPilotCohorts.version,
  status: referralPilotCohorts.status,
  subject: referralPilotCohorts.subject,
  legalEntity: referralPilotCohorts.legalEntity,
  programOwnerOxyUserId: referralPilotCohorts.programOwnerOxyUserId,
  programId: referralPilotCohorts.programId,
  programVersionId: referralPilotCohorts.programVersionId,
  markets: referralPilotCohorts.markets,
  payoutCurrency: referralPilotCohorts.payoutCurrency,
  startsAt: referralPilotCohorts.startsAt,
  endsAt: referralPilotCohorts.endsAt,
  maxAttributionsPerPartner: referralPilotCohorts.maxAttributionsPerPartner,
  maxAttributionsTotal: referralPilotCohorts.maxAttributionsTotal,
  rewardBudgetAmount: referralPilotCohorts.rewardBudgetAmount,
  rewardBudgetCurrency: referralPilotCohorts.rewardBudgetCurrency,
  manualReviewRequired: referralPilotCohorts.manualReviewRequired,
  supersedesCohortId: referralPilotCohorts.supersedesCohortId,
  publishedAt: referralPilotCohorts.publishedAt,
  publishedByOxyUserId: referralPilotCohorts.publishedByOxyUserId,
  supersededAt: referralPilotCohorts.supersededAt,
  reviewDecision: referralPilotCohorts.reviewDecision,
  reviewedAt: referralPilotCohorts.reviewedAt,
  reviewedByOxyUserId: referralPilotCohorts.reviewedByOxyUserId,
  reviewRationale: referralPilotCohorts.reviewRationale,
  rationale: referralPilotCohorts.rationale,
  createdAt: referralPilotCohorts.createdAt,
} as const;

/** One cohort version, as every reader in this domain sees it. */
export type ReferralPilotCohortRecord = SelectedRow<typeof COHORT_COLUMNS>;

/** What an operator supplies to draft a cohort version. */
export interface NewReferralPilotCohort {
  readonly cohortKey: string;
  readonly version: number;
  readonly subject: ReferralPilotSubject;
  readonly legalEntity: string;
  readonly programOwnerOxyUserId: string;
  readonly programId: string;
  readonly programVersionId: string;
  readonly markets: readonly string[];
  readonly payoutCurrency: CurrencyCode;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly maxAttributionsPerPartner: number;
  readonly maxAttributionsTotal: number;
  readonly rewardBudgetMinor: number;
  readonly manualReviewRequired: boolean;
  readonly supersedesCohortId?: string;
  readonly rationale: string;
}

/** Draft a cohort version. Always `draft`; publishing is a separate act. */
export async function createReferralPilotCohortDraft(
  input: NewReferralPilotCohort,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotCohortRecord> {
  const [row] = await db
    .insert(referralPilotCohorts)
    .values({
      cohortKey: input.cohortKey,
      version: input.version,
      status: 'draft',
      subject: input.subject,
      legalEntity: input.legalEntity,
      programOwnerOxyUserId: input.programOwnerOxyUserId,
      programId: input.programId,
      programVersionId: input.programVersionId,
      markets: [...input.markets],
      payoutCurrency: input.payoutCurrency,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      maxAttributionsPerPartner: input.maxAttributionsPerPartner,
      maxAttributionsTotal: input.maxAttributionsTotal,
      rewardBudgetAmount: input.rewardBudgetMinor,
      rewardBudgetCurrency: input.payoutCurrency,
      manualReviewRequired: input.manualReviewRequired,
      ...(input.supersedesCohortId === undefined
        ? {}
        : { supersedesCohortId: input.supersedesCohortId }),
      rationale: input.rationale,
    })
    .returning(COHORT_COLUMNS);
  if (!row) throw new Error('referral pilot cohort draft was not created');
  return row;
}

/**
 * Publish a draft, superseding whatever was active for the same PROGRAMME.
 *
 * The incumbent is superseded BEFORE the new version becomes active, because
 * `referral_pilot_cohorts_active_program_key` permits exactly one active row per
 * programme and the reverse order would collide with itself.
 */
export async function publishReferralPilotCohortVersion(
  input: { cohortId: string; publishedByOxyUserId: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotCohortRecord | undefined> {
  const at = input.at ?? new Date();
  return await db.transaction(async (tx) => {
    const [draft] = await tx
      .select(COHORT_COLUMNS)
      .from(referralPilotCohorts)
      .where(
        and(eq(referralPilotCohorts.id, input.cohortId), eq(referralPilotCohorts.status, 'draft')),
      )
      .limit(1);
    if (!draft) return undefined;

    // The incumbent of the same PROGRAMME, not of the same `cohort_key`:
    // `referral_pilot_cohorts_active_program_key` permits exactly one active row
    // per programme, and superseding the wrong chain would leave the real
    // incumbent standing and collide on the index — the bug #82's activation had
    // and its realdb suite caught on the first run.
    await tx
      .update(referralPilotCohorts)
      .set({ status: 'superseded', supersededAt: at })
      .where(
        and(
          eq(referralPilotCohorts.programId, draft.programId),
          eq(referralPilotCohorts.status, 'active'),
        ),
      );

    const [published] = await tx
      .update(referralPilotCohorts)
      .set({ status: 'active', publishedAt: at, publishedByOxyUserId: input.publishedByOxyUserId })
      .where(
        and(eq(referralPilotCohorts.id, input.cohortId), eq(referralPilotCohorts.status, 'draft')),
      )
      .returning(COHORT_COLUMNS);
    return published;
  });
}

/**
 * The one active cohort version for a PROGRAMME, or none.
 *
 * Keyed on the programme rather than on a configured pilot key, so the
 * admission gate looks a cohort up by a fact the touch already carries.
 */
export async function findActiveReferralPilotCohort(
  programId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotCohortRecord | undefined> {
  const [row] = await db
    .select(COHORT_COLUMNS)
    .from(referralPilotCohorts)
    .where(
      and(
        eq(referralPilotCohorts.programId, programId),
        eq(referralPilotCohorts.status, 'active'),
      ),
    )
    .limit(1);
  return row;
}

/** One cohort version by id, whatever its status. */
export async function findReferralPilotCohortById(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotCohortRecord | undefined> {
  const [row] = await db
    .select(COHORT_COLUMNS)
    .from(referralPilotCohorts)
    .where(eq(referralPilotCohorts.id, cohortId))
    .limit(1);
  return row;
}

/** Every cohort version of one PROGRAMME, newest first — the chain a review walks. */
export async function listReferralPilotCohorts(
  programId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ReferralPilotCohortRecord[]> {
  return await db
    .select(COHORT_COLUMNS)
    .from(referralPilotCohorts)
    .where(eq(referralPilotCohorts.programId, programId))
    .orderBy(desc(referralPilotCohorts.version));
}

/**
 * Record the expansion review on a cohort version.
 *
 * A CAS on "no review yet", so a second review finds nothing to write: the
 * dated decision #149 acceptance 7 asks for is written ONCE, and a correction
 * is a new version rather than an edit to the record of what was decided.
 */
export async function recordReferralPilotReview(
  input: {
    cohortId: string;
    decision: ReferralPilotReviewDecision;
    reviewedByOxyUserId: string;
    rationale: string;
    closes: boolean;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReferralPilotCohortRecord | undefined> {
  const [row] = await db
    .update(referralPilotCohorts)
    .set({
      reviewDecision: input.decision,
      reviewedAt: input.at ?? new Date(),
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      reviewRationale: input.rationale,
      ...(input.closes ? { status: 'closed' as ReferralPilotCohortStatus } : {}),
    })
    .where(
      and(
        eq(referralPilotCohorts.id, input.cohortId),
        isNull(referralPilotCohorts.reviewedAt),
      ),
    )
    .returning(COHORT_COLUMNS);
  return row;
}

/** Allow-list a partner on a DRAFT cohort. A trigger refuses a published one. */
export async function addReferralPilotPartner(
  input: { cohortId: string; partnerId: string; addedByOxyUserId: string; note: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(referralPilotPartners).values({
    cohortId: input.cohortId,
    partnerId: input.partnerId,
    addedByOxyUserId: input.addedByOxyUserId,
    note: input.note,
  });
}

/** The allow-list of one cohort version. */
export async function listReferralPilotPartners(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly { partnerId: string; addedByOxyUserId: string; note: string }[]> {
  return await db
    .select({
      partnerId: referralPilotPartners.partnerId,
      addedByOxyUserId: referralPilotPartners.addedByOxyUserId,
      note: referralPilotPartners.note,
    })
    .from(referralPilotPartners)
    .where(eq(referralPilotPartners.cohortId, cohortId));
}

/** Publish a threshold on a DRAFT cohort. A trigger refuses a published one. */
export async function addReferralPilotThreshold(
  input: {
    cohortId: string;
    metric: ReferralPilotStopMetric;
    unit: ReferralPilotThresholdUnit;
    thresholdValue: number;
    windowHours: number;
    scope: ReferralPilotStopScope;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(referralPilotStopThresholds).values({
    cohortId: input.cohortId,
    metric: input.metric,
    unit: input.unit,
    thresholdValue: input.thresholdValue,
    windowHours: input.windowHours,
    scope: input.scope,
  });
}

/** The published thresholds of one cohort version. */
export async function listReferralPilotThresholds(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  readonly {
    metric: ReferralPilotStopMetric;
    unit: ReferralPilotThresholdUnit;
    thresholdValue: number;
    windowHours: number;
    scope: ReferralPilotStopScope;
  }[]
> {
  return await db
    .select({
      metric: referralPilotStopThresholds.metric,
      unit: referralPilotStopThresholds.unit,
      thresholdValue: referralPilotStopThresholds.thresholdValue,
      windowHours: referralPilotStopThresholds.windowHours,
      scope: referralPilotStopThresholds.scope,
    })
    .from(referralPilotStopThresholds)
    .where(eq(referralPilotStopThresholds.cohortId, cohortId));
}

/**
 * Raise a stop, converging two observations of one breach onto one row.
 *
 * The empty `RETURNING` set IS the "already stopped" answer — a read-then-write
 * lets two evaluations both see "no stop" and both page.
 */
export async function raiseReferralPilotStopRow(
  input: {
    cohortId: string;
    metric: ReferralPilotStopMetric;
    scope: ReferralPilotStopScope;
    scopeRef: string;
    origin: ReferralPilotStopOrigin;
    observedValue: number;
    thresholdValue: number;
    raisedByOxyUserId: string | null;
    detail: string;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ raised: boolean }> {
  const rows = await db
    .insert(referralPilotStops)
    .values({
      cohortId: input.cohortId,
      metric: input.metric,
      scope: input.scope,
      scopeRef: input.scopeRef,
      origin: input.origin,
      observedValue: input.observedValue,
      thresholdValue: input.thresholdValue,
      raisedAt: input.at ?? new Date(),
      raisedByOxyUserId: input.raisedByOxyUserId,
      detail: input.detail,
    })
    .onConflictDoNothing({
      target: [
        referralPilotStops.cohortId,
        referralPilotStops.metric,
        referralPilotStops.scope,
        referralPilotStops.scopeRef,
      ],
      // The index is PARTIAL, so the predicate has to be repeated or Postgres
      // cannot infer the arbiter and the insert raises instead of converging.
      where: sql`${referralPilotStops.liftedAt} is null`,
    })
    .returning({ id: referralPilotStops.id });
  return { raised: rows.length > 0 };
}

/** The stops that are live right now — what the admission gate reads. */
export async function listLiveReferralPilotStops(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  readonly { metric: ReferralPilotStopMetric; scope: ReferralPilotStopScope; scopeRef: string }[]
> {
  return await db
    .select({
      metric: referralPilotStops.metric,
      scope: referralPilotStops.scope,
      scopeRef: referralPilotStops.scopeRef,
    })
    .from(referralPilotStops)
    .where(and(eq(referralPilotStops.cohortId, cohortId), isNull(referralPilotStops.liftedAt)));
}

/** Every stop a cohort ever raised, newest first. */
export async function listReferralPilotStops(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  readonly {
    id: string;
    metric: ReferralPilotStopMetric;
    scope: ReferralPilotStopScope;
    scopeRef: string;
    origin: ReferralPilotStopOrigin;
    observedValue: number;
    thresholdValue: number;
    raisedAt: Date;
    raisedByOxyUserId: string | null;
    detail: string;
    liftedAt: Date | null;
    liftedByOxyUserId: string | null;
    liftReason: string | null;
  }[]
> {
  return await db
    .select({
      id: referralPilotStops.id,
      metric: referralPilotStops.metric,
      scope: referralPilotStops.scope,
      scopeRef: referralPilotStops.scopeRef,
      origin: referralPilotStops.origin,
      observedValue: referralPilotStops.observedValue,
      thresholdValue: referralPilotStops.thresholdValue,
      raisedAt: referralPilotStops.raisedAt,
      raisedByOxyUserId: referralPilotStops.raisedByOxyUserId,
      detail: referralPilotStops.detail,
      liftedAt: referralPilotStops.liftedAt,
      liftedByOxyUserId: referralPilotStops.liftedByOxyUserId,
      liftReason: referralPilotStops.liftReason,
    })
    .from(referralPilotStops)
    .where(eq(referralPilotStops.cohortId, cohortId))
    .orderBy(desc(referralPilotStops.raisedAt));
}

/** Lift a live stop. A CAS, so a second lift finds nothing and answers `false`. */
export async function liftReferralPilotStopRow(
  input: { stopId: string; liftedByOxyUserId: string; reason: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(referralPilotStops)
    .set({
      liftedAt: input.at ?? new Date(),
      liftedByOxyUserId: input.liftedByOxyUserId,
      liftReason: input.reason,
    })
    .where(and(eq(referralPilotStops.id, input.stopId), isNull(referralPilotStops.liftedAt)))
    .returning({ id: referralPilotStops.id });
  return rows.length > 0;
}

/**
 * How many attributions the cohort has admitted, in total and for one partner.
 *
 * Counted from `referral_attributions` rather than from a counter column, so
 * there is no second representation to fall out of step — and scoped by the
 * cohort's own start instant, so a program that ran before the pilot does not
 * spend its budget. Both halves come from ONE statement.
 *
 * The count is read inside the attribution's own transaction. Under READ
 * COMMITTED two concurrent attributions can both observe `n < cap` and both
 * insert, so the cap is exceeded by at most the concurrency — stated rather
 * than hidden, because a bound that took a row lock on the cohort would
 * serialise every attribution in the pilot on one row, and the caps that bound
 * MONEY are #144's and are claimed atomically at accrual.
 */
export async function countReferralPilotEntries(
  input: { programId: string; partnerId: string; since: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ total: number; forPartner: number }> {
  const [row] = await db
    .select({
      total: count(),
      forPartner: sql<number>`count(*) filter (where ${referralAttributions.partnerId} = ${input.partnerId})`,
    })
    .from(referralAttributions)
    .where(
      and(
        eq(referralAttributions.programId, input.programId),
        gte(referralAttributions.createdAt, input.since),
      ),
    );
  return { total: Number(row?.total ?? 0), forPartner: Number(row?.forPartner ?? 0) };
}
