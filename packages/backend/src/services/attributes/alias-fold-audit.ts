/**
 * How far apart the write-side and read-side folds have already carried the
 * registry (#632). READ ONLY — this module writes nothing and repairs nothing.
 *
 * ## Why a detection pass exists before any fix
 *
 * `attribute_value_aliases.normalized_alias` is GENERATED `lower(btrim(alias))`;
 * the reader folds with `normalizeOptionValue` — `trim()`, collapse `\s+`,
 * lowercase. `btrim` trims SPACES only and collapses no interior run, so
 * `USB C`, `USB C\t` and `USB  C` are one key to a lookup and three to the
 * index.
 *
 * The fix is to make the generated expression fold the way the reader does. It
 * cannot be applied blind, and that is measured rather than assumed — on
 * PostgreSQL 17.5, redefining the expression revalidates the unique index and
 * ABORTS when two existing rows fold together:
 *
 *     ERROR:  could not create unique index "…_alias_key"
 *     DETAIL:  Key (n)=(usb c) is duplicated.
 *
 * So a `pre` migration written straight from the obvious shape is a failed
 * deploy on data nobody has looked at. Worse, the collisions are not all
 * mechanical: **two aliases folding into one may point at two DIFFERENT
 * canonical values**, and which survives is a catalogue judgement no migration
 * can make. The abort is the good outcome; a fold that silently picked a winner
 * would be the bad one.
 *
 * This module produces the number that decides whether the migration is safe,
 * and names the rows that need a person.
 *
 * ## Four populations, and they are genuinely different questions
 *
 * - `aliasCollisions` / `enumValueCollisions` — rows that would violate their
 *   unique index after the fold. These BLOCK the migration.
 * - `aliasUnreachable` / `enumValueUnreachable` — rows whose stored key the
 *   reader can never produce. These are broken TODAY, collide with nothing, and
 *   are silently repaired by the same migration.
 *
 * A row can be in either set alone. Reporting one number for both would make
 * "the migration is safe to run" and "nothing is broken" the same claim, and
 * they are not.
 *
 * ## The enum-value half, which #632 does not name
 *
 * `attribute_enum_values_normalized_check` enforces `value = lower(btrim(value))`
 * while the comment above it claims values are *"whitespace-collapsed"* — the
 * comment claims more than the CHECK enforces, and there is no service
 * chokepoint that could make up the difference. A canonical value is its OWN
 * alias (`resolveDefinitions` sets `value -> value` into the same map), so the
 * failure lands on the value every assignment stores.
 */

import { sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../../db/postgres.js';

/**
 * The whitespace JavaScript's `\s` (with `u`) matches and PostgreSQL's does not.
 *
 * Written as ESCAPES and never as literal characters: a NO-BREAK SPACE pasted
 * into this file is invisible in every diff and every review, which is the same
 * class of defect as the one below it. PostgreSQL interprets `\uXXXX` inside
 * both an `E''` string and a regular-expression bracket class, so the SQL below
 * carries no literal control character either.
 */
const JS_ONLY_SPACES = String.raw`\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;

/** The same set as a bracket-class RANGE, which is what a regex wants. */
const JS_ONLY_SPACE_CLASS = String.raw`\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;

/**
 * The READ-side fold, in SQL — the one spelling, exported so the audit, its
 * agreement test and the eventual migration cannot each write their own.
 *
 * It is NOT `regexp_replace(btrim(x), '\s+', ' ', 'g')`. Postgres `\s` is the
 * POSIX space class and JavaScript's `\s` under `u` is not: measured against
 * `normalizeOptionValue` over thirteen spellings, the POSIX form disagrees on a
 * NO-BREAK SPACE and on a ZERO WIDTH NO-BREAK SPACE, and the explicit class
 * below agrees on all thirteen. Two folds that disagree on exotic whitespace is
 * the same defect this module exists to measure, one layer up — and the
 * direction it would fail in is the dangerous one, because an UNDER-count says
 * the migration is safe when it is not.
 *
 * `alias-fold-audit.realdb.test.ts` pins the agreement over that table, so
 * a change to either side fails the build rather than quietly moving the count.
 */
export const READ_SIDE_FOLD_SQL =
  String.raw`lower(regexp_replace(btrim(%COL%, E' \t\n\r\f\v` +
  JS_ONLY_SPACES +
  String.raw`'), '[\s` +
  JS_ONLY_SPACE_CLASS +
  String.raw`]+', ' ', 'g'))`;

/** The fold applied to one column, as raw SQL. */
export function readSideFold(column: string): string {
  return READ_SIDE_FOLD_SQL.replace(/%COL%/gu, column);
}

/** One group of rows that fold to a single key. */
export interface AliasFoldCollision {
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  readonly attributeVersion: number;
  /** What every row in this group folds to on the read side. */
  readonly foldedKey: string;
  /** The stored spellings, bounded. */
  readonly spellings: readonly string[];
  readonly rowCount: number;
  /**
   * How many DIFFERENT canonical values the group points at.
   *
   * `1` is mechanical — the rows say the same thing twice and one may simply be
   * dropped. Anything above 1 is the catalogue judgement: two spellings that
   * become one key currently resolve to two different values, and which one
   * survives is a decision about the catalogue.
   *
   * Always `1` for an enum-value collision, where the row IS the value.
   */
  readonly distinctTargets: number;
}

/** One row the reader can never look up. */
export interface AliasFoldUnreachable {
  readonly attributeDefinitionId: string;
  readonly attributeKey: string;
  readonly attributeVersion: number;
  /** The spelling as stored. */
  readonly stored: string;
  /** The key it is indexed under today. */
  readonly storedKey: string;
  /** The key the reader folds a matching observation to. */
  readonly readerKey: string;
}

/** One column's report. */
export interface AliasFoldTableReport {
  /** Rows examined. `0` findings over `0` rows is not the same fact as over 40,000. */
  readonly population: number;
  readonly collisionGroups: readonly AliasFoldCollision[];
  readonly collisionRows: number;
  /** The subset of `collisionGroups` that needs a person, not a rule. */
  readonly ambiguousGroups: number;
  readonly unreachable: readonly AliasFoldUnreachable[];
  readonly unreachableRows: number;
  /** True when a sample was truncated, so a reader knows the list is partial. */
  readonly truncated: boolean;
}

/** What the operator surface returns. */
export interface AliasFoldAudit {
  readonly aliases: AliasFoldTableReport;
  readonly enumValues: AliasFoldTableReport;
  /**
   * Whether the #632 migration can be applied without aborting.
   *
   * A conjunction over the two collision counts and nothing else — an
   * unreachable row does not block the rewrite, it is repaired by it.
   */
  readonly migrationSafe: boolean;
}

/**
 * How many rows a sample carries.
 *
 * Bounded for `INTEGRITY_SAMPLE_LIMIT`'s reason: an operator needs enough to
 * see the shape and act, and a response carrying every row of a broken
 * catalogue is one nobody reads. `truncated` is the disclosure.
 */
const SAMPLE_LIMIT = 100;

async function scalar(db: DatabaseOrTransaction, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ total: number }>(statement);
  return Number([...rows][0]?.total ?? 0);
}

/**
 * Audit one column.
 *
 * `table`, `valueColumn` and `keyColumn` are interpolated with `sql.raw` and are
 * MODULE CONSTANTS at both call sites — never a parameter this function's
 * callers can influence. The operator route passes nothing into it at all.
 */
async function auditColumn(
  db: DatabaseOrTransaction,
  table: 'attribute_value_aliases' | 'attribute_enum_values',
  valueColumn: 'alias' | 'value',
  keyColumn: 'normalized_alias' | 'value',
  targetExpression: string,
): Promise<AliasFoldTableReport> {
  const fold = sql.raw(readSideFold(`t.${valueColumn}`));
  const from = sql.raw(table);
  const value = sql.raw(`t.${valueColumn}`);
  const key = sql.raw(`t.${keyColumn}`);
  const target = sql.raw(targetExpression);

  const population = await scalar(db, sql`select count(*)::int as total from ${from} t`);

  const groups = await db.execute<{
    attribute_definition_id: string;
    attribute_key: string;
    attribute_version: number;
    folded_key: string;
    spellings: string[];
    row_count: number;
    distinct_targets: number;
  }>(sql`
    select t.attribute_definition_id,
           d.key   as attribute_key,
           d.version as attribute_version,
           ${fold} as folded_key,
           array_agg(${value} order by ${value}) as spellings,
           count(*)::int as row_count,
           count(distinct ${target})::int as distinct_targets
      from ${from} t
      join attribute_definitions d on d.id = t.attribute_definition_id
     group by t.attribute_definition_id, d.key, d.version, ${fold}
    having count(*) > 1
     order by count(*) desc, ${fold}
     limit ${SAMPLE_LIMIT + 1}
  `);

  const groupRows = [...groups];
  const truncatedGroups = groupRows.length > SAMPLE_LIMIT;

  // Counted over the WHOLE table rather than off the bounded sample: the two
  // answer different questions, and the one that decides whether a migration
  // may run must not be a page.
  const collisionRows = await scalar(
    db,
    sql`
      select coalesce(sum(c), 0)::int as total from (
        select count(*)::int as c
          from ${from} t
         group by t.attribute_definition_id, ${fold}
        having count(*) > 1
      ) g
    `,
  );
  const ambiguousGroups = await scalar(
    db,
    sql`
      select count(*)::int as total from (
        select 1
          from ${from} t
         group by t.attribute_definition_id, ${fold}
        having count(*) > 1 and count(distinct ${target}) > 1
      ) g
    `,
  );

  const stray = await db.execute<{
    attribute_definition_id: string;
    attribute_key: string;
    attribute_version: number;
    stored: string;
    stored_key: string;
    reader_key: string;
  }>(sql`
    select t.attribute_definition_id,
           d.key as attribute_key,
           d.version as attribute_version,
           ${value} as stored,
           ${key} as stored_key,
           ${fold} as reader_key
      from ${from} t
      join attribute_definitions d on d.id = t.attribute_definition_id
     where ${key} is distinct from ${fold}
     order by d.key, ${value}
     limit ${SAMPLE_LIMIT + 1}
  `);
  const strayRows = [...stray];
  const truncatedStray = strayRows.length > SAMPLE_LIMIT;

  const unreachableRows = await scalar(
    db,
    sql`select count(*)::int as total from ${from} t where ${key} is distinct from ${fold}`,
  );

  return {
    population,
    collisionGroups: groupRows.slice(0, SAMPLE_LIMIT).map((row) => ({
      attributeDefinitionId: row.attribute_definition_id,
      attributeKey: row.attribute_key,
      attributeVersion: row.attribute_version,
      foldedKey: row.folded_key,
      spellings: row.spellings,
      rowCount: Number(row.row_count),
      distinctTargets: Number(row.distinct_targets),
    })),
    collisionRows,
    ambiguousGroups,
    unreachable: strayRows.slice(0, SAMPLE_LIMIT).map((row) => ({
      attributeDefinitionId: row.attribute_definition_id,
      attributeKey: row.attribute_key,
      attributeVersion: row.attribute_version,
      stored: row.stored,
      storedKey: row.stored_key,
      readerKey: row.reader_key,
    })),
    unreachableRows,
    truncated: truncatedGroups || truncatedStray,
  };
}

/**
 * The whole audit. Nothing here writes, and nothing here repairs.
 *
 * Repair is deliberately absent rather than deferred: every collision above
 * `distinctTargets = 1` is a catalogue decision, and a surface that could
 * resolve one would be a surface that picks a canonical value on somebody's
 * behalf — which is the failure the migration's abort protects against.
 */
export async function auditAliasFold(db: DatabaseOrTransaction): Promise<AliasFoldAudit> {
  const aliases = await auditColumn(
    db,
    'attribute_value_aliases',
    'alias',
    'normalized_alias',
    't.enum_value_id',
  );
  // The row IS the canonical value, so a group's rows can only point at
  // themselves — `distinct_targets` is over the value column and is 1 by
  // construction, which is why an enum-value collision is never ambiguous in
  // the alias sense. It is still a decision: two canonical values becoming one
  // means every assignment citing the loser has to move.
  const enumValues = await auditColumn(
    db,
    'attribute_enum_values',
    'value',
    'value',
    't.id',
  );

  return {
    aliases,
    enumValues,
    migrationSafe: aliases.collisionRows === 0 && enumValues.collisionRows === 0,
  };
}
