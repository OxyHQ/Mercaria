/**
 * The one mutex a realdb teardown takes before toggling a trigger — where one
 * is taken at all. It is NOT yet true that every such teardown takes one.
 *
 * ## The exception, stated rather than implied
 *
 * Not every teardown that opens such a window takes this lock yet. Which ones
 * do not is #283's, and this header deliberately does not say: the SINGLE
 * authority is `UNLOCKED_TRIGGER_WINDOWS` in
 * `db/__tests__/advisory-lock-census.test.ts`, an exact-count exemption list
 * whose own length is asserted, so the gap cannot widen and closing one means
 * deleting an entry. That list is MEASURED, by running the rule with an empty
 * list. The enumeration this header used to carry was counted by hand instead,
 * and was wrong in both directions — which is what a second copy of a census is
 * for, since nothing recomputes prose.
 *
 * They are exempted rather than fixed because the largest of them spans most of
 * an `afterAll`: one transaction over that window holds ACCESS EXCLUSIVE on
 * three tables for a whole teardown, which trades a leak for a convoy and is a
 * decision rather than a mechanical edit.
 *
 * ## What it guards
 *
 * `alter table … disable trigger` is DATABASE-WIDE and every realdb file in a
 * suite run shares one server, so two files inside a disable/delete/enable
 * window at the same time leave one of them deleting against a trigger the
 * other has just switched back on. Measured twice: as a `23514` naming
 * `catalog_revisions is append-only` on a file's own DELETE, and as a teardown
 * failure naming a trigger the test had disabled two statements earlier. Which
 * files overlap is decided by vitest's size-ordered file list, so adding any
 * test anywhere re-rolls it.
 *
 * The key's VALUE means nothing; its SAMENESS across every file that opens such
 * a window is the whole mechanism. It used to be declared in NINE files under
 * three names — the literal `6820068`, `POLICY_TEARDOWN_LOCK` and
 * `TEARDOWN_TRIGGER_LOCK` — which is nine representations of one fact, and the
 * one thing that must never drift. It lives here now, once (#275).
 *
 * ## Why a TRANSACTION-scoped lock, and not a session-level one
 *
 * `pg_advisory_lock`/`pg_advisory_unlock` is a SESSION-level pair, and
 * postgres.js POOLS: the unlock can be served by a different backend from the
 * one that took the lock, in which case it returns **false** and the lock
 * survives until that connection closes. Six files issued exactly that pair
 * through `db.execute` and none of them read the boolean (#275). A session-level
 * lock is therefore only safe on a connection nobody else can borrow —
 * `sql.reserve()`, which is what `services/ingestion/__tests__/active-policy-slot.ts`
 * and `services/payments/reconciliation/__tests__/reconciliation-sweep-slot.ts`
 * do, because their hold spans a whole FILE and no transaction could.
 *
 * A trigger-toggle window is the other case: it begins and ends inside one
 * teardown hook, so a transaction can hold it and `pg_advisory_xact_lock` is
 * released by the COMMIT or the ROLLBACK, on the connection that took it,
 * including when a statement in the window throws. There is no boolean to
 * discard and no way to strand it. It is the same lock in the same lock space
 * as the session-level pair, so it still interlocks with those two holds.
 *
 * ## The second thing the transaction fixes
 *
 * The six files ran the window on the POOL, so `alter table … disable trigger`
 * COMMITTED on its own. A throw between the disable and the enable therefore
 * left the trigger disabled DATABASE-WIDE for the rest of the run — the unlock
 * was in a `finally`, the re-enable was not — and every later file asserting
 * that trigger refuses a write would have passed vacuously. Inside a
 * transaction the DDL rolls back with everything else, so an aborted window
 * restores the trigger rather than dropping it.
 *
 * ## Using it
 *
 * ```ts
 * await withTriggerToggleLock(db, async (tx) => {
 *   await tx.execute(sql`alter table x disable trigger t`);
 *   await tx.delete(x).where(…);
 *   await tx.execute(sql`alter table x enable trigger t`);
 * });
 * ```
 *
 * `db/__tests__/advisory-lock-census.test.ts` fails the build on an advisory
 * lock issued on the wrong kind of handle, in either direction.
 */

import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../postgres.js';

/**
 * The lock key. Arbitrary and stable; see the header for why it lives in
 * exactly one place. `advisory-lock-census.test.ts` asserts no other module
 * declares it.
 */
const TRIGGER_TOGGLE_LOCK_KEY = 6_820_068;

/**
 * Run `window` inside a transaction holding the trigger-toggle lock.
 *
 * The lock is the transaction's FIRST statement, so nothing this transaction
 * has already touched can be in a lock-wait when it asks for it — which is what
 * keeps two teardowns queueing rather than deadlocking.
 */
export async function withTriggerToggleLock<T>(
  db: Database,
  window: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${TRIGGER_TOGGLE_LOCK_KEY})`);
    return window(tx);
  });
}
