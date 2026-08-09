/**
 * `analytics_experiments` and `analytics_experiment_exposures` (#77
 * experimentation).
 *
 * The experiment row is an immutable VERSION once it leaves `draft` — the
 * `fee_schedules` shape, held by the trigger this domain's migration installs
 * rather than by a service comparison. What lives here is the reading, the
 * activation CAS and the exposure claim.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  AnalyticsExperimentAssignmentUnit,
  AnalyticsExperimentStatus,
  AnalyticsExperimentStopCondition,
  AnalyticsExperimentTreatmentKind,
} from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { analyticsExperimentExposures, analyticsExperiments } from '../schema/analytics.js';

/** A stored experiment version, projected. */
export interface AnalyticsExperimentRecord {
  readonly id: string;
  readonly experimentKey: string;
  readonly version: number;
  readonly status: AnalyticsExperimentStatus;
  readonly treatmentKind: AnalyticsExperimentTreatmentKind;
  readonly hypothesis: string;
  readonly primaryMetricKey: string;
  readonly guardrailMetricKeys: readonly string[];
  readonly stopConditions: readonly string[];
  readonly assignmentUnit: AnalyticsExperimentAssignmentUnit;
  readonly assignmentSalt: string;
  readonly variants: readonly string[];
  readonly trafficAllocationBps: number;
  readonly rankingPolicyVersion: string | null;
  readonly activatedAt: Date | null;
  readonly stoppedAt: Date | null;
  readonly stopReason: string | null;
}

const EXPERIMENT_PROJECTION = {
  id: analyticsExperiments.id,
  experimentKey: analyticsExperiments.experimentKey,
  version: analyticsExperiments.version,
  status: analyticsExperiments.status,
  treatmentKind: analyticsExperiments.treatmentKind,
  hypothesis: analyticsExperiments.hypothesis,
  primaryMetricKey: analyticsExperiments.primaryMetricKey,
  guardrailMetricKeys: analyticsExperiments.guardrailMetricKeys,
  stopConditions: analyticsExperiments.stopConditions,
  assignmentUnit: analyticsExperiments.assignmentUnit,
  assignmentSalt: analyticsExperiments.assignmentSalt,
  variants: analyticsExperiments.variants,
  trafficAllocationBps: analyticsExperiments.trafficAllocationBps,
  rankingPolicyVersion: analyticsExperiments.rankingPolicyVersion,
  activatedAt: analyticsExperiments.activatedAt,
  stoppedAt: analyticsExperiments.stoppedAt,
  stopReason: analyticsExperiments.stopReason,
} as const;

/** Every ACTIVE experiment version. The assignment path's only read. */
export async function readActiveExperiments(): Promise<readonly AnalyticsExperimentRecord[]> {
  return getDb()
    .select(EXPERIMENT_PROJECTION)
    .from(analyticsExperiments)
    .where(eq(analyticsExperiments.status, 'active'))
    .orderBy(analyticsExperiments.experimentKey);
}

/** Every version of every experiment, for the operator surface. */
export async function readExperimentVersions(
  experimentKey?: string,
): Promise<readonly AnalyticsExperimentRecord[]> {
  const query = getDb().select(EXPERIMENT_PROJECTION).from(analyticsExperiments);
  const rows =
    experimentKey === undefined
      ? await query.orderBy(analyticsExperiments.experimentKey, analyticsExperiments.version)
      : await query
          .where(eq(analyticsExperiments.experimentKey, experimentKey))
          .orderBy(analyticsExperiments.version);
  return rows;
}

/** A new DRAFT version. Every economic field is still editable until activation. */
export interface AnalyticsExperimentDraft {
  readonly experimentKey: string;
  readonly version: number;
  readonly treatmentKind: AnalyticsExperimentTreatmentKind;
  readonly hypothesis: string;
  readonly primaryMetricKey: string;
  readonly guardrailMetricKeys: readonly string[];
  readonly stopConditions: readonly AnalyticsExperimentStopCondition[];
  readonly assignmentUnit: AnalyticsExperimentAssignmentUnit;
  readonly assignmentSalt: string;
  readonly variants: readonly string[];
  readonly trafficAllocationBps: number;
  readonly rankingPolicyVersion: string | null;
}

/** Insert a draft version. */
export async function insertExperimentDraft(
  draft: AnalyticsExperimentDraft,
): Promise<AnalyticsExperimentRecord> {
  const rows = await getDb()
    .insert(analyticsExperiments)
    .values({
      ...draft,
      status: 'draft',
      guardrailMetricKeys: [...draft.guardrailMetricKeys],
      stopConditions: [...draft.stopConditions],
      variants: [...draft.variants],
    })
    .returning(EXPERIMENT_PROJECTION);
  const row = rows[0];
  if (!row) throw new Error('Inserting an experiment draft returned no row');
  return row;
}

/**
 * Activate a draft.
 *
 * A CAS on `status = 'draft'`, one statement, so the guard and the mutation are
 * evaluated together — the conditional-write rule `CONVENTIONS.md` records under
 * "the three concurrency shapes a mocked test cannot see". The one-active-per-key
 * partial unique is the second layer: two drafts of one experiment activated
 * concurrently produce one winner and one constraint violation, never two live
 * versions splitting the same traffic.
 *
 * @returns The activated version, or `undefined` when it was not a draft.
 */
export async function activateExperiment(input: {
  experimentKey: string;
  version: number;
  now: Date;
}): Promise<AnalyticsExperimentRecord | undefined> {
  const rows = await getDb()
    .update(analyticsExperiments)
    .set({ status: 'active', activatedAt: input.now })
    .where(
      and(
        eq(analyticsExperiments.experimentKey, input.experimentKey),
        eq(analyticsExperiments.version, input.version),
        eq(analyticsExperiments.status, 'draft'),
      ),
    )
    .returning(EXPERIMENT_PROJECTION);
  return rows[0];
}

/**
 * Stop a running experiment, recording WHICH stop condition fired.
 *
 * A CAS on `status = 'active'` for the same reason activation is. The reason is
 * mandatory — an experiment stopped with no recorded cause is one whose result
 * cannot be interpreted later, and "somebody turned it off" is the thing an
 * incident review most needs and least often has.
 */
export async function stopExperiment(input: {
  experimentKey: string;
  version: number;
  reason: AnalyticsExperimentStopCondition;
  now: Date;
}): Promise<AnalyticsExperimentRecord | undefined> {
  const rows = await getDb()
    .update(analyticsExperiments)
    .set({ status: 'stopped', stoppedAt: input.now, stopReason: input.reason })
    .where(
      and(
        eq(analyticsExperiments.experimentKey, input.experimentKey),
        eq(analyticsExperiments.version, input.version),
        eq(analyticsExperiments.status, 'active'),
      ),
    )
    .returning(EXPERIMENT_PROJECTION);
  return rows[0];
}

/** The highest version recorded for an experiment key, or 0. */
export async function readMaxExperimentVersion(experimentKey: string): Promise<number> {
  const rows = await getDb()
    .select({ maxVersion: sql<number>`coalesce(max(${analyticsExperiments.version}), 0)::int` })
    .from(analyticsExperiments)
    .where(eq(analyticsExperiments.experimentKey, experimentKey));
  return Number(rows[0]?.maxVersion ?? 0);
}

/**
 * Record a FIRST exposure.
 *
 * `DO NOTHING` on the unit unique: a repeat is not a second exposure and must
 * not be counted as a second unit. The empty vs one-row `RETURNING` set is the
 * "already exposed" answer, which is what lets the caller emit the
 * `experiment_exposed` event exactly once per unit rather than once per render.
 *
 * @returns `true` when this call recorded the first exposure.
 */
export async function claimFirstExposure(input: {
  experimentKey: string;
  experimentVersion: number;
  assignmentUnitRef: string;
  assignmentUnit: AnalyticsExperimentAssignmentUnit;
  variant: string;
  now: Date;
  expiresAt: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .insert(analyticsExperimentExposures)
    .values({
      experimentKey: input.experimentKey,
      experimentVersion: input.experimentVersion,
      assignmentUnitRef: input.assignmentUnitRef,
      assignmentUnit: input.assignmentUnit,
      variant: input.variant,
      firstExposedAt: input.now,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({
      target: [
        analyticsExperimentExposures.experimentKey,
        analyticsExperimentExposures.experimentVersion,
        analyticsExperimentExposures.assignmentUnitRef,
      ],
    })
    .returning({ id: analyticsExperimentExposures.id });
  return rows.length === 1;
}

/** How many units have been exposed to each arm — the guardrail dashboard's base. */
export async function countExposuresByVariant(input: {
  experimentKey: string;
  experimentVersion: number;
}): Promise<readonly { variant: string; units: number }[]> {
  const rows = await getDb()
    .select({
      variant: analyticsExperimentExposures.variant,
      units: sql<number>`count(*)::int`,
    })
    .from(analyticsExperimentExposures)
    .where(
      and(
        eq(analyticsExperimentExposures.experimentKey, input.experimentKey),
        eq(analyticsExperimentExposures.experimentVersion, input.experimentVersion),
      ),
    )
    .groupBy(analyticsExperimentExposures.variant)
    .orderBy(analyticsExperimentExposures.variant);
  return rows.map((row) => ({ variant: row.variant, units: Number(row.units) }));
}

/** Whether any experiment version is still awaiting activation. Operator read. */
export async function countDraftExperiments(): Promise<number> {
  const rows = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(analyticsExperiments)
    .where(
      and(
        inArray(analyticsExperiments.status, ['draft']),
        isNull(analyticsExperiments.activatedAt),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}
