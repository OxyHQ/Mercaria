/**
 * The durable recovery throttle (#108 recovery rule 2).
 *
 * Three axes, all counted in Postgres rather than Redis, because two of them
 * ask a question a per-process bucket cannot answer: "how often has THIS INBOX
 * been asked for, across every ECS task and every source address" is a fact
 * about the inbox. The merchant-claiming domain (#83) made the same call for
 * the same reason.
 *
 * Every subject is a keyed digest, so the table counts without being able to
 * name an address, an order or a client — and there is no user agent, screen
 * metric or persistent client identifier anywhere in it. The absence IS rule
 * 2's "without fingerprinting".
 */

import { and, eq, sql } from 'drizzle-orm';
import type { GuestRecoveryLimitAxis } from '@mercaria/shared-types';
import { guestRecoveryAttempts } from '../schema/guestPortal.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/**
 * Count one attempt on one axis and return the running total for its window.
 *
 * `INSERT … ON CONFLICT (axis, subject_hash, window_started_at) DO UPDATE SET
 * attempts = attempts + 1 RETURNING attempts` — ONE statement, so the count is
 * race-free across tasks. A read-then-write would let a burst of concurrent
 * requests each read the same value and all pass a limit they collectively
 * exceeded, which is precisely the shape a flood has.
 *
 * The caller decides the window boundary and compares the returned total to its
 * own ceiling, so "how many" is policy in config and "how to count" is here.
 */
export async function countRecoveryAttempt(
  db: DatabaseOrTransaction,
  input: { axis: GuestRecoveryLimitAxis; subjectHash: string; windowStartedAt: Date },
): Promise<number> {
  const [row] = await db
    .insert(guestRecoveryAttempts)
    .values({
      axis: input.axis,
      subjectHash: input.subjectHash,
      windowStartedAt: input.windowStartedAt,
    })
    .onConflictDoUpdate({
      target: [
        guestRecoveryAttempts.axis,
        guestRecoveryAttempts.subjectHash,
        guestRecoveryAttempts.windowStartedAt,
      ],
      set: { attempts: sql`${guestRecoveryAttempts.attempts} + 1` },
    })
    .returning({ attempts: guestRecoveryAttempts.attempts });
  if (row === undefined) {
    throw new Error('guest_recovery_attempts upsert returned no row');
  }
  return row.attempts;
}

/**
 * The current total on one axis WITHOUT counting an attempt.
 *
 * Exists for the realdb test that pins the window boundary: a read that
 * incremented would change the thing it is checking, and a test forced to
 * reason about its own side effects is a test nobody trusts.
 */
export async function readRecoveryAttempts(
  db: DatabaseOrTransaction,
  input: { axis: GuestRecoveryLimitAxis; subjectHash: string; windowStartedAt: Date },
): Promise<number> {
  const [row] = await db
    .select({ attempts: guestRecoveryAttempts.attempts })
    .from(guestRecoveryAttempts)
    .where(
      and(
        eq(guestRecoveryAttempts.axis, input.axis),
        eq(guestRecoveryAttempts.subjectHash, input.subjectHash),
        eq(guestRecoveryAttempts.windowStartedAt, input.windowStartedAt),
      ),
    )
    .limit(1);
  return row?.attempts ?? 0;
}
