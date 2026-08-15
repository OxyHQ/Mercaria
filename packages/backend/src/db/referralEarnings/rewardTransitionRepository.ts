/**
 * `referral_reward_transitions` — the durable, idempotent, auditable record of
 * every reward state change (#145 "Reward lifecycle").
 *
 * A transition and a POSTING are different facts and this is the one that books
 * nothing: ADR 0005 says `frozen` and `vested` move no money, so there is no
 * ledger transaction to point at and a zero-amount entry is what
 * `ledger_entries_amount_nonzero_check` refuses outright.
 *
 * The convergence is the database's, the same shape everything else in this
 * domain uses: a deterministic key over `(reward, cause, source)` and
 * `ON CONFLICT DO NOTHING`, whose empty `RETURNING` set IS the "already
 * recorded" answer. A vesting sweep that runs twice in a minute writes one row.
 */

import { asc, eq } from 'drizzle-orm';
import type {
  ReferralEventActorKind,
  ReferralRewardState,
  ReferralRewardTransitionCause,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { referralRewardTransitions } from '../schema/referralEarnings.js';

/** A transition row as the services read it back. */
export type ReferralRewardTransitionRow = typeof referralRewardTransitions.$inferSelect;

/**
 * The deterministic key of one transition — stated ONCE, here.
 *
 * `sourceRef` is what distinguishes two transitions of the SAME cause: a reward
 * frozen for one review and later for another, or settled by one batch after an
 * earlier one was cancelled. A cause alone would make the second one converge on
 * the first and vanish; a clock would make every sweep re-run a new row.
 */
export function referralRewardTransitionKey(input: {
  rewardId: string;
  cause: ReferralRewardTransitionCause;
  sourceRef: string;
}): string {
  return `refrewst:${input.rewardId}:${input.cause}:${input.sourceRef}`;
}

/** Everything a transition row is born with. */
export interface RecordRewardTransitionInput {
  rewardId: string;
  fromState: ReferralRewardState;
  toState: ReferralRewardState;
  cause: ReferralRewardTransitionCause;
  /** What caused it: a sweep run id, a batch id, an adjustment id, a case id. */
  sourceRef: string;
  actorKind: ReferralEventActorKind;
  /** Present exactly when the actor is not `system` — a CHECK, not a convention. */
  actorRef?: string;
  reason: string;
  occurredAt: Date;
}

/**
 * Append one transition, converging on the row a replay already wrote.
 *
 * @returns `created: false` when this exact transition was already recorded, in
 *   which case NOTHING is written.
 */
export async function recordRewardTransition(
  db: DatabaseOrTransaction,
  input: RecordRewardTransitionInput,
): Promise<{ row: ReferralRewardTransitionRow; created: boolean }> {
  const idempotencyKey = referralRewardTransitionKey({
    rewardId: input.rewardId,
    cause: input.cause,
    sourceRef: input.sourceRef,
  });

  const [inserted] = await db
    .insert(referralRewardTransitions)
    .values({
      rewardId: input.rewardId,
      fromState: input.fromState,
      toState: input.toState,
      cause: input.cause,
      actorKind: input.actorKind,
      actorRef: input.actorKind === 'system' ? null : (input.actorRef ?? null),
      reason: input.reason,
      idempotencyKey,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: referralRewardTransitions.idempotencyKey })
    .returning();

  if (inserted) return { row: inserted, created: true };

  const [existing] = await db
    .select()
    .from(referralRewardTransitions)
    .where(eq(referralRewardTransitions.idempotencyKey, idempotencyKey));
  if (!existing) {
    throw new Error(
      `referral_reward_transitions insert for ${idempotencyKey} conflicted with a row that then ` +
        'could not be read back.',
    );
  }
  return { row: existing, created: false };
}

/** One reward's transitions, oldest first — the lifecycle as recorded. */
export async function listRewardTransitions(
  db: DatabaseOrTransaction,
  rewardId: string,
): Promise<ReferralRewardTransitionRow[]> {
  return await db
    .select()
    .from(referralRewardTransitions)
    .where(eq(referralRewardTransitions.rewardId, rewardId))
    .orderBy(asc(referralRewardTransitions.occurredAt), asc(referralRewardTransitions.id));
}
