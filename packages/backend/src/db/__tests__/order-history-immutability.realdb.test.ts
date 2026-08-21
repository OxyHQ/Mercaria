/**
 * EXECUTING the order-history dispositions against a real server — the half of
 * epic #367's "No historical commerce snapshot is rewritten" that a declaration
 * cannot supply.
 *
 * `order-history-census.test.ts` proves the LEDGER covers every table that names
 * an order. That census would pass unchanged against a database with no triggers
 * at all, so on its own it measures a list rather than a schema. This file asks
 * the database what it actually does.
 *
 * ## The instrument, and what it can and cannot testify to
 *
 * For each table it builds a TEMP clone of the real column layout, replicates
 * onto it every real trigger that fires on UPDATE or DELETE — timing, events,
 * level and function all read from `pg_trigger` on the REAL table — inserts a
 * skeleton row, and then attempts the write. So what is measured is the real
 * function under the real wiring, and a trigger that was dropped, rewired to the
 * wrong events, disabled, or whose body was replaced with `RETURN NEW` all show
 * up as `allowed`.
 *
 * It is a clone rather than the table itself for one reason: the alternative is
 * stripping the real table's constraints so a skeleton row can exist, which
 * takes ACCESS EXCLUSIVE on `orders` and every table around it while sibling
 * realdb files are using them — the lock-convoy hazard `~/Oxy/AGENTS.md` records
 * against `DISABLE TRIGGER`. Temp tables take locks on nothing shared, so this
 * file is safe on the suite's shared database and needs no throwaway one.
 *
 * What it therefore cannot testify to: a trigger whose body reads the REAL table
 * by name sees an empty clone row, so a CONDITIONAL delete guard
 * (`retail_order_role_snapshots` refuses DELETE only while its order exists)
 * correctly reports `allowed` here. The ledger says `allowed` for exactly those
 * and names the condition in its reason. Both probes were cross-validated
 * against a second, independent instrument that DID strip the real tables'
 * constraints on a private database: 56 of 57 tables agreed exactly, and the one
 * difference was the other instrument failing to build a fixture at all.
 *
 * ## The vacuity discipline
 *
 * A probe that silently measured nothing would report every table `allowed`,
 * which is indistinguishable from a schema with no protection — so:
 *
 *  - the observed refusals are floored, in both directions and for columns;
 *  - the closure is derived a SECOND time here, from `pg_constraint`, and must
 *    equal the drizzle-derived one the ledger was checked against, so the schema
 *    and the migrations cannot drift apart unnoticed;
 *  - a MUTATION SELF-TEST builds the same clone WITHOUT the triggers and asserts
 *    the write is then allowed, which is what proves the refusal came from the
 *    trigger rather than from anything else the clone happens to carry;
 *  - a second self-test probes a column that is NOT declared frozen on a table
 *    that has frozen columns, and asserts it is allowed — so the column probe is
 *    known to be capable of reporting something other than "refused".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import {
  ORDER_HISTORY_DISPOSITIONS,
  ORDER_HISTORY_ROOT_TABLE,
  orderHistoryDispositionFor,
} from '../orderHistoryDispositions.js';

let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/**
 * What one table's row-level probe observed.
 *
 * `extends Record<string, unknown>` because that is the constraint drizzle puts
 * on `execute`'s row type; it is the house spelling (`FacetBucketRow` in
 * `db/attributes/attributeOpsRepository.ts`), not a widening.
 */
interface RowProbe extends Record<string, unknown> {
  readonly tbl: string;
  readonly trigs: number;
  readonly upd: string;
  readonly del: string;
}

/** What one column's probe observed. */
interface ColumnProbe extends Record<string, unknown> {
  readonly tbl: string;
  readonly col: string;
  readonly verdict: string;
}

/**
 * The population, derived a second time — from `pg_constraint` rather than from
 * the drizzle objects.
 *
 * Two derivations of one fact agreeing is not a measurement when both read the
 * same source; these read DIFFERENT sources. The drizzle walk is what will be
 * generated; this is what was applied. A migration that added a foreign key by
 * hand, or a `references()` drizzle-kit silently dropped (it has done, on a
 * circular one), shows up here and nowhere else.
 */
const CLOSURE_SQL = `
  with recursive fk as (
    select cl.relname as child, f.relname as parent
    from pg_constraint k
    join pg_class cl on cl.oid = k.conrelid
    join pg_class f on f.oid = k.confrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where k.contype = 'f' and n.nspname = 'public'
  ), closure(tname) as (
    select '${ORDER_HISTORY_ROOT_TABLE}'::name
    union
    select fk.child from fk join closure on fk.parent = closure.tname
    where fk.child <> closure.tname
  )
  select tname from closure
`;

/**
 * Build a clone of one table, optionally wired with its real UPDATE/DELETE
 * triggers, and leave it as `pg_temp.probe_clone`.
 *
 * `replicate` false is the mutation self-test's path — the same clone with
 * nothing attached.
 */
function cloneSql(replicate: boolean): string {
  return `
    execute format('create temp table probe_clone (like public.%I) on commit drop', target);
    for col in
      select attname from pg_attribute
      where attrelid = 'pg_temp.probe_clone'::regclass and attnum > 0
        and not attisdropped and attnotnull and attgenerated = ''
    loop
      execute format('alter table pg_temp.probe_clone alter column %I drop not null', col.attname);
    end loop;
    ${
      replicate
        ? `
    for trg in
      select x.tgname, p.oid::regprocedure as fn,
             case when (x.tgtype::int & 2) > 0 then 'before' else 'after' end as timing,
             array_to_string(array_remove(array[
               case when (x.tgtype::int & 4) > 0 then 'insert' end,
               case when (x.tgtype::int & 8) > 0 then 'delete' end,
               case when (x.tgtype::int & 16) > 0 then 'update' end], null), ' or ') as events,
             case when (x.tgtype::int & 1) > 0 then 'for each row' else 'for each statement' end as lvl,
             x.tgenabled
      from pg_trigger x
      join pg_proc p on p.oid = x.tgfoid
      where x.tgrelid = format('public.%I', target)::regclass
        and not x.tgisinternal
        and (x.tgtype::int & 24) > 0
    loop
      -- A trigger disabled with ALTER TABLE ... DISABLE TRIGGER enforces
      -- nothing, so it is deliberately NOT replicated: the probe must report
      -- what the real table does, not what its DDL would do if it were on.
      if trg.tgenabled <> 'O' then continue; end if;
      execute format('create trigger %I %s %s on pg_temp.probe_clone %s execute function %s',
                     trg.tgname, trg.timing, trg.events, trg.lvl, trg.fn);
      ntrig := ntrig + 1;
    end loop;`
        : ''
    }
  `;
}

/**
 * Probe every table in the closure for a no-op UPDATE and a DELETE.
 *
 * The UPDATE sets every column to the value it already holds. That is
 * deliberate: it separates a table whose every row is frozen from one that
 * freezes named columns, which a value-CHANGING probe reports identically.
 */
const ROW_PROBE_SQL = `
do $probe$
declare
  target name;
  col record;
  trg record;
  setlist text;
  ntrig int;
  upd_state text;
  del_state text;
begin
  create temp table probe_rows(tbl name, trigs int, upd text, del text) on commit drop;
  for target in ${CLOSURE_SQL} order by 1 loop
    ntrig := 0;
    ${cloneSql(true)}
    execute 'insert into pg_temp.probe_clone default values';
    select string_agg(format('%I = %I', attname, attname), ', ') into setlist
    from pg_attribute
    where attrelid = 'pg_temp.probe_clone'::regclass and attnum > 0
      and not attisdropped and attgenerated = '' and attidentity = '';
    if setlist is null then
      raise exception 'probe_clone for % has no updatable column', target;
    end if;
    begin
      execute format('update pg_temp.probe_clone set %s', setlist);
      upd_state := 'allowed';
    exception when others then
      upd_state := 'refused';
    end;
    begin
      execute 'delete from pg_temp.probe_clone';
      del_state := 'allowed';
    exception when others then
      del_state := 'refused';
    end;
    insert into probe_rows values (target, ntrig, upd_state, del_state);
    execute 'drop table pg_temp.probe_clone';
  end loop;
end
$probe$;
`;

/**
 * Probe each declared frozen column by changing it from one value to another
 * distinct value.
 *
 * Both spellings the schema uses are covered by that one move: the plain
 * `NEW IS DISTINCT FROM OLD` freeze and the write-once
 * `OLD IS NOT NULL AND NEW IS DISTINCT FROM OLD`. Inserting NULL and setting a
 * value would miss every write-once column, which is most of the interesting
 * ones.
 *
 * An unmapped column type RAISES rather than being skipped. A skip is how a
 * frozen column silently stops being checked the day somebody declares one of a
 * new type.
 */
const COLUMN_PROBE_SQL = `
do $probe$
declare
  target name;
  col record;
  trg record;
  ntrig int;
  first_value text;
  second_value text;
  verdict text;
begin
  create temp table probe_columns(tbl name, col name, verdict text) on commit drop;
  for target in select distinct tbl from probe_column_plan order by 1 loop
    ntrig := 0;
    ${cloneSql(true)}
    for col in
      select p.col as name, t.typname
      from probe_column_plan p
      join pg_attribute a on a.attrelid = 'pg_temp.probe_clone'::regclass and a.attname = p.col
      join pg_type t on t.oid = a.atttypid
      where p.tbl = target
      order by p.col
    loop
      case col.typname
        when 'text' then first_value := '''probe-a'''; second_value := '''probe-b''';
        when 'int4' then first_value := '1'; second_value := '2';
        when 'int8' then first_value := '1'; second_value := '2';
        when 'timestamptz' then
          first_value := '''2020-01-01T00:00:00Z''::timestamptz';
          second_value := '''2021-01-01T00:00:00Z''::timestamptz';
        when 'uuid' then
          first_value := '''00000000-0000-0000-0000-000000000001''::uuid';
          second_value := '''00000000-0000-0000-0000-000000000002''::uuid';
        when 'bool' then first_value := 'false'; second_value := 'true';
        else
          raise exception
            'no probe values for %.% of type % — add a pair rather than skipping it, or the column stops being checked',
            target, col.name, col.typname;
      end case;

      execute 'delete from pg_temp.probe_clone';
      execute format('insert into pg_temp.probe_clone (%I) values (%s)', col.name, first_value);
      begin
        execute format('update pg_temp.probe_clone set %I = %s', col.name, second_value);
        verdict := 'allowed';
      exception when others then
        verdict := 'refused';
      end;
      insert into probe_columns values (target, col.name, verdict);
    end loop;
    execute 'drop table pg_temp.probe_clone';
  end loop;
end
$probe$;
`;

/** The self-test: the same clone with no triggers attached at all. */
const UNWIRED_PROBE_SQL = `
do $probe$
declare
  target name;
  col record;
  setlist text;
  upd_state text;
  del_state text;
begin
  create temp table probe_unwired(tbl name, trigs int, upd text, del text) on commit drop;
  for target in select tbl from probe_unwired_plan order by 1 loop
    ${cloneSql(false)}
    execute 'insert into pg_temp.probe_clone default values';
    select string_agg(format('%I = %I', attname, attname), ', ') into setlist
    from pg_attribute
    where attrelid = 'pg_temp.probe_clone'::regclass and attnum > 0
      and not attisdropped and attgenerated = '' and attidentity = '';
    begin
      execute format('update pg_temp.probe_clone set %s', setlist);
      upd_state := 'allowed';
    exception when others then
      upd_state := 'refused';
    end;
    begin
      execute 'delete from pg_temp.probe_clone';
      del_state := 'allowed';
    exception when others then
      del_state := 'refused';
    end;
    insert into probe_unwired values (target, 0, upd_state, del_state);
    execute 'drop table pg_temp.probe_clone';
  end loop;
end
$probe$;
`;

/**
 * Everything the probes observed, gathered in ONE transaction.
 *
 * One transaction because a temp table belongs to a CONNECTION and the pool
 * hands out whichever is free; a transaction is what pins them to the same one.
 * Nothing outside `pg_temp` is written, and every temp table is
 * `on commit drop`, so this leaves the shared database exactly as it found it.
 */
interface Probes {
  readonly closure: readonly string[];
  readonly rows: readonly RowProbe[];
  readonly columns: readonly ColumnProbe[];
  readonly unwired: readonly RowProbe[];
}

async function runProbes(): Promise<Probes> {
  return db.transaction(async (tx) => {
    const closureRows = await tx.execute<{ tname: string }>(sql.raw(`${CLOSURE_SQL} order by 1`));

    await tx.execute(sql`create temp table probe_column_plan(tbl name, col name) on commit drop`);
    for (const entry of ORDER_HISTORY_DISPOSITIONS) {
      for (const column of entry.frozenColumns) {
        await tx.execute(
          sql`insert into probe_column_plan values (${entry.table}, ${column})`,
        );
      }
    }

    // The unwired self-test runs against tables the ledger says are refused, so
    // it is aimed by the declarations rather than by a name written here.
    await tx.execute(sql`create temp table probe_unwired_plan(tbl name) on commit drop`);
    for (const entry of ORDER_HISTORY_DISPOSITIONS) {
      if (entry.rowUpdate === 'refused' || entry.rowDelete === 'refused') {
        await tx.execute(sql`insert into probe_unwired_plan values (${entry.table})`);
      }
    }

    await tx.execute(sql.raw(ROW_PROBE_SQL));
    await tx.execute(sql.raw(COLUMN_PROBE_SQL));
    await tx.execute(sql.raw(UNWIRED_PROBE_SQL));

    const rows = await tx.execute<RowProbe>(sql`select tbl, trigs, upd, del from probe_rows`);
    const columns = await tx.execute<ColumnProbe>(
      sql`select tbl, col, verdict from probe_columns`,
    );
    const unwired = await tx.execute<RowProbe>(
      sql`select tbl, trigs, upd, del from probe_unwired`,
    );

    return {
      closure: [...closureRows].map((row) => row.tname),
      rows: [...rows],
      columns: [...columns],
      unwired: [...unwired],
    };
  });
}

let probes: Probes;

beforeAll(async () => {
  probes = await runProbes();
}, 120_000);

describe('the two derivations of the order-history population agree', () => {
  it('finds the same closure in pg_constraint as the census finds in drizzle', () => {
    const applied = [...probes.closure].sort();
    const declared = ORDER_HISTORY_DISPOSITIONS.map((entry) => entry.table).sort();
    expect(
      applied,
      'The tables reachable from `orders` in the APPLIED schema differ from the ' +
        'declared set, which the census proved equals the DRIZZLE-derived set. ' +
        'Either a migration added a foreign key the schema does not declare, or ' +
        'drizzle-kit dropped one it does.',
    ).toEqual(declared);
  });

  it('measured every declared table', () => {
    expect(probes.rows.map((row) => row.tbl).sort()).toEqual(
      ORDER_HISTORY_DISPOSITIONS.map((entry) => entry.table).sort(),
    );
  });
});

describe('every declared disposition is what the database does', () => {
  it('refuses, or allows, exactly what the ledger says', () => {
    const disagreements = probes.rows.flatMap((row) => {
      const declared = orderHistoryDispositionFor(row.tbl);
      if (!declared) return [`${row.tbl}: probed but not declared`];
      const out: string[] = [];
      if (row.upd !== declared.rowUpdate) {
        out.push(`${row.tbl}: UPDATE declared ${declared.rowUpdate}, database ${row.upd}`);
      }
      if (row.del !== declared.rowDelete) {
        out.push(`${row.tbl}: DELETE declared ${declared.rowDelete}, database ${row.del}`);
      }
      return out;
    });

    expect(
      disagreements,
      'A disposition and the database disagree. If a trigger was dropped or ' +
        'rewired, that is the bug; if one was added, update ' +
        '`orderHistoryDispositions.ts` and say why in its reason.',
    ).toEqual([]);
  });

  it('freezes every column the ledger declares frozen', () => {
    const planned = ORDER_HISTORY_DISPOSITIONS.flatMap((entry) =>
      entry.frozenColumns.map((column) => `${entry.table}.${column}`),
    ).sort();
    const probed = probes.columns.map((row) => `${row.tbl}.${row.col}`).sort();
    expect(probed, 'A declared frozen column was never probed').toEqual(planned);

    const notFrozen = probes.columns
      .filter((row) => row.verdict !== 'refused')
      .map((row) => `${row.tbl}.${row.col}`);
    expect(
      notFrozen,
      'These columns are declared frozen and the database let them change.',
    ).toEqual([]);
  });
});

describe('the probe measures something', () => {
  it('observed enough refusals to be worth reading', () => {
    // The floors are the whole defence against a probe that broke and reported
    // `allowed` everywhere — which is exactly what an unprotected schema looks
    // like. Measured at the time of writing: 20 tables refuse a no-op UPDATE, 15
    // refuse DELETE, and 40 columns are frozen.
    const refusedUpdate = probes.rows.filter((row) => row.upd === 'refused');
    const refusedDelete = probes.rows.filter((row) => row.del === 'refused');
    expect(refusedUpdate.length).toBeGreaterThanOrEqual(18);
    expect(refusedDelete.length).toBeGreaterThanOrEqual(13);
    expect(probes.columns.length).toBeGreaterThanOrEqual(35);
    expect(probes.columns.every((row) => row.verdict === 'refused')).toBe(true);
  });

  it('found real triggers on every table it says is protected', () => {
    // A refusal with no replicated trigger would mean the refusal came from
    // something the clone carries rather than from the enforcement under test.
    const unexplained = probes.rows
      .filter((row) => (row.upd === 'refused' || row.del === 'refused') && row.trigs === 0)
      .map((row) => row.tbl);
    expect(unexplained).toEqual([]);
  });

  it('reports `allowed` for a table that genuinely allows both', () => {
    // The positive control for the other direction: if the probe could only ever
    // say "refused", every assertion above would pass against any schema.
    const permissive = probes.rows.filter((row) => row.upd === 'allowed' && row.del === 'allowed');
    expect(permissive.length).toBeGreaterThanOrEqual(20);
  });
});

describe('the probe goes red when the enforcement is gone', () => {
  it('allows the same write once the triggers are not attached', () => {
    // THE mutation self-test. Same clone, same skeleton row, same statements —
    // only the triggers are missing. Every table the ledger calls protected must
    // flip to `allowed`, which is what proves the refusals above are the
    // triggers speaking.
    expect(probes.unwired.length).toBeGreaterThanOrEqual(18);
    const stillRefusing = probes.unwired
      .filter((row) => row.upd !== 'allowed' || row.del !== 'allowed')
      .map((row) => `${row.tbl}: upd=${row.upd} del=${row.del}`);
    expect(
      stillRefusing,
      'An untriggered clone still refused the write, so the probe is measuring ' +
        'something other than the trigger and its verdicts mean nothing.',
    ).toEqual([]);
  });

  it('reports `allowed` for a column that is not frozen', async () => {
    // The column probe's own self-test, and the one that matters: without it a
    // probe that always answered "refused" would pass every column assertion.
    // `order_items.quantity` sits on a table WITH a column-scoped trigger, so
    // this also proves the trigger is column-scoped rather than a whole-row
    // refusal the column probe happened to trip.
    const control = await db.transaction(async (tx) => {
      await tx.execute(sql`create temp table probe_column_plan(tbl name, col name) on commit drop`);
      await tx.execute(sql`insert into probe_column_plan values ('order_items', 'quantity')`);
      await tx.execute(sql.raw(COLUMN_PROBE_SQL));
      const rows = await tx.execute<ColumnProbe>(sql`select tbl, col, verdict from probe_columns`);
      return [...rows];
    });
    expect(control).toEqual([{ tbl: 'order_items', col: 'quantity', verdict: 'allowed' }]);
  });

  it('raises rather than skipping a column type it has no probe values for', async () => {
    // The vacuity floor on the column probe's own vocabulary. A skip would let a
    // frozen column of a new type stop being checked with nothing said.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`create temp table probe_column_plan(tbl name, col name) on commit drop`,
        );
        // `orders.fx_rate_rate` is `double precision`, which the probe
        // deliberately has no pair for.
        await tx.execute(sql`insert into probe_column_plan values ('orders', 'fx_rate_rate')`);
        await tx.execute(sql.raw(COLUMN_PROBE_SQL));
      }),
    ).rejects.toThrow(/no probe values for/);
  });
});
