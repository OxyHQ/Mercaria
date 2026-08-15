/**
 * The measurement behind #275, against a REAL PostgreSQL server.
 *
 * `db/__tests__/advisory-lock-census.test.ts` derives the RULE from the source
 * tree — a session-level advisory lock is issued on a reserved connection and a
 * transaction-scoped one inside a transaction — and a rule with no measurement
 * under it is a convention. This file is the measurement: it drives both
 * mistakes and both correct forms through the real driver and asserts what the
 * server actually reports.
 *
 * There is no mocked counterpart to any of it. `sql.reserve()`, `pg_locks`, an
 * unlock served by a different backend and a transaction-scoped lock released
 * by COMMIT are all properties of the server and the pool, and a mock would
 * report whatever it was told.
 *
 * ## Scoping
 *
 * Every assertion counts locks under THIS file's own key, drawn per run, and
 * never the database-wide total. The suite shares one server with every other
 * realdb file and two of them hold a session-level advisory lock for their
 * whole run, so an unscoped `count(*) from pg_locks where locktype='advisory'`
 * would read whatever the sibling that happens to overlap is holding — the
 * unscoped-aggregate failure `~/Oxy/AGENTS.md` names, which fails in the victim
 * and names nothing about the cause.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { withTriggerToggleLock } from './trigger-toggle-lock.js';

let db: Database;

/**
 * Keys nobody else uses, drawn per run.
 *
 * Advisory keys are database-wide, so a fixed constant would be a shared
 * resource with every sibling file — and one of these deliberately measures a
 * LEAKED lock, which is the worst thing to share. The range keeps them clear of
 * the keys this repository declares.
 *
 * TWO of them, and the split is load-bearing: the leak case cannot release what
 * it strands (see there), so a shared key would make every later assertion read
 * one higher than it should, in a file whose whole subject is counting locks.
 */
const PROBE_KEY = 900_000_000 + Math.floor(Math.random() * 45_000_000);
const LEAK_KEY = PROBE_KEY + 45_000_000;

/**
 * A table and a trigger belonging to the rollback case ALONE, named per run.
 *
 * The rollback case has to establish three states — enabled, disabled inside
 * the window, enabled again after the abort — and the first of those is only a
 * measurement if nothing else can move it. Toggled against a SHARED trigger it
 * is not: a sibling inside its own window makes `before` read `D`, and then
 * `after === before` holds whether or not the rollback happened, while the
 * positive control beside it (`insideWindow === 'D'`) passes for the same
 * reason. Control and measurement degrade together, which is the one thing a
 * control may not do.
 *
 * So the subject is created here and dropped here. The suffix is drawn per run
 * because realdb files share one server: two runs of this file must not be able
 * to name one object, and no other file can name this one at all.
 *
 * The table's key is a plain `integer` and deliberately NOT `serial` or
 * `generated as identity`: `services/__tests__/draft-order-complete.realdb.test.ts`
 * enumerates every sequence in the `public` schema and asserts an EXACT set of
 * two, so a sequence created here would fail THAT file — intermittently, on
 * whether the two happen to overlap, and naming nothing about this one. That is
 * the only exact-set catalogue assertion these objects could reach; every other
 * catalogue read in the suite is scoped by an explicit name list, and the
 * benchmark's unscoped size report asserts nothing and runs against its own
 * database.
 */
const PROBE_SUFFIX = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1_000_000).toString(36)}`;
const PROBE_TABLE = `advisory_lock_probe_${PROBE_SUFFIX}`;
const PROBE_FUNCTION = `advisory_lock_probe_fn_${PROBE_SUFFIX}`;
const PROBE_TRIGGER = `advisory_lock_probe_trg_${PROBE_SUFFIX}`;

/** Locks held on one of this file's keys, across every backend. */
async function locksHeld(key: number = PROBE_KEY): Promise<number> {
  const rows = await db.execute<{ held: string }>(
    sql`select count(*)::text as held from pg_locks where locktype = 'advisory' and objid = ${key}`,
  );
  const [row] = rows;
  return Number(row?.held ?? '-1');
}

/** Advisory locks held by ONE backend, whatever their keys. */
async function advisoryLocksOnPid(pid: number): Promise<number> {
  const rows = await db.execute<{ held: string }>(
    sql`select count(*)::text as held from pg_locks where locktype = 'advisory' and pid = ${pid}`,
  );
  const [row] = rows;
  return Number(row?.held ?? '-1');
}

/** The backend serving a statement on a given handle. */
async function backendPid(run: (statement: string) => Promise<{ pid: number }[]>): Promise<number> {
  const [row] = await run('select pg_backend_pid() as pid');
  return Number(row?.pid ?? -1);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  /**
   * Closing the pool IS the release, and that is the fact the second case
   * measures rather than an omission here.
   *
   * A leaked session lock lives on the socket that took it, so no statement
   * this file could issue is guaranteed to reach it — which is exactly why
   * `slot-teardown-census.test.ts` requires every holder to reach
   * `closePostgres()`. A pooled `pg_advisory_unlock` here would be the shape
   * this file exists to condemn, would only sometimes work, and would leave the
   * census with a second site to excuse.
   *
   * Nothing else can be affected while it is held: {@link LEAK_KEY} is drawn
   * per run, in a range no module in this repository declares.
   */
  await closePostgres();
});

describe('a SESSION-level advisory lock', () => {
  it('is not released by an unlock served through the pool', async () => {
    const reserved = await db.$client.reserve();
    try {
      await reserved`select pg_advisory_lock(${PROBE_KEY})`;
      expect(await locksHeld(), 'the lock was not taken at all').toBe(1);

      // The premise of the whole issue: `reserve()` takes a connection OUT of
      // the pool, so `db` provably cannot be the same backend. Asserted rather
      // than assumed — if it ever were the same, the "returned false" below
      // would be measuring nothing.
      const lockPid = await backendPid((statement) => reserved.unsafe(statement));
      const poolPid = await backendPid((statement) =>
        db.execute<{ pid: number }>(sql.raw(statement)),
      );
      expect(poolPid, 'the pool served the reserved connection').not.toBe(lockPid);

      const [pooled] = await db.execute<{ released: boolean }>(
        sql`select pg_advisory_unlock(${PROBE_KEY}) as released`,
      );
      expect(
        pooled?.released,
        'the pooled unlock reported success — this test can no longer measure the defect',
      ).toBe(false);
      expect(await locksHeld(), 'the pooled unlock actually released the lock').toBe(1);

      // And the correct form, on the session that took it.
      const [own] = await reserved<{ released: boolean }[]>`select pg_advisory_unlock(${PROBE_KEY}) as released`;
      expect(own?.released, 'the unlock on the holding session did not report success').toBe(true);
      expect(await locksHeld(), 'the lock survived its own session unlocking it').toBe(0);
    } finally {
      await reserved`select pg_advisory_unlock(${PROBE_KEY})`;
      reserved.release();
    }
  }, 60_000);

  it('survives the reserved connection being returned to the pool', async () => {
    // The correction #272 made to both slot helpers' docblocks, measured here
    // rather than asserted in prose: a check-in does not end the session, so
    // `release()` is not a substitute for the unlock and a holder whose unlock
    // throws still strands the lock until `closePostgres()`.
    const reserved = await db.$client.reserve();
    await reserved`select pg_advisory_lock(${LEAK_KEY})`;
    expect(await locksHeld(LEAK_KEY)).toBe(1);
    reserved.release();
    expect(await locksHeld(LEAK_KEY), 'checking the connection back in ended the hold').toBe(1);

    // Deliberately left held, on its OWN key. `reserve()` hands back an IDLE
    // connection and gives no way to ask for a NAMED one, so nothing here can
    // be sure of reaching the socket that holds it — which is the finding, not
    // a gap in the cleanup. It ends at this file's `closePostgres()`, and it can
    // affect nothing else because {@link LEAK_KEY} is drawn per run.
  }, 60_000);
});

describe('a TRANSACTION-scoped advisory lock', () => {
  it('is held for the whole window and gone the moment it commits', async () => {
    // Observed from the POOL while the transaction is open — a second backend,
    // which is the only vantage point from which "held right now" is a fact
    // rather than a claim the holder makes about itself.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${PROBE_KEY})`);
      expect(await locksHeld(), 'the transaction lock was not taken').toBe(1);
    });
    expect(await locksHeld(), 'the commit did not release the transaction lock').toBe(0);

    // And a ROLLBACK releases it too, which is what makes it impossible to
    // strand — the property the six teardowns #275 fixed did not have.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${PROBE_KEY})`);
        expect(await locksHeld()).toBe(1);
        throw new Error('the window threw');
      }),
    ).rejects.toThrow('the window threw');
    expect(await locksHeld(), 'the rollback did not release the transaction lock').toBe(0);
  }, 60_000);

  it('is really taken by the shipped helper, and released when it returns', async () => {
    // The helper's key is private, so this is scoped by the transaction's own
    // BACKEND PID, and read as a DELTA rather than a total: the case above
    // deliberately strands a session lock on a pooled socket, and the pool can
    // legitimately hand that same socket to this transaction. An absolute count
    // therefore reads the leak as well — measured, as `expected 2 to be 1`. The
    // difference cancels anything the backend was already holding.
    let holderPid = -1;
    let duringWindow = -1;
    await withTriggerToggleLock(db, async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holderPid = Number(row?.pid ?? -1);
      duringWindow = await advisoryLocksOnPid(holderPid);
    });
    expect(holderPid, 'the helper never ran its callback').toBeGreaterThan(0);
    const afterWindow = await advisoryLocksOnPid(holderPid);
    expect(
      duringWindow - afterWindow,
      'the shared helper opened a transaction and took no advisory lock in it',
    ).toBe(1);
  }, 60_000);

  it('rolls a trigger toggle back when the window throws', async () => {
    // The second defect the six files carried, and the reason the remedy is a
    // transaction rather than a reserved connection. `alter table … disable
    // trigger` is DDL, so on the pool it commits on its own and a throw before
    // the re-enable leaves it off for every other file in the run. Inside a
    // transaction it rolls back with everything else.
    //
    // The subject is this file's OWN trigger, created two statements from here
    // and dropped in the `finally` — see {@link PROBE_TRIGGER} for why an
    // exclusive one is what makes the three assertions below measurements
    // rather than a tautology. It also narrows the ShareRowExclusive the window
    // takes to a table nothing else reads.
    const TRIGGER_STATE = sql`select tgenabled as state from pg_trigger where tgname = ${PROBE_TRIGGER}`;
    const enabled = async (): Promise<string> => {
      const [row] = await db.execute<{ state: string }>(TRIGGER_STATE);
      return row?.state ?? 'missing';
    };

    await db.execute(sql`create table ${sql.raw(PROBE_TABLE)} (id integer primary key)`);
    try {
      // A trigger has to DO something to be one, and raising is the cheapest
      // thing that is unmistakably a trigger body. Nothing ever writes to the
      // table, so it never fires: `tgenabled` is the whole of what is read.
      await db.execute(sql`
        create function ${sql.raw(PROBE_FUNCTION)}() returns trigger language plpgsql as $probe$
        begin
          raise exception 'advisory-lock probe trigger fired';
        end;
        $probe$
      `);
      await db.execute(
        sql`create trigger ${sql.raw(PROBE_TRIGGER)} before update on ${sql.raw(PROBE_TABLE)} for each row execute function ${sql.raw(PROBE_FUNCTION)}()`,
      );

      // Asserted as `O` outright, which is available precisely because no
      // sibling can reach this trigger. It is also the vacuity floor: a
      // `create trigger` that silently did nothing reads `missing` here.
      expect(await enabled(), 'the probe trigger was not created enabled').toBe('O');

      let insideWindow = 'unread';
      await expect(
        withTriggerToggleLock(db, async (tx) => {
          await tx.execute(
            sql`alter table ${sql.raw(PROBE_TABLE)} disable trigger ${sql.raw(PROBE_TRIGGER)}`,
          );
          // The positive control on the MUTATION: read back inside the same
          // transaction, which sees its own uncommitted DDL. Without it, a
          // `disable` that silently did nothing would make the assertion below
          // pass by measuring a state that never moved.
          const [row] = await tx.execute<{ state: string }>(TRIGGER_STATE);
          insideWindow = row?.state ?? 'missing';
          throw new Error('the teardown threw between disable and enable');
        }),
      ).rejects.toThrow('the teardown threw between disable and enable');

      expect(insideWindow, 'the disable inside the window did nothing').toBe('D');
      expect(await enabled(), 'the aborted window left the trigger disabled database-wide').toBe(
        'O',
      );
    } finally {
      // Runs when the case FAILS too, which is the point: a stranded probe
      // trigger is a `pg_trigger` row every later run of this file would have
      // to tell apart from its own.
      await db.execute(sql`drop trigger if exists ${sql.raw(PROBE_TRIGGER)} on ${sql.raw(PROBE_TABLE)}`);
      await db.execute(sql`drop function if exists ${sql.raw(PROBE_FUNCTION)}()`);
      await db.execute(sql`drop table if exists ${sql.raw(PROBE_TABLE)}`);
    }
  }, 60_000);

  it('refuses a nested window instead of blocking on a lock it already holds', async () => {
    // The failure this replaces has no error and no log line: the inner call
    // takes a SECOND connection out of the pool and asks for a transaction lock
    // the outer one holds, which is two sessions — so Postgres sees no cycle,
    // its deadlock detector never fires, and the hook runs to its timeout. The
    // assertion is therefore that this REJECTS; a regression makes the case time
    // out rather than fail, which is itself the symptom.
    //
    // `advisory-lock-census.test.ts` states the same rule lexically. Neither
    // subsumes the other: that one fails the BUILD on nesting a reviewer could
    // see, this one covers nesting that exists only at run time, when the inner
    // window is opened by a helper whose caller already holds one.
    await expect(
      withTriggerToggleLock(db, async () => {
        await withTriggerToggleLock(db, async (inner) => {
          await inner.execute(sql`select 1`);
        });
      }),
    ).rejects.toThrow(/already open on this call path/u);
  }, 60_000);

  it('allows two windows to run CONCURRENTLY, which is what the mutex is for', async () => {
    // The control on the guard above, and the reason it is an async-context
    // store rather than a flag: a flag cannot tell a nested window from a
    // concurrent one and would refuse this, which is legitimate and serialized
    // by the mutex exactly as intended. Both must succeed.
    const order: string[] = [];
    await Promise.all([
      withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql`select 1`);
        order.push('a');
      }),
      withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql`select 1`);
        order.push('b');
      }),
    ]);
    expect(order.sort()).toEqual(['a', 'b']);
  }, 60_000);

});
