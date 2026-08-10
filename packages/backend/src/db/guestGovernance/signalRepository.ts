/**
 * The security signal counters (#111 "Security monitoring").
 *
 * One count per signal per window and nothing else. There is no subject column
 * on the table and no function here takes one, which is the whole reason the
 * monitoring surface can exist at all: the alternative — a row per failed
 * verification — is both a log of unconsented activity and an amplification
 * primitive whose volume an attacker chooses.
 */

import { and, desc, gte, lt, sql } from 'drizzle-orm';
import type { GuestSecuritySignal } from '@mercaria/shared-types';
import { guestSecuritySignalCounters } from '../schema/guestGovernance.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/**
 * Count one observation of one signal.
 *
 * The counter upsert, again — one statement, race-free across tasks. It takes a
 * DELTA rather than always incrementing by one because two of the fifteen
 * signals are measured by a SWEEP that counts a backlog (`cleanup_lag`,
 * `payment_verified_portal_initialization_lag`), and a sweep looping to add one
 * per row would turn a bounded observation into an unbounded write.
 */
export async function countSecuritySignal(
  db: DatabaseOrTransaction,
  input: { signal: GuestSecuritySignal; windowStartedAt: Date; delta: number },
): Promise<number> {
  const [row] = await db
    .insert(guestSecuritySignalCounters)
    .values({
      signal: input.signal,
      windowStartedAt: input.windowStartedAt,
      observationCount: input.delta,
    })
    .onConflictDoUpdate({
      target: [guestSecuritySignalCounters.signal, guestSecuritySignalCounters.windowStartedAt],
      set: {
        observationCount: sql`${guestSecuritySignalCounters.observationCount} + ${input.delta}`,
      },
    })
    .returning({ observationCount: guestSecuritySignalCounters.observationCount });
  if (row === undefined) {
    throw new Error('guest_security_signal_counters upsert returned no row');
  }
  return row.observationCount;
}

/** One signal's total over a range. */
export interface SignalTotal {
  readonly signal: GuestSecuritySignal;
  readonly total: number;
  readonly windows: number;
  readonly latestWindowStartedAt: Date | null;
}

/**
 * Every signal's total over a range, for the monitoring surface.
 *
 * Returns rows only for signals that were OBSERVED, and the caller fills the
 * rest in as zero from the register. That order matters: reading the register
 * first and joining counts onto it makes a signal that has never been recorded
 * indistinguishable from one recorded as zero, and only one of those is a fact
 * about the deployment.
 */
export async function readSignalTotals(
  db: DatabaseOrTransaction,
  input: { since: Date; until: Date },
): Promise<readonly SignalTotal[]> {
  const rows = await db
    .select({
      signal: guestSecuritySignalCounters.signal,
      total: sql<number>`sum(${guestSecuritySignalCounters.observationCount})::int`,
      windows: sql<number>`count(*)::int`,
      latestWindowStartedAt: sql<Date>`max(${guestSecuritySignalCounters.windowStartedAt})`,
    })
    .from(guestSecuritySignalCounters)
    .where(
      and(
        gte(guestSecuritySignalCounters.windowStartedAt, input.since),
        lt(guestSecuritySignalCounters.windowStartedAt, input.until),
      ),
    )
    .groupBy(guestSecuritySignalCounters.signal)
    .orderBy(desc(sql`sum(${guestSecuritySignalCounters.observationCount})`));
  return rows.map((row) => ({
    signal: row.signal as GuestSecuritySignal,
    // `sum()` over a bigint-free integer column still arrives as a string
    // through postgres.js on some shapes, so the cast is in the SQL and this
    // coercion is the belt: the #61 finding says never to rely on the inferred
    // TypeScript type for an aggregate.
    total: Number(row.total),
    windows: Number(row.windows),
    latestWindowStartedAt: row.latestWindowStartedAt ?? null,
  }));
}
