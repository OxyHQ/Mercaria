/**
 * The retention policy register, its runs and the legal holds that pause it
 * (#111 "Retention policy").
 *
 * Three tables in one repository because they are one transaction's worth of
 * work: a run reads the active policy, consults the holds and writes its own
 * counters, and splitting that across three files would put a two-line reader
 * in each.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  GuestDataRetentionReason,
  GuestRetentionClass,
  GuestRetentionMechanism,
} from '@mercaria/shared-types';
import { GUEST_RETENTION_CLASSES } from '@mercaria/shared-types';
import {
  GUEST_RETENTION_POLICY_KEY,
  guestLegalHolds,
  guestRetentionPolicyVersions,
  guestRetentionRuns,
} from '../schema/guestGovernance.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One class's active retention rule. */
export interface ActiveRetentionRule {
  readonly retentionClass: GuestRetentionClass;
  readonly version: string;
  readonly retentionSeconds: number | null;
  readonly mechanism: GuestRetentionMechanism;
  readonly pausableByLegalHold: boolean;
  readonly rationale: string;
}

/**
 * Every class's currently ACTIVE rule.
 *
 * Returns what is published and never fills a gap in. A class with no active
 * version is ABSENT from the result, which is what lets the caller refuse to
 * run rather than fall back to a default — the `#58 policy_missing` posture: a
 * retention performed under no published policy is a deletion nobody authorised.
 */
export async function readActiveRetentionRules(
  db: DatabaseOrTransaction,
): Promise<readonly ActiveRetentionRule[]> {
  const rows = await db
    .select({
      retentionClass: guestRetentionPolicyVersions.retentionClass,
      version: guestRetentionPolicyVersions.version,
      retentionSeconds: guestRetentionPolicyVersions.retentionSeconds,
      mechanism: guestRetentionPolicyVersions.mechanism,
      pausableByLegalHold: guestRetentionPolicyVersions.pausableByLegalHold,
      rationale: guestRetentionPolicyVersions.rationale,
    })
    .from(guestRetentionPolicyVersions)
    .where(
      and(
        eq(guestRetentionPolicyVersions.policyKey, GUEST_RETENTION_POLICY_KEY),
        eq(guestRetentionPolicyVersions.status, 'active'),
      ),
    )
    .orderBy(asc(guestRetentionPolicyVersions.retentionClass));
  return rows.map((row) => ({
    retentionClass: row.retentionClass as GuestRetentionClass,
    version: row.version,
    // `bigint({ mode: 'number' })` decodes through postgres.js as a JS string in
    // the general case, so the coercion is explicit — the #61 rule, applied to a
    // column whose value becomes a date arithmetic operand.
    retentionSeconds: row.retentionSeconds === null ? null : Number(row.retentionSeconds),
    mechanism: row.mechanism as GuestRetentionMechanism,
    pausableByLegalHold: row.pausableByLegalHold === 'yes',
    rationale: row.rationale,
  }));
}

/**
 * Publish one version of the schedule: insert every class as `draft`, then
 * activate the set atomically.
 *
 * ONE transaction, and the supersede runs BEFORE the activate — the partial
 * unique holds one active row per class, so activating first would collide with
 * the incumbent rather than replacing it. The caller supplies every class,
 * because a version covering twelve of thirteen is a schedule with a silent gap
 * and the census asserts the set is complete.
 */
export async function publishRetentionPolicyVersion(
  db: DatabaseOrTransaction,
  input: {
    version: string;
    publishedByOxyUserId: string;
    now: Date;
    rules: readonly {
      retentionClass: GuestRetentionClass;
      retentionSeconds: number | null;
      mechanism: GuestRetentionMechanism;
      pausableByLegalHold: boolean;
      rationale: string;
    }[];
  },
): Promise<void> {
  const classes = input.rules.map((rule) => rule.retentionClass);
  await db
    .update(guestRetentionPolicyVersions)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(
      and(
        eq(guestRetentionPolicyVersions.policyKey, GUEST_RETENTION_POLICY_KEY),
        eq(guestRetentionPolicyVersions.status, 'active'),
        inArray(guestRetentionPolicyVersions.retentionClass, classes),
      ),
    );
  await db.insert(guestRetentionPolicyVersions).values(
    input.rules.map((rule) => ({
      policyKey: GUEST_RETENTION_POLICY_KEY,
      version: input.version,
      retentionClass: rule.retentionClass,
      retentionSeconds: rule.retentionSeconds,
      mechanism: rule.mechanism,
      pausableByLegalHold: rule.pausableByLegalHold ? ('yes' as const) : ('no' as const),
      rationale: rule.rationale,
      status: 'active' as const,
      publishedByOxyUserId: input.publishedByOxyUserId,
      publishedAt: input.now,
    })),
  );
}

/** Whether a class is currently held for a group. */
export async function isRetentionHeld(
  db: DatabaseOrTransaction,
  input: { checkoutGroupId: string; retentionClass: GuestRetentionClass },
): Promise<boolean> {
  const [row] = await db
    .select({ id: guestLegalHolds.id })
    .from(guestLegalHolds)
    .where(
      and(
        eq(guestLegalHolds.checkoutGroupId, input.checkoutGroupId),
        eq(guestLegalHolds.retentionClass, input.retentionClass),
        isNull(guestLegalHolds.liftedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Every checkout group with a live hold on one class.
 *
 * The retention job reads this ONCE per pass and excludes the set, rather than
 * asking per row. A per-row check is one statement per candidate against a
 * table that is almost always empty, and the set is bounded by the number of
 * open disputes — which is a number a person could count.
 */
export async function readHeldCheckoutGroups(
  db: DatabaseOrTransaction,
  retentionClass: GuestRetentionClass,
): Promise<readonly string[]> {
  const rows = await db
    .select({ checkoutGroupId: guestLegalHolds.checkoutGroupId })
    .from(guestLegalHolds)
    .where(
      and(
        eq(guestLegalHolds.retentionClass, retentionClass),
        isNull(guestLegalHolds.liftedAt),
      ),
    );
  return rows.map((row) => row.checkoutGroupId);
}

/**
 * Raise a hold, converging on the live one if it already exists.
 *
 * `ON CONFLICT DO NOTHING` against the live partial unique, so two operators
 * raising the same hold produce one row and neither is told they lost — the
 * `merchant_claims` shape. The returned id is the LIVE hold's, which may be the
 * incumbent's.
 */
export async function raiseLegalHold(
  db: DatabaseOrTransaction,
  input: {
    checkoutGroupId: string;
    retentionClass: GuestRetentionClass;
    reason: GuestDataRetentionReason;
    raisedByOxyUserId: string;
    evidenceRef?: string;
  },
): Promise<string> {
  await db
    .insert(guestLegalHolds)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      retentionClass: input.retentionClass,
      reason: input.reason,
      raisedByOxyUserId: input.raisedByOxyUserId,
      ...(input.evidenceRef === undefined ? {} : { evidenceRef: input.evidenceRef }),
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: guestLegalHolds.id })
    .from(guestLegalHolds)
    .where(
      and(
        eq(guestLegalHolds.checkoutGroupId, input.checkoutGroupId),
        eq(guestLegalHolds.retentionClass, input.retentionClass),
        isNull(guestLegalHolds.liftedAt),
      ),
    )
    .limit(1);
  if (row === undefined) {
    throw new Error('guest_legal_holds insert produced no live row');
  }
  return row.id;
}

/**
 * Lift a hold. A CAS on it still being live, so two operators converge and the
 * loser is told rather than silently re-lifting an already-lifted hold.
 */
export async function liftLegalHold(
  db: DatabaseOrTransaction,
  input: {
    holdId: string;
    liftedByOxyUserId: string;
    liftReason: string;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(guestLegalHolds)
    .set({
      liftedAt: input.now,
      liftedByOxyUserId: input.liftedByOxyUserId,
      liftReason: input.liftReason,
    })
    .where(and(eq(guestLegalHolds.id, input.holdId), isNull(guestLegalHolds.liftedAt)))
    .returning({ id: guestLegalHolds.id });
  return rows.length === 1;
}

/** One retention pass, as it is opened. */
export async function openRetentionRun(
  db: DatabaseOrTransaction,
  input: {
    retentionClass: GuestRetentionClass;
    policyVersion: string;
    mode: 'dry_run' | 'apply';
    now: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(guestRetentionRuns)
    .values({
      retentionClass: input.retentionClass,
      policyVersion: input.policyVersion,
      mode: input.mode,
      startedAt: input.now,
    })
    .returning({ id: guestRetentionRuns.id });
  if (row === undefined) {
    throw new Error('guest_retention_runs insert returned no row');
  }
  return row.id;
}

/**
 * Close a retention pass with its counters.
 *
 * The counters go in ONE update, so the vacuity CHECK sees the whole set: the
 * table refuses a row whose outcomes do not SUM to `examined`, and writing them
 * one column at a time would fail on the first partial state rather than on a
 * genuinely inconsistent total.
 */
export async function closeRetentionRun(
  db: DatabaseOrTransaction,
  input: {
    runId: string;
    status: 'completed' | 'failed';
    examined: number;
    minimized: number;
    deleted: number;
    skippedHeld: number;
    failed: number;
    cursorId: string | null;
    failureCode?: string;
    now: Date;
  },
): Promise<void> {
  await db
    .update(guestRetentionRuns)
    .set({
      status: input.status,
      examinedCount: input.examined,
      minimizedCount: input.minimized,
      deletedCount: input.deleted,
      skippedHeldCount: input.skippedHeld,
      failedCount: input.failed,
      cursor: input.cursorId,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      finishedAt: input.now,
    })
    .where(eq(guestRetentionRuns.id, input.runId));
}

/** One retention pass, as the operator surface reads it. */
export interface RetentionRunSummary {
  readonly id: string;
  readonly retentionClass: GuestRetentionClass;
  readonly policyVersion: string;
  readonly mode: string;
  readonly status: string;
  readonly examined: number;
  readonly minimized: number;
  readonly deleted: number;
  readonly skippedHeld: number;
  readonly failed: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** The most recent pass per class, newest first. */
export async function listRetentionRuns(
  db: DatabaseOrTransaction,
  limit: number,
): Promise<readonly RetentionRunSummary[]> {
  const rows = await db
    .select()
    .from(guestRetentionRuns)
    .orderBy(desc(guestRetentionRuns.startedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    retentionClass: row.retentionClass as GuestRetentionClass,
    policyVersion: row.policyVersion,
    mode: row.mode,
    status: row.status,
    examined: row.examinedCount,
    minimized: row.minimizedCount,
    deleted: row.deletedCount,
    skippedHeld: row.skippedHeldCount,
    failed: row.failedCount,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

/**
 * How many classes have an active rule, and which do not.
 *
 * The vacuity floor for the whole policy: an "active" schedule missing four
 * classes and a schedule nobody published look identical to anything that reads
 * one class at a time, and only one of them is a configuration somebody chose.
 */
export async function readPolicyCoverage(
  db: DatabaseOrTransaction,
): Promise<{ covered: readonly GuestRetentionClass[]; missing: readonly GuestRetentionClass[] }> {
  const rows = await db
    .select({ retentionClass: guestRetentionPolicyVersions.retentionClass })
    .from(guestRetentionPolicyVersions)
    .where(
      and(
        eq(guestRetentionPolicyVersions.policyKey, GUEST_RETENTION_POLICY_KEY),
        eq(guestRetentionPolicyVersions.status, 'active'),
      ),
    );
  const covered = rows.map((row) => row.retentionClass as GuestRetentionClass);
  return {
    covered,
    missing: GUEST_RETENTION_CLASSES.filter((value) => !covered.includes(value)),
  };
}

/**
 * How many rows are past a deadline the sweep has not reached — the
 * `cleanup_lag` signal's input.
 *
 * Counted over the EXPIRY-SWEPT guest tables by their own deadline columns.
 * `sql.raw` is not used and cannot be: the statement is composed from drizzle
 * table objects, so a table renamed in the schema fails the build here rather
 * than silently counting nothing — which is the failure mode this counter
 * exists to make impossible everywhere else.
 */
export async function countOverdueGuestRows(
  db: DatabaseOrTransaction,
  now: Date,
): Promise<number> {
  const [row] = await db.execute<{ overdue: string }>(sql`
    select (
      (select count(*) from guest_sessions
        where (expires_at is not null and expires_at < ${now.toISOString()}::timestamptz - interval '7 days')
           or (revoked_at is not null and revoked_at < ${now.toISOString()}::timestamptz - interval '7 days'))
      + (select count(*) from guest_order_access_grants
        where purge_at is not null and purge_at < ${now.toISOString()}::timestamptz)
      + (select count(*) from guest_portal_messages
        where expires_at is not null and expires_at < ${now.toISOString()}::timestamptz)
    )::text as overdue
  `);
  return Number(row?.overdue ?? '0');
}
