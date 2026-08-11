/**
 * The durable abuse counters and the interventions they produce (#111).
 *
 * `db/guestPortal/recoveryAttemptRepository.ts` generalised across the ten
 * scopes, and durable for that one's reason: "how often has THIS /24 asked for
 * a new session, across every ECS task" is a fact about the subject, not about
 * a process, and an in-process bucket answers a different question — one whose
 * answer gets smaller every time the fleet scales out.
 *
 * Nothing in this file can name a subject. Every function takes a `subjectHash`
 * the caller has already digested, and there is no function that takes a
 * plaintext value or returns one.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type {
  GuestAbuseAxis,
  GuestAbusePattern,
  GuestAbuseScope,
  GuestFrictionMeasure,
} from '@mercaria/shared-types';
import { guestAbuseCounters, guestAbuseInterventions } from '../schema/guestGovernance.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One live intervention, as the decision path reads it. */
export interface LiveIntervention {
  readonly id: string;
  readonly pattern: GuestAbusePattern;
  readonly measure: GuestFrictionMeasure;
  readonly expiresAt: Date;
}

/**
 * Count one attempt and return the running total for its window.
 *
 * ONE statement — `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
 * RETURNING count` — so the total is race-free across tasks. A read-then-write
 * lets a burst of concurrent requests each read the same value and all pass a
 * limit they collectively exceeded, which is precisely the shape a flood has.
 */
export async function countAbuseAttempt(
  db: DatabaseOrTransaction,
  input: {
    scope: GuestAbuseScope;
    axis: GuestAbuseAxis;
    subjectHash: string;
    windowStartedAt: Date;
  },
): Promise<number> {
  const [row] = await db
    .insert(guestAbuseCounters)
    .values({
      scope: input.scope,
      axis: input.axis,
      subjectHash: input.subjectHash,
      windowStartedAt: input.windowStartedAt,
      attemptCount: 1,
    })
    .onConflictDoUpdate({
      target: [
        guestAbuseCounters.scope,
        guestAbuseCounters.axis,
        guestAbuseCounters.subjectHash,
        guestAbuseCounters.windowStartedAt,
      ],
      set: { attemptCount: sql`${guestAbuseCounters.attemptCount} + 1` },
    })
    .returning({ attemptCount: guestAbuseCounters.attemptCount });
  if (row === undefined) {
    throw new Error('guest_abuse_counters upsert returned no row');
  }
  return row.attemptCount;
}

/**
 * The live intervention for one (pattern, subject), or `null`.
 *
 * Reads the ACTIVE row and compares its deadline against the clock rather than
 * trusting the state column alone — the `#57 deriveNativeCheckoutEligibility`
 * posture applied to a lever: an expiry sweep runs on its own schedule, and a
 * friction that outlived its deadline because a sweep was late is a person kept
 * waiting by an implementation detail.
 */
export async function findLiveIntervention(
  db: DatabaseOrTransaction,
  input: { pattern: GuestAbusePattern; subjectHash: string; now: Date },
): Promise<LiveIntervention | null> {
  const [row] = await db
    .select({
      id: guestAbuseInterventions.id,
      pattern: guestAbuseInterventions.pattern,
      measure: guestAbuseInterventions.measure,
      expiresAt: guestAbuseInterventions.expiresAt,
    })
    .from(guestAbuseInterventions)
    .where(
      and(
        eq(guestAbuseInterventions.pattern, input.pattern),
        eq(guestAbuseInterventions.subjectHash, input.subjectHash),
        eq(guestAbuseInterventions.state, 'active'),
        gte(guestAbuseInterventions.expiresAt, input.now),
      ),
    )
    .limit(1);
  return row === undefined
    ? null
    : {
        id: row.id,
        pattern: row.pattern as GuestAbusePattern,
        measure: row.measure as GuestFrictionMeasure,
        expiresAt: row.expiresAt,
      };
}

/**
 * Record one intervention, converging on the live row if one already exists.
 *
 * `ON CONFLICT DO UPDATE` against the live partial unique, so a control that
 * keeps firing EXTENDS its own friction rather than stacking a second row
 * somebody would have to lift twice. The observed count is overwritten because
 * the later observation is the true one; the threshold is not, because it is
 * the policy the friction was applied under and a policy change must not
 * rewrite what an earlier decision was made against.
 */
export async function recordIntervention(
  db: DatabaseOrTransaction,
  input: {
    pattern: GuestAbusePattern;
    scope: GuestAbuseScope;
    axis: GuestAbuseAxis;
    subjectHash: string;
    measure: GuestFrictionMeasure;
    observedCount: number;
    thresholdCount: number;
    expiresAt: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(guestAbuseInterventions)
    .values({
      pattern: input.pattern,
      scope: input.scope,
      axis: input.axis,
      subjectHash: input.subjectHash,
      measure: input.measure,
      observedCount: input.observedCount,
      thresholdCount: input.thresholdCount,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: [guestAbuseInterventions.pattern, guestAbuseInterventions.subjectHash],
      targetWhere: sql`state = 'active'`,
      set: {
        observedCount: input.observedCount,
        expiresAt: input.expiresAt,
      },
    })
    .returning({ id: guestAbuseInterventions.id });
  if (row === undefined) {
    throw new Error('guest_abuse_interventions upsert returned no row');
  }
  return row.id;
}

/** One intervention as an operator reads it. Carries NO subject hash. */
export interface InterventionSummary {
  readonly id: string;
  readonly pattern: GuestAbusePattern;
  readonly scope: GuestAbuseScope;
  readonly measure: GuestFrictionMeasure;
  readonly state: string;
  readonly observedCount: number;
  readonly thresholdCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly reviewedAt: Date | null;
}

/**
 * The most recent interventions, for the operator queue.
 *
 * The select list is the boundary and it deliberately omits `subject_hash` —
 * the column is in `PROTECTED_COLUMNS`, and a `select()` here would hand an
 * operator the one cross-row join key this domain has. What a reviewer needs is
 * the pattern, the count and the threshold, all of which are here.
 */
export async function listRecentInterventions(
  db: DatabaseOrTransaction,
  input: { limit: number; pattern?: GuestAbusePattern },
): Promise<readonly InterventionSummary[]> {
  const rows = await db
    .select({
      id: guestAbuseInterventions.id,
      pattern: guestAbuseInterventions.pattern,
      scope: guestAbuseInterventions.scope,
      measure: guestAbuseInterventions.measure,
      state: guestAbuseInterventions.state,
      observedCount: guestAbuseInterventions.observedCount,
      thresholdCount: guestAbuseInterventions.thresholdCount,
      expiresAt: guestAbuseInterventions.expiresAt,
      createdAt: guestAbuseInterventions.createdAt,
      reviewedAt: guestAbuseInterventions.reviewedAt,
    })
    .from(guestAbuseInterventions)
    .where(
      input.pattern === undefined
        ? undefined
        : eq(guestAbuseInterventions.pattern, input.pattern),
    )
    .orderBy(desc(guestAbuseInterventions.createdAt))
    .limit(input.limit);
  return rows.map((row) => ({
    id: row.id,
    pattern: row.pattern as GuestAbusePattern,
    scope: row.scope as GuestAbuseScope,
    measure: row.measure as GuestFrictionMeasure,
    state: row.state,
    observedCount: row.observedCount,
    thresholdCount: row.thresholdCount,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
  }));
}

/**
 * An operator's correction (#111 abuse control 10).
 *
 * A CAS on `state = 'active'`, so two operators reviewing one row converge and
 * the loser is told it was already decided rather than silently overwriting the
 * first verdict. `false_positive` is a STATE and not a delete, because "how
 * often is this control wrong" is a metric the issue asks for and a deleted row
 * answers it with silence.
 */
export async function reviewIntervention(
  db: DatabaseOrTransaction,
  input: {
    interventionId: string;
    state: 'lifted' | 'false_positive';
    reviewedByOxyUserId: string;
    note: string;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(guestAbuseInterventions)
    .set({
      state: input.state,
      reviewedByOxyUserId: input.reviewedByOxyUserId,
      reviewedAt: input.now,
      reviewNote: input.note,
    })
    .where(
      and(
        eq(guestAbuseInterventions.id, input.interventionId),
        eq(guestAbuseInterventions.state, 'active'),
      ),
    )
    .returning({ id: guestAbuseInterventions.id });
  return rows.length === 1;
}

/**
 * The false-positive correction RATE over a window (#111 product metric 9).
 *
 * Both halves in one statement, because two statements over a table an operator
 * is actively writing to can disagree — and a rate whose numerator and
 * denominator came from different instants is exactly the kind of number that
 * looks fine and is wrong.
 */
export async function readInterventionRates(
  db: DatabaseOrTransaction,
  input: { since: Date; until: Date },
): Promise<{ created: number; falsePositives: number }> {
  const [row] = await db
    .select({
      created: sql<number>`count(*)::int`,
      falsePositives: sql<number>`count(*) filter (where ${guestAbuseInterventions.state} = 'false_positive')::int`,
    })
    .from(guestAbuseInterventions)
    .where(
      and(
        gte(guestAbuseInterventions.createdAt, input.since),
        lt(guestAbuseInterventions.createdAt, input.until),
      ),
    );
  return { created: row?.created ?? 0, falsePositives: row?.falsePositives ?? 0 };
}
