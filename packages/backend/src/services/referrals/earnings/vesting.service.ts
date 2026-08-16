/**
 * Vesting, freezing and lifting a freeze (#145 "Reward lifecycle"; ADR 0005
 * D12, D18, R3 and R8).
 *
 * ## Every transition is a compare-and-swap plus an append, in one transaction
 *
 * The CAS is what makes two sweeps, an operator and a settlement converge on one
 * outcome; the append is what makes the outcome auditable. They commit together,
 * because a state that moved with no record of why is exactly what "durable,
 * idempotent and auditable" excludes.
 *
 * The transition row's key carries `(reward, cause, sourceRef)`, so a sweep that
 * runs twice in a minute writes ONE row — and if the CAS lost (somebody else got
 * there first) nothing is appended at all, which keeps the trail a record of
 * what happened rather than of what was attempted.
 *
 * ## A freeze STOPS THE HOLD CLOCK, and that is a column move
 *
 * ADR 0005 D12: "A freeze stops the hold clock; vesting requires 60 (or 30)
 * elapsed *unfrozen* days." Lifting a freeze therefore pushes `hold_until_at`
 * forward by exactly the frozen duration. `mercaria_referral_reward_frozen`
 * pinned that column outright until #145 widened it, by `CREATE OR REPLACE`
 * rather than by a second trigger (#106's device), to permit a FORWARD move
 * only — because the backwards direction is the one that would vest a reward
 * early, which is what the pin was protecting.
 *
 * A freeze whose origin was `vested` pushes nothing: its hold is already served,
 * and moving the deadline of a hold that has elapsed would be arithmetic on a
 * number nothing reads.
 *
 * ## Nothing here books, and nothing here reverses
 *
 * `vested` and `frozen` move no money (ADR 0005), so this file calls no posting
 * builder and imports no ledger module. Confirmed fraud VOIDS through #144's
 * `reverseReward`, which is where every amount change in this domain lives.
 */

import type {
  ReferralEventActorKind,
  ReferralRewardState,
  ReferralRewardTransitionCause,
} from '@mercaria/shared-types';
import { notFound } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import {
  findRewardById,
  listPartnerRewardsInStates,
  listRewardsDueToVest,
  setRewardState,
  type ReferralRewardRow,
} from '../../../db/referrals/rewardRepository.js';
import { recordRewardTransition } from '../../../db/referralEarnings/rewardTransitionRepository.js';

/** How many rewards one freeze or unfreeze sweep touches. A partner, bounded. */
const PARTNER_REWARD_PAGE = 500;

/** What one vesting pass did. */
export interface VestingSweepResult {
  scanned: number;
  vested: number;
  /** Rewards a concurrent writer had already moved — a no-op, not a failure. */
  skipped: number;
}

/**
 * Move every reward whose hold has elapsed from `held` to `vested`.
 *
 * The sweep is BOUNDED and RESUMABLE: one page per call, keyset paged on
 * `hold_until_at` (never on the id — `@oxyhq/db`'s uuid v7 is not monotonic
 * within a millisecond, and one accrual batch shares an instant).
 *
 * Each reward is its own transaction. One transaction over the page would make a
 * single failure roll back every vest before it, and there is nothing atomic
 * about two unrelated partners' rewards vesting together.
 */
export async function vestDueRewards(input: {
  at?: Date;
  limit?: number;
  /** Narrow the pass to one partner — the operator surface's `?partnerId=`. */
  partnerId?: string;
}): Promise<VestingSweepResult> {
  const at = input.at ?? new Date();
  const limit = input.limit ?? 200;
  const db = getDb();
  const due = await listRewardsDueToVest(db, {
    at,
    limit,
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
  });

  let vested = 0;
  let skipped = 0;
  for (const reward of due) {
    const moved = await db.transaction(
      async (tx) =>
        await applyTransition(tx, {
          reward,
          expected: ['held'],
          to: 'vested',
          cause: 'hold_elapsed',
          // Stable per reward: the deadline it was waiting on. A run id would
          // write one row per sweep for one vest.
          sourceRef: reward.holdUntilAt.toISOString(),
          actorKind: 'system',
          reason: `hold elapsed at ${reward.holdUntilAt.toISOString()}`,
          at,
        }),
    );
    if (moved) vested += 1;
    else skipped += 1;
  }
  return { scanned: due.length, vested, skipped };
}

/** What one freeze or unfreeze did to a partner's rewards. */
export interface PartnerFreezeResult {
  scanned: number;
  moved: number;
}

/**
 * Freeze every `held` and `vested`-unpaid reward a partner holds (ADR 0005 D18,
 * R8).
 *
 * A suspension is a fact about the PARTNER, so it reaches every currency they
 * have earned in. `paid` rewards are untouched by construction — they are not in
 * the population — which is R7: a payout is never un-paid.
 */
export async function freezePartnerRewards(input: {
  partnerId: string;
  cause: Extract<
    ReferralRewardTransitionCause,
    'frozen_for_review' | 'partner_suspended' | 'fraud_invalidated'
  >;
  sourceRef: string;
  actorKind: ReferralEventActorKind;
  actorRef?: string;
  reason: string;
  at?: Date;
}): Promise<PartnerFreezeResult> {
  const at = input.at ?? new Date();
  const db = getDb();
  const rewards = await listPartnerRewardsInStates(db, {
    partnerId: input.partnerId,
    states: ['held', 'vested'],
    limit: PARTNER_REWARD_PAGE,
  });

  let moved = 0;
  for (const reward of rewards) {
    const applied = await db.transaction(
      async (tx) =>
        await applyTransition(tx, {
          reward,
          expected: ['held', 'vested'],
          to: 'frozen',
          frozenFromState: reward.state === 'vested' ? 'vested' : 'held',
          cause: input.cause,
          sourceRef: input.sourceRef,
          actorKind: input.actorKind,
          ...(input.actorRef ? { actorRef: input.actorRef } : {}),
          reason: input.reason,
          at,
        }),
    );
    if (applied) moved += 1;
  }
  return { scanned: rewards.length, moved };
}

/**
 * Return every frozen reward a partner holds to the state it was paused in, with
 * the hold clock resuming where it stopped.
 *
 * `frozen_from_state` is what makes "freezing is a pause, never a shortcut to
 * void" true: the origin travels with the reward, so there is no rule here
 * deciding where it lands.
 */
export async function liftPartnerFreeze(input: {
  partnerId: string;
  sourceRef: string;
  actorKind: ReferralEventActorKind;
  actorRef?: string;
  reason: string;
  at?: Date;
}): Promise<PartnerFreezeResult> {
  const at = input.at ?? new Date();
  const db = getDb();
  const rewards = await listPartnerRewardsInStates(db, {
    partnerId: input.partnerId,
    states: ['frozen'],
    limit: PARTNER_REWARD_PAGE,
  });

  let moved = 0;
  for (const reward of rewards) {
    const origin: ReferralRewardState = reward.frozenFromState === 'vested' ? 'vested' : 'held';
    // The stopped clock, resumed. Only a `held` reward's deadline moves: a
    // `vested` one has already served its hold.
    const frozenFor =
      origin === 'held' && reward.frozenAt !== null
        ? Math.max(0, at.getTime() - reward.frozenAt.getTime())
        : 0;
    const applied = await db.transaction(
      async (tx) =>
        await applyTransition(tx, {
          reward,
          expected: ['frozen'],
          to: origin,
          cause: 'freeze_lifted',
          sourceRef: input.sourceRef,
          actorKind: input.actorKind,
          ...(input.actorRef ? { actorRef: input.actorRef } : {}),
          reason: input.reason,
          at,
          ...(frozenFor > 0
            ? { holdUntilAt: new Date(reward.holdUntilAt.getTime() + frozenFor) }
            : {}),
        }),
    );
    if (applied) moved += 1;
  }
  return { scanned: rewards.length, moved };
}

/** Freeze ONE reward — the dispute path (ADR 0005 R3), which is per-reward. */
export async function freezeReward(input: {
  rewardId: string;
  sourceRef: string;
  actorKind: ReferralEventActorKind;
  actorRef?: string;
  reason: string;
  at?: Date;
}): Promise<ReferralRewardRow | undefined> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const reward = await findRewardById(tx, input.rewardId);
    if (!reward) throw notFound('Referral reward not found');
    return await applyTransition(tx, {
      reward,
      expected: ['held', 'vested'],
      to: 'frozen',
      frozenFromState: reward.state === 'vested' ? 'vested' : 'held',
      cause: 'frozen_for_review',
      sourceRef: input.sourceRef,
      actorKind: input.actorKind,
      ...(input.actorRef ? { actorRef: input.actorRef } : {}),
      reason: input.reason,
      at,
    });
  });
}

/**
 * The CAS-plus-append both sweeps and both single-reward paths share.
 *
 * @returns the moved row, or `undefined` when the compare-and-swap lost. In that
 *   case NOTHING is appended: the trail records what happened, and an attempt
 *   that changed nothing did not happen.
 */
async function applyTransition(
  tx: DatabaseOrTransaction,
  input: {
    reward: ReferralRewardRow;
    expected: readonly ReferralRewardState[];
    to: ReferralRewardState;
    frozenFromState?: 'held' | 'vested';
    cause: ReferralRewardTransitionCause;
    sourceRef: string;
    actorKind: ReferralEventActorKind;
    actorRef?: string;
    reason: string;
    at: Date;
    holdUntilAt?: Date;
  },
): Promise<ReferralRewardRow | undefined> {
  const moved = await setRewardState(tx, {
    rewardId: input.reward.id,
    expected: input.expected,
    to: input.to,
    at: input.at,
    ...(input.frozenFromState ? { frozenFromState: input.frozenFromState } : {}),
    ...(input.holdUntilAt ? { holdUntilAt: input.holdUntilAt } : {}),
  });
  if (!moved) return undefined;

  await recordRewardTransition(tx, {
    rewardId: input.reward.id,
    fromState: input.reward.state,
    toState: input.to,
    cause: input.cause,
    sourceRef: input.sourceRef,
    actorKind: input.actorKind,
    ...(input.actorRef ? { actorRef: input.actorRef } : {}),
    reason: input.reason,
    occurredAt: input.at,
  });

  await appendReferralEvent(tx, {
    subjectType: 'reward',
    subjectId: input.reward.id,
    action:
      input.to === 'vested'
        ? 'reward_vested'
        : input.to === 'frozen'
          ? 'reward_frozen'
          : 'reward_unfrozen',
    actorKind: input.actorKind,
    ...(input.actorKind === 'system' ? {} : { actorRef: input.actorRef ?? 'operator' }),
    reason: `${input.reward.state} → ${input.to} (${input.cause}): ${input.reason}`,
  });

  return moved;
}
