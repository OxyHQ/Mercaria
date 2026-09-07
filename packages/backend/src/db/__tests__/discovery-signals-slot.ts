/**
 * A real mutex over `discovery_signals`, whose WINDOW is a global resource.
 *
 * ## What actually collides
 *
 * `replaceWindow` deletes `window = '30d'` — the whole window, every scope —
 * and re-inserts a run's output in ONE transaction. That is the behaviour the
 * design specifies and the repository's docblock promises ("a subject that
 * stopped selling disappears instead of keeping last month's figure forever"),
 * and it is the only shape that clears a category which has gone QUIET: a
 * scope with no counted listing this run contributes no key, so a delete
 * narrowed to the scopes a run touched can never reach it and its month-old
 * counts serve forever.
 *
 * `DISCOVERY_WINDOWS` has one member, so "the window" is "the table". Every
 * realdb file that seeds a `discovery_signals` row and then reads it back is
 * therefore reading a resource any sweep in a sibling file can empty between
 * the two statements — which surfaces as a shelf that is mysteriously missing
 * from an assembled feed, in the victim, naming nothing about the cause.
 *
 * A narrower production delete would remove the collision and reintroduce the
 * defect. So the isolation belongs in the fixtures, which is where this is.
 *
 * ## A Postgres ADVISORY LOCK, on a RESERVED connection
 *
 * The same device `services/payments/reconciliation/__tests__/reconciliation-sweep-slot.ts`
 * and `services/ingestion/__tests__/active-policy-slot.ts` use, for the same
 * reasons: the hold spans a whole FILE, so no transaction can carry it, and it
 * must be released if the process dies — which is exactly a session-level
 * advisory lock. It is taken on a connection nobody else can borrow
 * (`sql.reserve()`), because a pooled connection returned between statements
 * would carry the lock away with it and the unlock would come back **false**.
 *
 * Blocking in POSTGRES rather than in a retry loop is what makes the wait fair
 * and gives it no polling interval to tune.
 *
 * ## Who has to hold it
 *
 * Every realdb file that WRITES a `discovery_signals` row or drives something
 * that does — the sweep itself (`services/__tests__/discovery-sweep.realdb.test.ts`,
 * `routes/__tests__/internal-discovery.realdb.test.ts`, which forces a run over
 * HTTP), `replaceWindow` directly (`db/__tests__/discovery-signal-repository.realdb.test.ts`),
 * and the three files that seed rows and read them back
 * (`db/__tests__/discovery-read-repository.realdb.test.ts`,
 * `db/__tests__/discovery-schema.realdb.test.ts`,
 * `services/__tests__/discovery-feed.realdb.test.ts`).
 *
 * `routes/__tests__/discovery-route.realdb.test.ts` deliberately does NOT: it
 * asserts status codes and section-array shapes and never seeds a signal, so an
 * emptied table changes none of its outcomes.
 */

import type { Database } from '../postgres.js';

/**
 * The lock key. Arbitrary and stable; what matters is that every file that
 * touches `discovery_signals` uses the SAME one. Deliberately not the
 * active-policy or reconciliation-sweep keys — a file waiting on this window
 * must not be made to wait on an unrelated queue, and sharing a key is how two
 * unrelated waits become one.
 */
const DISCOVERY_SIGNALS_LOCK_KEY = 470_154_030;

/** What a holder releases. */
export interface DiscoverySignalsSlot {
  release(): Promise<void>;
}

/**
 * Wait for the `discovery_signals` slot and hold it.
 *
 * Call it in `beforeAll` — after `connectPostgres()`, since it needs the pool —
 * and release it in `afterAll` inside a `try` whose `finally` calls
 * `closePostgres()`. `db/__tests__/slot-teardown-census.test.ts` fails the
 * build on a holder that does not, and the reason is measured (#272): checking
 * the connection back in does NOT end the session, so a release that throws
 * would otherwise abort the hook one statement short of the only thing that
 * frees the slot, and every other claimant would block its full `beforeAll`
 * budget.
 */
export async function acquireDiscoverySignalsSlot(db: Database): Promise<DiscoverySignalsSlot> {
  // `db.$client` is the postgres.js instance drizzle wraps; `reserve()` takes a
  // connection OUT of the pool, which is what makes a session-level lock hold.
  const reserved = await db.$client.reserve();
  try {
    await reserved`select pg_advisory_lock(${DISCOVERY_SIGNALS_LOCK_KEY})`;
  } catch (error: unknown) {
    reserved.release();
    throw error;
  }
  return {
    async release(): Promise<void> {
      try {
        // The boolean is READ, and a `false` is a defect (#275): the unlock did
        // not run on the session that took the lock, which is precisely what a
        // pooled unlock produces. `reconciliation-sweep-slot.ts` carries the
        // full reasoning for the same mechanism.
        const [row] = await reserved<
          { released: boolean }[]
        >`select pg_advisory_unlock(${DISCOVERY_SIGNALS_LOCK_KEY}) as released`;
        if (row?.released !== true) {
          throw new Error(
            `pg_advisory_unlock(${DISCOVERY_SIGNALS_LOCK_KEY}) returned ${String(
              row?.released,
            )}: the unlock did not run on the session that took the lock, so the slot is held until the pool closes`,
          );
        }
      } finally {
        // Returning the connection to the pool. It does NOT end the hold — the
        // session, and the lock, survive a check-in and end only at
        // `closePostgres()` (postgres.js `sql.end()`) or process exit. Measured
        // in #272; both sibling slots carry the same correction.
        reserved.release();
      }
    },
  };
}
