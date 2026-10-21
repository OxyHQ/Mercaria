/**
 * Every foreign key that points INTO a swept table has an index on its
 * referencing column(s).
 *
 * The expiry sweep (`db/expiryTargets.ts`) is the one code path that deletes
 * rows by the thousand, unattended. Each deleted row makes Postgres check every
 * foreign key that references it with `... where <fk columns> = $1`, and with
 * no index leading on those columns that check is a SEQUENTIAL SCAN of the
 * referencing table — once per deleted row.
 *
 * Nothing fails when the index is missing. The sweep is correct and only slow,
 * and slow in a way that hides: the cost is not in the sweep's own plan, it is
 * in the referential-integrity triggers the delete fires. On 2026-10-21
 * `offer_price_snapshots.supersedes_snapshot_id` (a self-reference) had no
 * index, so each 1,000-row batch scanned `offer_price_snapshots` about 1,000
 * times — 28.8M buffer hits per statement, and the heaviest load Mercaria put
 * on the shared database. Sixteen more foreign keys onto swept tables had the
 * same gap on tables that were still empty.
 *
 * ## Why this reads `pg_constraint` and `pg_index`
 *
 * The migrated throwaway database is the state production is in, normalised by
 * Postgres itself. The referencing side of a foreign key is declared in a
 * different file from the sweep that makes it hot, so no reading of one
 * schema file can see the pair.
 *
 * ## What counts as serving the check
 *
 * A VALID index whose leading columns are exactly the foreign key's columns, in
 * any order. A partial index counts only when its predicate is the
 * `<column> is not null` the check implies — anything narrower would leave rows
 * the check must find outside the index.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableName, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { EXPIRY_TARGETS } from '../expiryTargets.js';

type ReferencingKey = {
  readonly constraint: string;
  readonly referencing: string;
  readonly referenced: string;
  readonly columns: string;
  readonly served: boolean;
};

/**
 * Floors, so a broken catalogue query cannot report a clean zero. MEASURED on
 * the migrated database: 35 swept tables and 29 foreign keys onto them.
 */
const MIN_SWEPT_TABLES = 30;
const MIN_REFERENCING_KEYS = 25;

let db: Database;
let sweptTables: string[];
let keys: ReferencingKey[];

beforeAll(async () => {
  db = await connectPostgres();
  sweptTables = [...new Set(EXPIRY_TARGETS.map((target) => getTableName(target.table)))].sort();

  keys = await db.execute<ReferencingKey>(sql`
    with fk as (
      select c.oid, c.conname, c.conrelid, c.confrelid, c.conkey
        from pg_constraint c
        join pg_class referenced on referenced.oid = c.confrelid
        join pg_namespace n on n.oid = referenced.relnamespace
       where c.contype = 'f'
         and n.nspname = current_schema()
         and referenced.relname = any(${sql.param(sweptTables)}::text[])
    )
    select fk.conname as "constraint",
           fk.conrelid::regclass::text as "referencing",
           fk.confrelid::regclass::text as "referenced",
           (select string_agg(a.attname, ', ' order by k.ord)
              from unnest(fk.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = k.attnum) as "columns",
           exists (
             select 1 from pg_index i
              where i.indrelid = fk.conrelid
                and i.indisvalid
                and (i.indkey::int2[])[0:cardinality(fk.conkey) - 1] @> fk.conkey
                and (i.indkey::int2[])[0:cardinality(fk.conkey) - 1] <@ fk.conkey
                and (
                  i.indpred is null
                  or (cardinality(fk.conkey) = 1
                      and pg_get_expr(i.indpred, i.indrelid) = format(
                        '(%I IS NOT NULL)',
                        (select a.attname from pg_attribute a
                          where a.attrelid = fk.conrelid and a.attnum = fk.conkey[1])))
                )
           ) as "served"
      from fk
     order by 2, 1
  `);
});

afterAll(async () => {
  await closePostgres();
});

describe('foreign keys onto swept tables', () => {
  it('reads a real population (vacuity floors)', () => {
    expect(sweptTables.length).toBeGreaterThanOrEqual(MIN_SWEPT_TABLES);
    expect(keys.length).toBeGreaterThanOrEqual(MIN_REFERENCING_KEYS);
    expect(keys.filter((key) => key.served).length).toBeGreaterThanOrEqual(MIN_REFERENCING_KEYS);
  });

  it('includes the self-reference that made the sweep scan its own table', () => {
    expect(keys.map((key) => `${key.referencing}.${key.columns}`)).toContain(
      'offer_price_snapshots.supersedes_snapshot_id',
    );
  });

  it('every one has an index leading on its referencing columns', () => {
    const unserved = keys
      .filter((key) => !key.served)
      .map(
        (key) =>
          `${key.referencing}(${key.columns}) → ${key.referenced} [${key.constraint}]: ` +
          'each row the sweep deletes from the referenced table scans the referencing one. ' +
          'Index the column (partial `where <column> is not null` when it is nullable).',
      );
    expect(unserved).toEqual([]);
  });
});
