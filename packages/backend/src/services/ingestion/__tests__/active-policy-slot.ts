/**
 * A real mutex over the GLOBAL active-matching-policy slot.
 *
 * `match_policy_versions_active_key` is a partial unique with NO scoping
 * column — ONE active policy in the whole database. That is correct for
 * production and it makes the slot a shared resource between the parallel
 * realdb files that run against one throwaway database.
 *
 * Two files could get away with retry-and-hope. THREE cannot, and #63 made it
 * three (`matching-writes.realdb.test.ts` plus the two adapter-contract
 * runners). The failures it produces are not the honest "somebody else holds the
 * slot" — they are a file inserting a `match_decisions` row whose policy another
 * file has just deleted, and a wait that outlives vitest's own per-test timeout.
 * Both land on a file that did nothing wrong, which is the shape that gets a
 * suite marked flaky and then ignored.
 *
 * ## A Postgres ADVISORY LOCK, on a RESERVED connection
 *
 * The lock has to outlive a transaction (a file holds the slot for its whole
 * run) and it has to be released if the process dies, which is exactly a
 * session-level advisory lock. It must therefore be taken on a connection nobody
 * else can borrow — `sql.reserve()` — because a pooled connection returned
 * between statements would carry the lock away with it.
 *
 * Postgres releases the lock when the session ends, so a crashed run frees it
 * without a sweeper.
 */

import type { Database } from '../../../db/postgres.js';

/**
 * The lock key. Arbitrary and stable; what matters is that every file that
 * wants the slot uses the SAME one.
 */
const ACTIVE_POLICY_LOCK_KEY = 630_620_058;

/** What a holder releases. */
export interface ActivePolicySlot {
  release(): Promise<void>;
}

/**
 * Wait for the global active-policy slot and hold it.
 *
 * Blocks in POSTGRES rather than in a retry loop, so the wait is fair, has no
 * polling interval to tune, and cannot livelock two files into taking turns
 * failing. Call it in `beforeAll` and release in `afterAll`.
 */
export async function acquireActivePolicySlot(db: Database): Promise<ActivePolicySlot> {
  // `db.$client` is the postgres.js instance drizzle wraps; `reserve()` takes a
  // connection OUT of the pool, which is what makes a session-level lock hold.
  const reserved = await db.$client.reserve();
  try {
    await reserved`select pg_advisory_lock(${ACTIVE_POLICY_LOCK_KEY})`;
  } catch (error: unknown) {
    reserved.release();
    throw error;
  }
  return {
    async release(): Promise<void> {
      try {
        await reserved`select pg_advisory_unlock(${ACTIVE_POLICY_LOCK_KEY})`;
      } finally {
        // Returning the connection ends the session's hold even if the unlock
        // itself failed, so a broken release cannot strand every other file.
        reserved.release();
      }
    },
  };
}
