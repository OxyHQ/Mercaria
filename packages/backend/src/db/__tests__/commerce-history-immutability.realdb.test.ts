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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import {
  COMMERCE_HISTORY_DISPOSITIONS,
  COMMERCE_HISTORY_ROOT_TABLES,
  commerceHistoryDispositionFor,
} from '../commerceHistoryDispositions.js';

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
    select r.tname from (values ${COMMERCE_HISTORY_ROOT_TABLES.map(
      (table) => `('${table}'::name)`,
    ).join(', ')}) as r(tname)
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
      -- The function CALL, arguments included, lifted out of the trigger's own
      -- definition. A regprocedure cast renders only the bare name with empty
      -- parentheses and DROPS the argument list, which for an argument-driven
      -- trigger is the difference between replicating the enforcement and
      -- replicating an inert shell of it. Measured: with the arguments dropped,
      -- TG_ARGV comes back NULL (not empty), FOREACH ... IN ARRAY TG_ARGV raises
      -- 22004, and the probe recorded a REFUSAL that had nothing to do with the
      -- column under test. Every frozen-column verdict in this file was green
      -- for that wrong reason until the SQLSTATE assertion below was added.
      select x.tgname,
             regexp_replace(pg_get_triggerdef(x.oid), '^.*EXECUTE (FUNCTION|PROCEDURE) ', '') as fn,
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
        when 'float8' then first_value := '1.5'; second_value := '2.5';
        when 'jsonb' then
          first_value := '''{"probe":"a"}''::jsonb';
          second_value := '''{"probe":"b"}''::jsonb';
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
        -- The SQLSTATE, never the word "refused". A refusal is only evidence of
        -- enforcement if it is the enforcement's OWN refusal; anything else is
        -- the probe tripping over itself and reading as a pass.
        get stacked diagnostics verdict = returned_sqlstate;
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
  /** `table` -> the columns its column-freeze triggers actually name. */
  readonly enforcedColumns: ReadonlyMap<string, readonly string[]>;
  /** Tables carrying an UPDATE trigger that is neither shared function. */
  readonly bespokeTriggerTables: ReadonlySet<string>;
}

/** The function every column-freeze trigger runs. Its ARGUMENTS are the list. */
const COLUMN_FREEZE_FUNCTION = 'mercaria_commerce_snapshot_columns_immutable';

/**
 * The SQLSTATEs a trigger deliberately RAISING can produce here, read as codes
 * and never as condition names.
 *
 * All three are measured, not assumed:
 *
 *  - `23514` (`check_violation`) — everything #367 line 75 added passes it as
 *    `USING ERRCODE`, and so does #90's condition freeze.
 *  - `P0001` (`raise_exception`) — plpgsql's DEFAULT, which most of the freezes
 *    predating this issue produce because their bodies pass no ERRCODE at all.
 *  - `23001` (`restrict_violation`) — what the `retail_service_request*`
 *    triggers pass. It is genuinely a RAISE and not a foreign key firing:
 *    `CREATE TABLE ... (LIKE ...)` copies no foreign keys, so the clone has none
 *    to violate, and the migrations spell it `USING ERRCODE =
 *    'restrict_violation'` explicitly.
 *
 * Anything else means the probe hit something that is not the enforcement under
 * test.
 *
 * Spelled as CODES and never as condition names. `RAISE ... USING ERRCODE`
 * accepts either spelling, so a test matching the NAME compiles, reads
 * correctly, and matches nothing — `restrict_violation` above is exactly the
 * pair that has already cost a day elsewhere in this repo.
 */
const RAISE_SQLSTATES: readonly string[] = ['23514', 'P0001', '23001'];

/**
 * The tables #367 line 75 froze — the ones whose refusal must be 23514 exactly.
 *
 * `orders` is deliberately NOT here even though #367 line 75 froze forty-nine of its
 * columns. Four of its declared columns (`buyer_origin`,
 * `buyer_guest_checkout_id`, `buyer_oxy_user_id`, `claimed_by_oxy_user_id`) are
 * governed by #106's `orders_buyer_origin_immutable`, whose body passes no
 * `USING ERRCODE` and therefore raises plpgsql's default P0001. Listing
 * `orders` would fail on those four, and widening the assertion to admit P0001
 * for the whole table would stop it discriminating for the other forty-five.
 * They are covered by `RAISE_SQLSTATES` above and by the column probe.
 */
const SNAPSHOT_TABLES: readonly string[] = [
  'payments',
  'refunds',
  'transfers',
  'payouts',
  'disputes',
  'provider_accounts',
  'payment_provider_events',
  'payment_outboxes',
  // #367 line 75. Both triggers on `order_items` pass `check_violation`, so the whole
  // declared set is assertable here; `retail_procurement_intents` has only the
  // shared one.
  'order_items',
  'retail_procurement_intents',
];

/**
 * What each column-freeze trigger names, read back out of the applied schema.
 *
 * The THIRD derivation, and it closes a direction the other two cannot see. The
 * column probe is aimed BY the declarations, so it can only ever check columns
 * somebody declared: a trigger freezing a column no entry mentions is invisible
 * to it, and so is a trigger that quietly stopped naming one. Reading the
 * argument list back off `pg_trigger` and comparing it to the declaration makes
 * both directions fail loudly.
 *
 * `pg_get_triggerdef` is used rather than decoding `tgargs`, which is a bytea of
 * NUL-separated C strings — parsing that by hand is a second thing to get wrong
 * in a file whose whole purpose is not getting this wrong.
 */
const TRIGGER_ARG_SQL = `
  select c.relname as tbl, pg_get_triggerdef(t.oid) as def
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and not t.tgisinternal
    and p.proname = '${COLUMN_FREEZE_FUNCTION}'
`;

/** The whole-row refusal function, shared by every append-only table here. */
const ROW_FREEZE_FUNCTION = 'mercaria_commerce_snapshot_append_only';

/**
 * Tables carrying an UPDATE trigger that is NEITHER of the two shared functions.
 *
 * DERIVED, never listed. `orders` and `order_items` each carry a BESPOKE freeze
 * that predates #367 line 75 — #106's `orders_buyer_origin_immutable` and #90's
 * `order_items_condition_immutable` — whose column names live inside a function
 * BODY, where there is no argument list to read back. So for those two the
 * declaration is legitimately WIDER than what the shared function names, and
 * the strict equality below would fail on a correct schema.
 *
 * Deriving the exemption from `pg_trigger` rather than writing the two names
 * here is the difference between a rule and a hand-maintained allow-list: a
 * table that LOSES its bespoke trigger silently returns to strict equality and
 * fails, which is the direction that matters.
 */
const BESPOKE_TRIGGER_SQL = `
  select distinct c.relname as tbl
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and not t.tgisinternal
    and (t.tgtype::int & 16) > 0
    and p.proname not in ('${COLUMN_FREEZE_FUNCTION}', '${ROW_FREEZE_FUNCTION}')
`;

/**
 * One SQL string literal, single quotes doubled.
 *
 * Every caller passes a constant written in this file, so this is not a
 * sanitiser standing between user input and the server — it is what makes a
 * value carrying a quote (`'probe-a'`, which is itself quoted) survive being
 * embedded in a `do $probe$ ... $probe$` body.
 */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Pull the quoted arguments out of one `CREATE TRIGGER ... EXECUTE FUNCTION f('a', 'b')`. */
function argumentsOf(definition: string): readonly string[] {
  const call = definition.slice(definition.lastIndexOf(`${COLUMN_FREEZE_FUNCTION}(`));
  return [...call.matchAll(/'([^']*)'/gu)].map((match) => match[1] ?? '');
}

async function runProbes(): Promise<Probes> {
  return db.transaction(async (tx) => {
    const closureRows = await tx.execute<{ tname: string }>(sql.raw(`${CLOSURE_SQL} order by 1`));

    await tx.execute(sql`create temp table probe_column_plan(tbl name, col name) on commit drop`);
    for (const entry of COMMERCE_HISTORY_DISPOSITIONS) {
      for (const column of entry.frozenColumns) {
        await tx.execute(
          sql`insert into probe_column_plan values (${entry.table}, ${column})`,
        );
      }
    }

    // The unwired self-test runs against tables the ledger says are refused, so
    // it is aimed by the declarations rather than by a name written here.
    await tx.execute(sql`create temp table probe_unwired_plan(tbl name) on commit drop`);
    for (const entry of COMMERCE_HISTORY_DISPOSITIONS) {
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

    const triggerDefs = await tx.execute<{ tbl: string; def: string }>(sql.raw(TRIGGER_ARG_SQL));
    const enforcedColumns = new Map<string, readonly string[]>();
    for (const row of [...triggerDefs]) {
      enforcedColumns.set(row.tbl, [
        ...(enforcedColumns.get(row.tbl) ?? []),
        ...argumentsOf(row.def),
      ]);
    }

    const bespoke = await tx.execute<{ tbl: string }>(sql.raw(BESPOKE_TRIGGER_SQL));

    return {
      closure: [...closureRows].map((row) => row.tname),
      rows: [...rows],
      columns: [...columns],
      unwired: [...unwired],
      enforcedColumns,
      bespokeTriggerTables: new Set([...bespoke].map((row) => row.tbl)),
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
    const declared = COMMERCE_HISTORY_DISPOSITIONS.map((entry) => entry.table).sort();
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
      COMMERCE_HISTORY_DISPOSITIONS.map((entry) => entry.table).sort(),
    );
  });
});

describe('every declared disposition is what the database does', () => {
  it('refuses, or allows, exactly what the ledger says', () => {
    const disagreements = probes.rows.flatMap((row) => {
      const declared = commerceHistoryDispositionFor(row.tbl);
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
        '`commerceHistoryDispositions.ts` and say why in its reason.',
    ).toEqual([]);
  });

  it('freezes every column the ledger declares frozen', () => {
    const planned = COMMERCE_HISTORY_DISPOSITIONS.flatMap((entry) =>
      entry.frozenColumns.map((column) => `${entry.table}.${column}`),
    ).sort();
    const probed = probes.columns.map((row) => `${row.tbl}.${row.col}`).sort();
    expect(probed, 'A declared frozen column was never probed').toEqual(planned);

    const notFrozen = probes.columns
      .filter((row) => row.verdict === 'allowed')
      .map((row) => `${row.tbl}.${row.col}`);
    expect(
      notFrozen,
      'These columns are declared frozen and the database let them change.',
    ).toEqual([]);
  });

  it('refuses each frozen column by RAISING, not by tripping over something else', () => {
    // THE assertion that makes every verdict above mean something. A probe that
    // trips over its own harness raises too, and "refused" cannot tell the two
    // apart — so the check is the SQLSTATE, read NUMERICALLY.
    //
    // This is not hypothetical. Replicating these triggers through
    // `regprocedure` drops their argument list, `TG_ARGV` comes back NULL rather
    // than empty, and `FOREACH` raises **22004**. Every frozen column then
    // reported "refused" while the freeze under test was inert. The fix is above;
    // this is what would have caught it.
    const wrongCode = probes.columns
      .filter((row) => row.verdict !== 'allowed' && !RAISE_SQLSTATES.includes(row.verdict))
      .map((row) => `${row.tbl}.${row.col}: SQLSTATE ${row.verdict}`);
    expect(
      wrongCode,
      'A frozen column was refused by something other than a trigger deliberately ' +
        'RAISING. 22004 in particular means the probe replicated a trigger without ' +
        'its arguments and is measuring its own harness; 23502 or 23503 would mean ' +
        'a NOT NULL or a foreign key refused the write and the freeze was never ' +
        'reached.',
    ).toEqual([]);
  });

  it('refuses every #367-line-75 column with 23514 specifically', () => {
    // The sharper half. The freezes that predate this issue raise with the
    // plpgsql DEFAULT (P0001) because their bodies pass no `USING ERRCODE`;
    // every trigger this issue adds passes `USING ERRCODE = 'check_violation'`,
    // so 23514 is assertable exactly for them and a drift back to a generic
    // raise — or to any other refusal — fails here.
    const strays = probes.columns
      .filter((row) => SNAPSHOT_TABLES.includes(row.tbl) && row.verdict !== '23514')
      .map((row) => `${row.tbl}.${row.col}: SQLSTATE ${row.verdict}`);
    expect(strays).toEqual([]);

    // …and it measured them, rather than finding none and agreeing with itself.
    // Measured after #367 line 75: 100 columns across the ten tables (67 before it).
    const measured = probes.columns.filter((row) => SNAPSHOT_TABLES.includes(row.tbl));
    expect(measured.length).toBeGreaterThanOrEqual(95);
  });
});

describe('what the triggers freeze is what the ledger declares', () => {
  it('names EXACTLY the declared columns, table by table', () => {
    // Scoped to the tables whose freeze runs through the SHARED, argument-driven
    // function. The freezes that predate #367 line 75 each have their own
    // bespoke function with the column names written into its body, where there
    // is no argument list to read back — those are covered behaviourally by the
    // column probe instead. Widening this to them would not check them, it would
    // just demand they be rewritten.
    const disagreements: string[] = [];
    let strictlyCompared = 0;
    const tables = new Set(probes.enforcedColumns.keys());
    for (const table of [...tables].sort()) {
      const enforced = [...(probes.enforcedColumns.get(table) ?? [])].sort();
      const declared = [...(commerceHistoryDispositionFor(table)?.frozenColumns ?? [])].sort();

      // A table with NO bespoke trigger must match exactly — the original rule,
      // and still the one every table but two is held to.
      if (!probes.bespokeTriggerTables.has(table)) {
        strictlyCompared += 1;
        if (enforced.join(',') !== declared.join(',')) {
          disagreements.push(
            `${table}: trigger freezes [${enforced}], ledger declares [${declared}]`,
          );
        }
        continue;
      }

      // A table that ALSO carries a bespoke freeze (#90 on `order_items`, #106
      // on `orders`) declares more than the shared function names, because the
      // bespoke one's columns live in a function BODY with no argument list to
      // read back. Containment is what is checkable here; that the leftover
      // columns are genuinely frozen is asserted BEHAVIOURALLY by the column
      // probe above, which probes every declared column on every table.
      const notDeclared = enforced.filter((column) => !declared.includes(column));
      if (notDeclared.length > 0) {
        disagreements.push(
          `${table}: trigger freezes [${notDeclared}] which the ledger does not declare`,
        );
      }
    }
    expect(
      disagreements,
      'A column-freeze trigger and its declaration disagree. The column probe cannot ' +
        'catch this on its own: it is aimed BY the declarations, so a column the trigger ' +
        'freezes and no entry mentions is invisible to it, and so is one the trigger ' +
        'quietly stopped naming.',
    ).toEqual([]);

    // The vacuity floor on the RELAXATION itself. If `BESPOKE_TRIGGER_SQL` ever
    // matched everything — a renamed shared function would do it — every table
    // would fall into the containment branch and this assertion would pass
    // while checking almost nothing. Measured after #367 line 75: 9 of the 11 tables
    // carrying a shared column-freeze trigger are compared strictly, the two
    // exempt being `orders` (#106's trigger) and `order_items` (#90's).
    expect(
      strictlyCompared,
      'Almost every table should still be held to EXACT equality; only the two ' +
        'carrying a pre-existing bespoke freeze are exempt.',
    ).toBeGreaterThanOrEqual(9);
  });

  it('read a plausible number of trigger arguments back', () => {
    // The vacuity floor for THIS derivation. `pg_get_triggerdef` returning
    // something the parser does not recognise, or the function being renamed,
    // would leave `enforcedColumns` empty — and an empty map compared against an
    // empty declaration set agrees perfectly. Measured after #367 line 75: 11 tables and
    // 146 columns named in trigger arguments (8 and 67 before it).
    expect(probes.enforcedColumns.size).toBeGreaterThanOrEqual(10);
    const total = [...probes.enforcedColumns.values()].flat().length;
    expect(total).toBeGreaterThanOrEqual(140);
  });

  it('parses an argument list it is handed', () => {
    // The parser's own positive control, so the floor above cannot be satisfied
    // by a parser that returns something plausible for anything.
    expect(
      argumentsOf(
        `CREATE TRIGGER t BEFORE UPDATE ON public.x FOR EACH ROW EXECUTE FUNCTION ` +
          `${COLUMN_FREEZE_FUNCTION}('a_col', 'b_col')`,
      ),
    ).toEqual(['a_col', 'b_col']);
  });
});

describe('the probe measures something', () => {
  it('observed enough refusals to be worth reading', () => {
    // The floors are the whole defence against a probe that broke and reported
    // `allowed` everywhere — which is exactly what an unprotected schema looks
    // like. Measured after #367 line 75: 31 tables refuse a no-op UPDATE, 20 refuse
    // DELETE, and 191 columns are frozen. (Before it: 27, 20 and 112.)
    const refusedUpdate = probes.rows.filter((row) => row.upd === 'refused');
    const refusedDelete = probes.rows.filter((row) => row.del === 'refused');
    expect(refusedUpdate.length).toBeGreaterThanOrEqual(28);
    expect(refusedDelete.length).toBeGreaterThanOrEqual(18);
    expect(probes.columns.length).toBeGreaterThanOrEqual(180);
    expect(probes.columns.every((row) => RAISE_SQLSTATES.includes(row.verdict))).toBe(true);

    // And the payment/refund half specifically. The totals above are dominated
    // by the order tables, so a regression that lost exactly the #367 line 75
    // columns would still clear every floor in this block.
    const payAndRefund = probes.columns.filter((row) =>
      ['payments', 'refunds', 'transfers', 'payouts', 'provider_accounts'].includes(row.tbl),
    );
    expect(payAndRefund.length).toBeGreaterThanOrEqual(48);
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
    // The column sits on a table WITH a column-scoped trigger, so this also
    // proves that trigger is column-scoped rather than a whole-row refusal the
    // column probe happened to trip.
    //
    // This used to aim at `order_items.quantity`. #367 line 75 froze it — quantity is
    // exactly "what was sold" — so the control MOVED to `order_items.position`
    // rather than being deleted, the way the `float8` control below moved when
    // #368 froze the column it used to name. `position` is the right successor
    // for the same reason it is left unfrozen: it is presentation ordering
    // rather than a term of the sale, and `db/__tests__/condition.realdb.test.ts`
    // independently asserts an ordinary UPDATE still succeeds there.
    const control = await db.transaction(async (tx) => {
      await tx.execute(sql`create temp table probe_column_plan(tbl name, col name) on commit drop`);
      await tx.execute(sql`insert into probe_column_plan values ('order_items', 'position')`);
      await tx.execute(sql.raw(COLUMN_PROBE_SQL));
      const rows = await tx.execute<ColumnProbe>(sql`select tbl, col, verdict from probe_columns`);
      return [...rows];
    });
    expect(control).toEqual([{ tbl: 'order_items', col: 'position', verdict: 'allowed' }]);
  });

  it('still has a column-scoped trigger on the table that control names', () => {
    // The other half of moving the control. `order_items.position` only proves
    // "column-scoped rather than whole-row" while `order_items` actually
    // carries a column-scoped freeze — otherwise the control degenerates into
    // "an unprotected table allows writes", which is true of any table and
    // discriminates nothing.
    expect(commerceHistoryDispositionFor('order_items')?.frozenColumns ?? []).toContain('quantity');
    expect(commerceHistoryDispositionFor('order_items')?.rowUpdate).toBe('allowed');
  });

  it('raises rather than skipping a column type it has no probe values for', async () => {
    // The vacuity floor on the column probe's own vocabulary. A skip would let a
    // frozen column of a new type stop being checked with nothing said.
    //
    // This used to aim at `orders.fx_rate_rate` (`double precision`). #367 line
    // 75 froze `payments.platform_rate_rate`, which is the same type, so the
    // probe GAINED a `float8` pair and this control had to move rather than be
    // deleted — a self-test that stops discriminating because the thing it
    // measured became supported is a self-test that silently passes forever.
    // `provider_accounts.disabled_reason_codes` is `text[]`, which nothing in
    // this file declares frozen and the probe deliberately has no pair for.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`create temp table probe_column_plan(tbl name, col name) on commit drop`,
        );
        await tx.execute(
          sql`insert into probe_column_plan values ('provider_accounts', 'disabled_reason_codes')`,
        );
        await tx.execute(sql.raw(COLUMN_PROBE_SQL));
      }),
    ).rejects.toThrow(/no probe values for/);
  });

  it('still has a float8 column under test, so gaining that pair cost nothing', () => {
    // The other half of moving the control above: the `float8` pair was added
    // for a REASON, and if that reason ever disappears the pair becomes
    // unexercised vocabulary that the moved control no longer covers either.
    const float8Columns = COMMERCE_HISTORY_DISPOSITIONS.flatMap((entry) =>
      entry.frozenColumns
        .filter((column) => column.endsWith('rate_rate'))
        .map((column) => `${entry.table}.${column}`),
    );
    expect(float8Columns).toContain('payments.platform_rate_rate');
  });
});

/**
 * Each #367-line-75 trigger mutated ON ITS OWN.
 *
 * The `unwired` self-test above drops EVERY trigger at once, which proves the
 * refusals come from triggers COLLECTIVELY and nothing more. That is not enough
 * when several triggers guard adjacent things: N identical-looking triggers can
 * be added and only one of them actually be load-bearing for the fixture in
 * hand, leaving N-1 defended by accident and green forever.
 *
 * So each trigger below is omitted INDIVIDUALLY — every other real trigger on
 * the table is still replicated — and the write it forbids must then be
 * ACCEPTED. A trigger that is inert, misspells its table, or is shadowed by a
 * sibling that was doing the work all along fails here and nowhere else.
 *
 * The clone takes locks on nothing shared, so this is safe on the suite's
 * shared database; dropping the real trigger would take ACCESS EXCLUSIVE on
 * `orders` while sibling realdb files are using it.
 */
describe('each #367-line-75 trigger is individually load-bearing', () => {
  /**
   * The seven triggers, each with a write it alone must refuse.
   *
   * The column named for a column-scoped trigger is deliberately one that the
   * table's OTHER (bespoke) trigger does not govern, or the case would pass
   * with the trigger under test removed.
   */
  const CASES: readonly {
    readonly trigger: string;
    readonly table: string;
    readonly column: string;
    readonly first: string;
    readonly second: string;
  }[] = [
    // The four whole-row refusals. Any column serves, since the trigger refuses
    // the UPDATE outright.
    {
      trigger: 'order_status_history_append_only',
      table: 'order_status_history',
      column: 'note',
      first: `'probe-a'`,
      second: `'probe-b'`,
    },
    {
      trigger: 'order_item_option_values_append_only',
      table: 'order_item_option_values',
      column: 'value',
      first: `'probe-a'`,
      second: `'probe-b'`,
    },
    {
      trigger: 'order_applied_discounts_append_only',
      table: 'order_applied_discounts',
      column: 'title',
      first: `'probe-a'`,
      second: `'probe-b'`,
    },
    {
      trigger: 'order_tax_lines_append_only',
      table: 'order_tax_lines',
      column: 'name',
      first: `'probe-a'`,
      second: `'probe-b'`,
    },
    // The three column-scoped ones.
    {
      trigger: 'orders_snapshot_immutable',
      table: 'orders',
      // NOT one of #106's four buyer columns, which `orders_buyer_origin_immutable`
      // would go on refusing with this trigger gone.
      column: 'totals_grand_total_shop_amount',
      first: '100',
      second: '999',
    },
    {
      trigger: 'order_items_snapshot_immutable',
      table: 'order_items',
      // NOT a condition column, which #90's trigger would go on refusing.
      column: 'title',
      first: `'probe-a'`,
      second: `'probe-b'`,
    },
    {
      trigger: 'retail_procurement_intents_snapshot_immutable',
      table: 'retail_procurement_intents',
      column: 'buyer_locked_total_amount',
      first: '100',
      second: '999',
    },
  ];

  /**
   * Clone `table` with every real UPDATE/DELETE trigger EXCEPT `omit`, then move
   * `column` and report what happened.
   *
   * `omit` of `''` replicates everything, which is the positive control: the
   * same statement against the full wiring must be REFUSED, so an ACCEPTED with
   * one trigger removed is attributable to that removal rather than to the
   * clone being wrong.
   */
  async function probeWithout(
    testCase: (typeof CASES)[number],
    omit: string,
  ): Promise<string> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`
          do $probe$
          declare
            target name := ${quoteLiteral(testCase.table)};
            col record;
            trg record;
            verdict text;
          begin
            create temp table probe_one(verdict text) on commit drop;
            execute format('create temp table probe_clone (like public.%I) on commit drop', target);
            for col in
              select attname from pg_attribute
              where attrelid = 'pg_temp.probe_clone'::regclass and attnum > 0
                and not attisdropped and attnotnull and attgenerated = ''
            loop
              execute format('alter table pg_temp.probe_clone alter column %I drop not null', col.attname);
            end loop;
            for trg in
              select x.tgname,
                     regexp_replace(pg_get_triggerdef(x.oid), '^.*EXECUTE (FUNCTION|PROCEDURE) ', '') as fn,
                     case when (x.tgtype::int & 2) > 0 then 'before' else 'after' end as timing,
                     array_to_string(array_remove(array[
                       case when (x.tgtype::int & 4) > 0 then 'insert' end,
                       case when (x.tgtype::int & 8) > 0 then 'delete' end,
                       case when (x.tgtype::int & 16) > 0 then 'update' end], null), ' or ') as events,
                     case when (x.tgtype::int & 1) > 0 then 'for each row' else 'for each statement' end as lvl,
                     x.tgenabled
              from pg_trigger x
              where x.tgrelid = format('public.%I', target)::regclass
                and not x.tgisinternal
                and (x.tgtype::int & 24) > 0
            loop
              if trg.tgenabled <> 'O' then continue; end if;
              if trg.tgname = ${quoteLiteral(omit)} then continue; end if;
              execute format('create trigger %I %s %s on pg_temp.probe_clone %s execute function %s',
                             trg.tgname, trg.timing, trg.events, trg.lvl, trg.fn);
            end loop;
            execute format('insert into pg_temp.probe_clone (%I) values (%s)',
                           ${quoteLiteral(testCase.column)}, ${quoteLiteral(testCase.first)});
            begin
              execute format('update pg_temp.probe_clone set %I = %s',
                             ${quoteLiteral(testCase.column)}, ${quoteLiteral(testCase.second)});
              verdict := 'allowed';
            exception when others then
              get stacked diagnostics verdict = returned_sqlstate;
            end;
            insert into probe_one values (verdict);
          end
          $probe$;
        `),
      );
      const result = await tx.execute<{ verdict: string }>(sql`select verdict from probe_one`);
      return [...result][0]?.verdict ?? 'MISSING';
    });
  }

  for (const testCase of CASES) {
    it(`${testCase.trigger} alone refuses ${testCase.table}.${testCase.column}`, async () => {
      // Positive control FIRST: with every trigger wired, the write is refused.
      // Without this, an `allowed` below could mean the clone never enforced
      // anything rather than that this trigger is what enforces it.
      const wired = await probeWithout(testCase, '');
      expect(
        wired,
        `With every trigger replicated, ${testCase.table}.${testCase.column} was not refused — ` +
          'the clone is not measuring the enforcement at all.',
      ).toBe('23514');

      const without = await probeWithout(testCase, testCase.trigger);
      expect(
        without,
        `Removing ONLY ${testCase.trigger} left ${testCase.table}.${testCase.column} still refused, ` +
          'so that trigger is not what refuses it — it is inert, or a sibling is doing its work ' +
          'and it would go on passing if it were deleted.',
      ).toBe('allowed');
    }, 30_000);
  }

  it('covers every trigger 0137 creates, counted from the migration itself', () => {
    // The vacuity floor. A case list that drifted behind the migration would
    // leave a trigger with no individual mutation and nothing would say so, so
    // the expected set is READ OUT of the applied SQL rather than restated.
    const sqlText = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'drizzle',
        '0137_order_snapshot_immutability.sql',
      ),
      'utf8',
    );
    const created = [...sqlText.matchAll(/^CREATE TRIGGER (\w+)$/gmu)].map((m) => m[1]).sort();
    expect(created.length, 'read no CREATE TRIGGER out of 0137 — the pattern is broken').toBe(7);
    expect(CASES.map((c) => c.trigger).sort()).toEqual(created);
  });
});
