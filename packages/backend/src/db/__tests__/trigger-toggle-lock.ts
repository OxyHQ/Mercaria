/**
 * The one mutex every realdb teardown takes before toggling a trigger.
 *
 * That sentence is enforced rather than promised, and this header is not where
 * it is checked: `db/__tests__/advisory-lock-census.test.ts` fails the build on
 * an `alter table … disable trigger` outside a `withTriggerToggleLock` callback
 * — or inside one but issued on `db`, which is the failure wearing the fix's
 * clothes — with no exemption available. It was NOT true when this module
 * landed (#275): ten files carried twenty-five windows taking no lock at all,
 * enumerated in an exact-count list here until #283 closed the last of them.
 * Nothing recomputes prose, which is why the claim above is a restatement of a
 * gate and not a fact this file asserts.
 *
 * ## A window is as narrow as it can be
 *
 * The transaction holds ACCESS EXCLUSIVE on every table it disables a trigger
 * on, and this mutex serializes it against every other trigger window in the
 * suite — so the callback carries the disable, the statements that genuinely
 * need that trigger off, and the matching enable, and nothing else. #283's
 * largest offender bracketed some 25 statements across three tables for most of
 * an `afterAll`; wrapping that span whole would have traded a leak for a
 * convoy. It is three one-statement windows now, with the unrelated deletes
 * between them running on the pool in the order they always did.
 *
 * The narrowest window is NO window, and five of the twenty-five turned out to
 * be that: a trigger declared `before update` cannot fire on a delete, so a
 * teardown that only deletes needs no escape and the toggle was deleted rather
 * than locked. Establish which events a trigger actually has — and, since a
 * delete matching zero rows passes whatever the trigger does, that the
 * statement it brackets affects rows — before deciding a window is load-bearing.
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

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../postgres.js';

/**
 * Whether a window is already open on THIS async call path.
 *
 * `AsyncLocalStorage` and not a module-level flag, because the two shapes it has
 * to tell apart look identical to one: a window awaited INSIDE another window's
 * callback deadlocks — the inner call opens a SECOND pooled connection and asks
 * for a transaction lock its own caller holds, so it is two sessions, Postgres
 * sees no cycle, and it blocks until the hook times out — while two windows
 * running CONCURRENTLY from one file are fine and are what the mutex is for.
 * A flag rejects both. The async context distinguishes them exactly.
 *
 * This is the runtime half of a rule `advisory-lock-census.test.ts` also states
 * lexically. Neither subsumes the other: the census catches the nesting a
 * reviewer can see in one file and fails the BUILD, and this catches the nesting
 * that only exists at run time — a window opened by a helper whose caller
 * already holds one, which is exactly the shape `adapter-contract-suite.ts`
 * would take, since several adapter test files invoke it.
 */
const OPEN_WINDOW = new AsyncLocalStorage<true>();

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
  if (OPEN_WINDOW.getStore() !== undefined) {
    // Would BLOCK, not fail: a second connection asking for a transaction lock
    // this call path already holds is two sessions, so no deadlock is detected
    // and the hook runs to its timeout. Naming it is the whole point.
    throw new Error(
      'withTriggerToggleLock is already open on this call path. A nested window opens a SECOND ' +
        'connection and waits for the transaction lock its own caller holds, which blocks until ' +
        'the hook times out rather than deadlocking. Close the outer window first, or move the ' +
        'inner statements into it.',
    );
  }
  return OPEN_WINDOW.run(true, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${TRIGGER_TOGGLE_LOCK_KEY})`);
      return window(tx);
    }),
  );
}
