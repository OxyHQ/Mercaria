/**
 * Test support: publishing pilot bounds that ADMIT a partner (#149).
 *
 * Shared by the referral realdb files, and it exists because the pilot gate is
 * real: `attributeTouch` refuses a NEW attribution for a programme with no
 * active cohort (`no_active_cohort`), which is the off position #149's bounds
 * are rows rather than environment variables for. A fixture that wanted an
 * attribution to happen therefore has to publish bounds first — exactly as a
 * deployment does.
 *
 * NOT exported from production code and imported by nothing under `src/` that
 * is not a test: `referral-pilot-isolation.test.ts` asserts it.
 *
 * ## Why this ACCUMULATES rather than editing
 *
 * A published cohort is frozen and its allow-list may not grow (a trigger), so
 * admitting a second partner is a NEW version that carries the first one too —
 * which is what a real widening looks like, and what makes the fixture exercise
 * the supersede path on every file that uses it rather than only where somebody
 * remembered to.
 */

import {
  REFERRAL_PILOT_STOP_METRICS,
  type ReferralPilotStopMetric,
  type ReferralPilotSubject,
  type ReferralPilotThresholdUnit,
} from '@mercaria/shared-types';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../../../db/postgres.js';
import { getDb } from '../../../db/postgres.js';
import {
  addReferralPilotPartner,
  addReferralPilotThreshold,
  createReferralPilotCohortDraft,
  findActiveReferralPilotCohort,
  listReferralPilotPartners,
  publishReferralPilotCohortVersion,
  recordReferralPilotReview,
} from '../../../db/referralPilot/pilotRepository.js';
import {
  referralPilotCohorts,
  referralPilotPartners,
  referralPilotStopThresholds,
  referralPilotStops,
} from '../../../db/schema/referralPilot.js';
import { referralPrograms } from '../../../db/schema/referrals.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';

/**
 * One fixture call at a time.
 *
 * Publishing a version READS the incumbent and then inserts the next number, so
 * two concurrent calls both see version N and collide on
 * `referral_pilot_cohorts_key_version_key`. Serialising here rather than
 * hardening the repository is deliberate: the real surface is an operator
 * request, the collision is the unique index doing its job, and a fixture that
 * retried would hide it.
 */
let fixtureChain: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = fixtureChain.then(work, work);
  fixtureChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** A rate for the rate metrics, a count for the rest. Values are not the point here. */
function unitFor(metric: ReferralPilotStopMetric): ReferralPilotThresholdUnit {
  return metric === 'privacy_incident' || metric === 'security_finding' ? 'count' : 'rate_bps';
}

/**
 * Publish bounds admitting `partnerId` on `programId`, keeping every partner
 * already admitted.
 *
 * Returns the id of the cohort version that is now active.
 */
export async function admitPartnerToReferralPilot(
  input: {
    programId: string;
    programVersionId: string;
    partnerId: string;
    operatorOxyUserId: string;
    startsAt?: Date;
    endsAt?: Date;
    maxAttributionsPerPartner?: number;
    maxAttributionsTotal?: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  return await serialized(() => publishAdmittingCohort(input, db));
}

async function publishAdmittingCohort(
  input: {
    programId: string;
    programVersionId: string;
    partnerId: string;
    operatorOxyUserId: string;
    startsAt?: Date;
    endsAt?: Date;
    maxAttributionsPerPartner?: number;
    maxAttributionsTotal?: number;
  },
  db: DatabaseOrTransaction,
): Promise<string> {
  const incumbent = await findReferralPilotIncumbent(input.programId, db);
  const carried = incumbent
    ? (await listReferralPilotPartners(incumbent.id, db)).map((row) => row.partnerId)
    : [];
  const partners = Array.from(new Set([...carried, input.partnerId]));

  // A successor may only be published once its predecessor carries a review
  // (the operator surface refuses otherwise), so the fixture records one — the
  // same dated decision a real widening needs.
  if (incumbent && incumbent.reviewedAt === null) {
    await recordReferralPilotReview(
      {
        cohortId: incumbent.id,
        decision: 'expand',
        reviewedByOxyUserId: input.operatorOxyUserId,
        rationale: 'fixture: admitting another partner',
        closes: false,
      },
      db,
    );
  }

  const draft = await createReferralPilotCohortDraft(
    {
      cohortKey: `pilot-${input.programId}`,
      version: (incumbent?.version ?? 0) + 1,
      // DERIVED from the programme's own qualifying event, never assumed: a
      // merchant-activation programme attributes `merchant` subjects, which a
      // `customer_acquisition` cohort refuses — correctly, and silently enough
      // that a fixture guessing would look like a broken gate.
      subject: await pilotSubjectFor(input.programVersionId, db),
      legalEntity: 'Mercaria Fixture SL',
      programOwnerOxyUserId: input.operatorOxyUserId,
      programId: input.programId,
      programVersionId: input.programVersionId,
      markets: ['ES'],
      payoutCurrency: 'EUR',
      startsAt: input.startsAt ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000),
      endsAt: input.endsAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
      maxAttributionsPerPartner: input.maxAttributionsPerPartner ?? 10_000,
      maxAttributionsTotal: input.maxAttributionsTotal ?? 100_000,
      rewardBudgetMinor: 100_000_00,
      manualReviewRequired: true,
      ...(incumbent ? { supersedesCohortId: incumbent.id } : {}),
      rationale: 'fixture bounds',
    },
    db,
  );

  for (const partner of partners) {
    await addReferralPilotPartner(
      {
        cohortId: draft.id,
        partnerId: partner,
        addedByOxyUserId: input.operatorOxyUserId,
        note: 'fixture',
      },
      db,
    );
  }
  for (const metric of REFERRAL_PILOT_STOP_METRICS) {
    await addReferralPilotThreshold(
      {
        cohortId: draft.id,
        metric,
        unit: unitFor(metric),
        thresholdValue: unitFor(metric) === 'rate_bps' ? 10_000 : 1_000_000,
        windowHours: 720,
        scope: 'pilot',
      },
      db,
    );
  }

  const published = await publishReferralPilotCohortVersion(
    { cohortId: draft.id, publishedByOxyUserId: input.operatorOxyUserId },
    db,
  );
  if (!published) throw new Error('pilot fixture: the cohort did not publish');
  return published.id;
}

/** Which pilot a programme version belongs to, read off its qualifying event. */
async function pilotSubjectFor(
  programVersionId: string,
  db: DatabaseOrTransaction,
): Promise<ReferralPilotSubject> {
  const [row] = await db
    .select({ policy: referralPrograms.qualifyingEventPolicy })
    .from(referralPrograms)
    .where(eq(referralPrograms.id, programVersionId))
    .limit(1);
  return row?.policy === 'merchant_activation' ? 'merchant_acquisition' : 'customer_acquisition';
}

/** The active cohort for a programme, if any — the fixture's own read. */
async function findReferralPilotIncumbent(
  programId: string,
  db: DatabaseOrTransaction,
): Promise<{ id: string; version: number; reviewedAt: Date | null } | undefined> {
  const row = await findActiveReferralPilotCohort(programId, db);
  return row === undefined
    ? undefined
    : { id: row.id, version: row.version, reviewedAt: row.reviewedAt };
}

/**
 * Delete every pilot row a file created for these programmes, children first.
 *
 * `referral_pilot_cohorts.program_version_id` and
 * `referral_pilot_partners.partner_id` are both `ON DELETE restrict`
 * deliberately — a live pilot must not have its programme or its partners
 * removed underneath it — so a teardown that skipped this would fail on 23503
 * rather than leaving a stray row.
 */
export async function deleteReferralPilotFixtures(
  programIds: readonly string[],
  db: Database = getDb(),
): Promise<void> {
  if (programIds.length === 0) return;

  // Newest version first, so a successor is always deleted before the
  // predecessor its `supersedes_cohort_id` names.
  const cohorts = await db
    .select({ id: referralPilotCohorts.id })
    .from(referralPilotCohorts)
    .where(inArray(referralPilotCohorts.programId, [...programIds]))
    .orderBy(desc(referralPilotCohorts.version));
  const ids = cohorts.map((row) => row.id);
  if (ids.length === 0) return;

  await db.delete(referralPilotPartners).where(inArray(referralPilotPartners.cohortId, ids));
  await db
    .delete(referralPilotStopThresholds)
    .where(inArray(referralPilotStopThresholds.cohortId, ids));

  // `mercaria_referral_pilot_stops_append_only` is `BEFORE UPDATE OR DELETE`, so
  // it genuinely fires on this delete and the window is not avoidable by
  // narrowing it. ONE table per window, every statement on `tx`.
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table referral_pilot_stops disable trigger mercaria_referral_pilot_stops_append_only`,
    );
    await tx.delete(referralPilotStops).where(inArray(referralPilotStops.cohortId, ids));
    await tx.execute(
      sql`alter table referral_pilot_stops enable trigger mercaria_referral_pilot_stops_append_only`,
    );
  });

  // Successors reference their predecessors, so delete newest-first, one
  // statement each. A single `not exists (...)` sweep is the tidier spelling and
  // was the first one here; it left rows behind, and a teardown that leaves rows
  // behind fails in the NEXT delete rather than in itself — so this one is
  // explicit and asserts what it removed.
  for (const id of ids) {
    await db.delete(referralPilotCohorts).where(eq(referralPilotCohorts.id, id));
  }
  const left = await db
    .select({ id: referralPilotCohorts.id })
    .from(referralPilotCohorts)
    .where(inArray(referralPilotCohorts.programId, [...programIds]));
  if (left.length > 0) {
    throw new Error(
      `pilot fixture teardown left ${String(left.length)} cohort rows; the programme delete ` +
        'that follows would fail on 23503 and name a table this file does not own',
    );
  }
}
