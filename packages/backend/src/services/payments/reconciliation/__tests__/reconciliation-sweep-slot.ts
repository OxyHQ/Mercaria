/**
 * A real mutex over the GLOBALLY-DRIVEN reconciliation sweeps.
 *
 * `payment_discrepancies` is keyed `(kind, correlation_key)` and its recorder is
 * an UPSERT that REOPENS a resolved row — deliberately, because a sweep seeing a
 * finding somebody closed means the resolution did not hold. That is right in
 * production and it makes the table a shared resource between the parallel
 * realdb files that run against one throwaway database.
 *
 * ## What actually collides
 *
 * `reconciliation.realdb.test.ts` sets
 * `PAYMENT_RECONCILIATION_OPEN_PAYMENT_MIN_AGE_MS = '0'` so that a payable it
 * booked a moment ago is already old enough to sweep. The buffer is what keeps
 * buyers who are still paying out of the queue, and a test that waited ten real
 * minutes for it is a test nobody runs — so zeroing it is the only way to drive
 * these sweeps at all. But the buffer is the ONLY thing bounding
 * `auditOpenPayables`, which is an aggregate over the whole of `ledger_entries`:
 * with it at zero, one `auditLedgerPage({ cursor: null })` reports
 * `merchant_payable_unexplained` for EVERY unexplained open payable in the
 * database, under `correlationKey = <orderId>:<currency>` — including orders
 * belonging to a file that is running right now.
 *
 * `repairs.realdb.test.ts` is the file that owns those rows. It resolves a
 * finding through a real operator repair and asserts the resolution stands. When
 * the two overlap, the sweep's read STRADDLES the repair — the payable aggregate
 * is read while the transfer is still withheld, the explanation is re-read after
 * the repair has settled it, so the payable looks unexplained — and the upsert
 * puts the row back to `open` with `resolved_by` cleared. The assertion then
 * fails as `expected 'open' to be 'resolved'`, in the victim, naming nothing
 * about the cause.
 *
 * ## A Postgres ADVISORY LOCK, on a RESERVED connection
 *
 * The same device `active-policy-slot.ts` uses over the global active-matching-
 * policy slot, and for the same reasons: the lock has to outlive a transaction
 * (a file holds it for its whole run) and has to be released if the process
 * dies, which is exactly a session-level advisory lock. It is taken on a
 * connection nobody else can borrow — `sql.reserve()` — because a pooled
 * connection returned between statements would carry the lock away with it.
 *
 * Blocking in POSTGRES rather than in a retry loop is what makes the wait fair,
 * gives it no polling interval to tune, and stops two files livelocking into
 * taking turns failing. Postgres releases the lock when the session ends, so a
 * crashed run frees it without a sweeper.
 *
 * ## It is not a substitute for aiming a sweep
 *
 * Where a sweep CAN be aimed it is aimed instead, and this lock covers only what
 * is left. `reconcileOnePayment` is called directly wherever the subject is one
 * payment; the ledger audit's payment scan is driven from a cursor FLOOR so its
 * two global checks do not run at all. The one place that genuinely needs a
 * global payable sweep is the case asserting a withheld transfer SUPPRESSES a
 * finding — the claim is about what the sweep does not write, so a sweep that
 * never looked would pass it vacuously.
 *
 * ## The gate is keyed on the TABLE, not on the sweep — and THREE files drive one
 *
 * `reconciliation-sweep-slot.test.ts` fails the build if a realdb file starts
 * writing or reading `payment_discrepancies` without taking this lock. That is
 * the whole rule, and it is why the gate legitimately finds TWO holders while
 * three files drive a globally-widened sweep. Stating the third here rather than
 * leaving it to be inferred: a guard held by some claimants and skipped by
 * others is worse than no guard, so the exemption needs a reason and a trigger.
 *
 * `stripe/__tests__/account.service.realdb.test.ts:611` and `:625` and
 * `stripe/__tests__/stripe-ingress.realdb.test.ts:988` call
 * `reconcileStaleAccounts({ staleAfterMs: -1, … })`. That is the SAME widened
 * shape as the defect this lock exists for: `account-reconciler.ts:102` computes
 * `staleBefore = new Date(Date.now() - staleAfterMs)`, so a NEGATIVE age is
 * `now + 1 ms` and `findStaleProviderAccounts` selects EVERY stripe
 * `provider_accounts` row in the database, including a sibling file's.
 *
 * They still need no lock, for two measured reasons:
 *
 * 1. `account-reconciler.ts` contains ZERO `reportDiscrepancy(` calls. Reporting
 *    lives one layer up, in the #50 wrapper `reconcileAccountReadiness`
 *    (`account-readiness.job.ts`, 2 calls), and no realdb file drives that.
 * 2. A foreign row's sync THROWS before it can write. `syncAccountRow` is
 *    `retrieveStripeAccount` then `applyAccountSnapshot` — the read first, the
 *    write second — and both files' fakes throw
 *    `No fake account registered for <id>` for an id they did not register. The
 *    catch at `account-reconciler.ts:129-139` is `failed += 1`, an IN-MEMORY
 *    `observations.push` and a log line: no database write at all. So they burn
 *    a counter over foreign rows and mutate none of them.
 *
 * **The trigger that would change that**, either half of it:
 *
 * - a realdb file driving `reconcileAccountReadiness` (or `runReconciliationJob`,
 *   which dispatches to it) — that path DOES report, so it becomes a toucher and
 *   must hold this lock; or
 * - a fake that ANSWERS for an id it did not register. `syncAccountRow` would
 *   then reach `applyAccountSnapshot` and apply Stripe state to another file's
 *   account row — a write the two reasons above currently rule out, and the one
 *   that would make these files claimants rather than bystanders.
 */

import type { Database } from '../../../../db/postgres.js';

/**
 * The lock key. Arbitrary and stable; what matters is that every file that
 * touches `payment_discrepancies` uses the SAME one. Deliberately not
 * `active-policy-slot.ts`'s key — a file waiting on the matcher's slot must not
 * be made to wait on this one, and sharing a key is how two unrelated waits
 * become one queue.
 */
const RECONCILIATION_SWEEP_LOCK_KEY = 500_046_049;

/** What a holder releases. */
export interface ReconciliationSweepSlot {
  release(): Promise<void>;
}

/**
 * Wait for the reconciliation-sweep slot and hold it.
 *
 * Call it in `beforeAll` — after `connectPostgres()`, since it needs the pool —
 * and release it in `afterAll`.
 */
export async function acquireReconciliationSweepSlot(
  db: Database,
): Promise<ReconciliationSweepSlot> {
  // `db.$client` is the postgres.js instance drizzle wraps; `reserve()` takes a
  // connection OUT of the pool, which is what makes a session-level lock hold.
  const reserved = await db.$client.reserve();
  try {
    await reserved`select pg_advisory_lock(${RECONCILIATION_SWEEP_LOCK_KEY})`;
  } catch (error: unknown) {
    reserved.release();
    throw error;
  }
  return {
    async release(): Promise<void> {
      try {
        await reserved`select pg_advisory_unlock(${RECONCILIATION_SWEEP_LOCK_KEY})`;
      } finally {
        /**
         * Returning the connection to the pool. It does NOT end the hold.
         *
         * This comment used to claim the opposite — that a check-in ends the
         * session, so a broken unlock could not strand anybody. Measured
         * against a real server and it is false: `reserve()` checks a
         * connection OUT of the pool and `release()` checks it back IN, without
         * closing the socket, and a session-level advisory lock survives that.
         * Locks held after `pg_advisory_lock`: 1. After `release()` without
         * unlocking: 1. After `sql.end()`: 0.
         *
         * So the hold ends at `closePostgres()` (postgres.js `sql.end()`) or at
         * process exit, and NOTHING ELSE. A caller whose `pg_advisory_unlock`
         * throws must still reach `closePostgres()` — which is why every holder
         * releases inside a `try` whose `finally` closes the pool, rather than
         * trusting this line. `slot-teardown-census.test.ts` fails the build on
         * a holder that does not.
         *
         * `ingestion/__tests__/active-policy-slot.ts` carries the same
         * correction, for the same mechanism.
         */
        reserved.release();
      }
    },
  };
}
