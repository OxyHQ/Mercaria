/**
 * The launch-gate sign-offs and the stage advances they gate (#111 "Rollout
 * plan" and "Launch gates").
 *
 * Both tables are append-only. Neither has an update path here and neither ever
 * will: a sign-off somebody edited is not a sign-off, and an advance history
 * that can be rewritten cannot answer the one question it exists for.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  GuestLaunchGate,
  GuestRolloutStage,
  GuestSignoffDiscipline,
  GuestStageAdvanceRefusal,
} from '@mercaria/shared-types';
import {
  guestLaunchGateSignoffs,
  guestRolloutStageAdvances,
} from '../schema/guestGovernance.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** Record one sign-off, or one WITHDRAWAL, which is a later row saying `no`. */
export async function recordGateSignoff(
  db: DatabaseOrTransaction,
  input: {
    stage: GuestRolloutStage;
    gate: GuestLaunchGate;
    discipline: GuestSignoffDiscipline;
    satisfied: boolean;
    signedByOxyUserId: string;
    evidenceRef?: string;
    note?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(guestLaunchGateSignoffs)
    .values({
      stage: input.stage,
      gate: input.gate,
      discipline: input.discipline,
      satisfied: input.satisfied ? 'yes' : 'no',
      signedByOxyUserId: input.signedByOxyUserId,
      ...(input.evidenceRef === undefined ? {} : { evidenceRef: input.evidenceRef }),
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .returning({ id: guestLaunchGateSignoffs.id });
  if (row === undefined) {
    throw new Error('guest_launch_gate_signoffs insert returned no row');
  }
  return row.id;
}

/** The current verdict for one gate at one stage. */
export interface GateVerdict {
  readonly gate: GuestLaunchGate;
  readonly satisfied: boolean;
  readonly signedByOxyUserId: string;
  readonly signedAt: Date;
  readonly evidenceRef: string | null;
}

/**
 * The LATEST sign-off per gate for one stage.
 *
 * `distinct on` rather than a group-by-then-join, because the second is two
 * statements over an append-only table and the row that "wins" has to be
 * chosen by the same ordering both times. The tiebreak is `created_at` and then
 * `id` — and the `id` half is not decoration: a uuid v7 primary key is NOT
 * monotonic within a millisecond, so two sign-offs written in the same
 * millisecond would otherwise order arbitrarily, which for a WITHDRAWAL means a
 * gate flickering between satisfied and not on successive reads.
 *
 * The residual risk is stated rather than hidden: two rows sharing a
 * millisecond order by id, which is arbitrary but STABLE, so a read is
 * repeatable even where it is not chronological. A caller that needs true
 * ordering at that resolution must space the writes, which is what the realdb
 * fixtures do.
 */
export async function readGateVerdicts(
  db: DatabaseOrTransaction,
  stage: GuestRolloutStage,
): Promise<readonly GateVerdict[]> {
  const rows = await db
    .selectDistinctOn([guestLaunchGateSignoffs.gate], {
      gate: guestLaunchGateSignoffs.gate,
      satisfied: guestLaunchGateSignoffs.satisfied,
      signedByOxyUserId: guestLaunchGateSignoffs.signedByOxyUserId,
      signedAt: guestLaunchGateSignoffs.createdAt,
      evidenceRef: guestLaunchGateSignoffs.evidenceRef,
    })
    .from(guestLaunchGateSignoffs)
    .where(eq(guestLaunchGateSignoffs.stage, stage))
    .orderBy(
      guestLaunchGateSignoffs.gate,
      desc(guestLaunchGateSignoffs.createdAt),
      desc(guestLaunchGateSignoffs.id),
    );
  return rows.map((row) => ({
    gate: row.gate as GuestLaunchGate,
    satisfied: row.satisfied === 'yes',
    signedByOxyUserId: row.signedByOxyUserId,
    signedAt: row.signedAt,
    evidenceRef: row.evidenceRef,
  }));
}

/** Record one advance ATTEMPT, permitted or refused. */
export async function recordStageAdvance(
  db: DatabaseOrTransaction,
  input: {
    stage: GuestRolloutStage;
    outcome: 'permitted' | 'refused';
    refusal?: GuestStageAdvanceRefusal;
    unsatisfiedGates: readonly GuestLaunchGate[];
    requestedByOxyUserId: string;
    note?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(guestRolloutStageAdvances)
    .values({
      stage: input.stage,
      outcome: input.outcome,
      ...(input.refusal === undefined ? {} : { refusal: input.refusal }),
      unsatisfiedGates: [...input.unsatisfiedGates],
      requestedByOxyUserId: input.requestedByOxyUserId,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .returning({ id: guestRolloutStageAdvances.id });
  if (row === undefined) {
    throw new Error('guest_rollout_stage_advances insert returned no row');
  }
  return row.id;
}

/**
 * The stage this deployment has reached — the latest PERMITTED advance.
 *
 * DERIVED, never stored. There is no `current_stage` column and no
 * `GUEST_ROLLOUT_STAGE` variable, because a stored pointer beside an
 * append-only history is two representations of one fact and the one that would
 * be wrong is the one an operator reads during an incident.
 *
 * `null` means no advance has ever been permitted, which is stage 0 by
 * definition and is deliberately NOT returned as `stage_0_internal`: "nobody
 * has advanced anything" and "somebody deliberately advanced to stage 0" are
 * different facts, and only the second has a row behind it.
 */
export async function readCurrentStage(
  db: DatabaseOrTransaction,
): Promise<GuestRolloutStage | null> {
  const [row] = await db
    .select({ stage: guestRolloutStageAdvances.stage })
    .from(guestRolloutStageAdvances)
    .where(eq(guestRolloutStageAdvances.outcome, 'permitted'))
    .orderBy(desc(guestRolloutStageAdvances.createdAt), desc(guestRolloutStageAdvances.id))
    .limit(1);
  return row === undefined ? null : (row.stage as GuestRolloutStage);
}

/** One advance attempt as the operator surface reads it. */
export interface StageAdvanceRow {
  readonly id: string;
  readonly stage: GuestRolloutStage;
  readonly outcome: string;
  readonly refusal: string | null;
  readonly unsatisfiedGates: readonly string[];
  readonly requestedByOxyUserId: string;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** The advance history, newest first — refusals included, which is the point. */
export async function listStageAdvances(
  db: DatabaseOrTransaction,
  limit: number,
): Promise<readonly StageAdvanceRow[]> {
  const rows = await db
    .select()
    .from(guestRolloutStageAdvances)
    .orderBy(desc(guestRolloutStageAdvances.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    stage: row.stage as GuestRolloutStage,
    outcome: row.outcome,
    refusal: row.refusal,
    unsatisfiedGates: row.unsatisfiedGates,
    requestedByOxyUserId: row.requestedByOxyUserId,
    note: row.note,
    createdAt: row.createdAt,
  }));
}

/**
 * How many sign-off rows exist at all — the vacuity floor for the launch-gate
 * surface.
 *
 * A stage advance refused because "no gate is satisfied" and one refused
 * because "nobody has ever recorded a sign-off" are the same refusal with very
 * different next actions, and this is what tells them apart.
 */
export async function countGateSignoffs(db: DatabaseOrTransaction): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(guestLaunchGateSignoffs);
  return Number(row?.total ?? 0);
}

/** Every sign-off for one gate, oldest first — the audit an approver reads. */
export async function listGateHistory(
  db: DatabaseOrTransaction,
  input: { stage: GuestRolloutStage; gate: GuestLaunchGate },
): Promise<readonly GateVerdict[]> {
  const rows = await db
    .select({
      gate: guestLaunchGateSignoffs.gate,
      satisfied: guestLaunchGateSignoffs.satisfied,
      signedByOxyUserId: guestLaunchGateSignoffs.signedByOxyUserId,
      signedAt: guestLaunchGateSignoffs.createdAt,
      evidenceRef: guestLaunchGateSignoffs.evidenceRef,
    })
    .from(guestLaunchGateSignoffs)
    .where(
      and(
        eq(guestLaunchGateSignoffs.stage, input.stage),
        eq(guestLaunchGateSignoffs.gate, input.gate),
      ),
    )
    .orderBy(guestLaunchGateSignoffs.createdAt);
  return rows.map((row) => ({
    gate: row.gate as GuestLaunchGate,
    satisfied: row.satisfied === 'yes',
    signedByOxyUserId: row.signedByOxyUserId,
    signedAt: row.signedAt,
    evidenceRef: row.evidenceRef,
  }));
}
