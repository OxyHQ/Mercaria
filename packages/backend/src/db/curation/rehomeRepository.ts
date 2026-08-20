/**
 * The generic REHOMER — one function that executes any {@link RehomeTarget}
 * from `services/curation/merge-plan.ts` (#59 merge invariant 2).
 *
 * ## Why the statement is built rather than written out
 *
 * There are 75 referencing columns across seven mergeable entities, and a merge
 * has to move every one of them. Seventy-five hand-written UPDATEs is seventy-five
 * chances to get a predicate wrong, and — worse — a plan and a set of statements
 * that can silently disagree, so the census test would pass while the merge
 * skipped a table. Here the PLAN is the only description, and this executor is
 * its one interpreter, so a plan entry that exists is a statement that runs.
 *
 * ## `qualified()` is load-bearing in the guards
 *
 * Interpolating a drizzle column into `sql` renders it BARE when its table is
 * not in that statement's own `FROM` — which is exactly the case inside these
 * correlated `EXISTS` subqueries. A bare reference then resolves against the
 * SUBQUERY's table, so the predicate compares two of its own columns, matches
 * nothing, and returns success with no error at all. `@oxyhq/db`'s `qualified`
 * exists for this trap and its doc comment records that it shipped in a
 * production consumer. Every correlated reference below goes through it.
 */

import { getTableColumns, getTableName, sql, type Column } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { qualified, sqlColumnName } from '@oxyhq/db';
import type { BareArrayRehome, RehomeTarget } from '../../services/curation/merge-plan.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';

/** The alias the correlated guards use. Distinctive, so it cannot shadow a real name. */
const OTHER = 'curation_other';

/**
 * `, "updated_at" = now()` when the table has that column, and nothing when it
 * does not.
 *
 * Raw SQL bypasses drizzle's `$onUpdate`, so a rehome that did not write it
 * would leave `updated_at` claiming the row had not changed since ingestion —
 * on a row a merge just moved to a different entity.
 */
function updatedAtClause(column: AnyPgColumn) {
  const columns: Record<string, Column> = getTableColumns(column.table);
  const updatedAt = columns.updatedAt;
  return updatedAt ? sql`, ${sql.identifier(sqlColumnName(updatedAt))} = now()` : sql``;
}

/** `and <status> = '<value>'`, or nothing when the target names no status scope. */
function activeScope(target: RehomeTarget) {
  if (!target.activeStatusColumn) return sql``;
  if (target.activeStatusValue === undefined) {
    // The scope is "this row is still OPEN", spelled as a NULL end-of-validity
    // (`commerce_relationships.valid_to`). Stating it here rather than making
    // every caller pass a sentinel keeps the plan readable.
    return sql` and ${qualified(target.activeStatusColumn)} is null`;
  }
  return sql` and ${qualified(target.activeStatusColumn)} = ${target.activeStatusValue}`;
}

/**
 * `and not exists (…)` — the guard that keeps a `repoint_if_absent` from
 * violating the unique it names.
 *
 * `is not distinct from` rather than `=` on each shared column, so a NULLable
 * member of the unique compares the way Postgres's own index does not: a plain
 * `=` would read two NULLs as unknown and admit the row, which is the duplicate
 * the guard exists to refuse.
 */
function absenceGuard(target: RehomeTarget, toId: string) {
  const uniqueWith = target.uniqueWith ?? [];
  const table = target.column.table;
  const matches = uniqueWith.map(
    (column) =>
      sql` and ${sql.identifier(OTHER)}.${sql.identifier(sqlColumnName(column))} is not distinct from ${qualified(column)}`,
  );
  /**
   * The guard must be exactly as WIDE as the index it guards, never wider.
   *
   * A partial unique scoped to live rows (`retail_suppressions_live_key`'s
   * `WHERE lifted_at IS NULL`) does not constrain a lifted row, so a guard that
   * ignored the predicate would let a LIFTED suppression on the winner block a
   * LIVE one from following its entity — silently un-suppressing a recalled
   * product, which is the one direction this must never fail in.
   */
  const live = target.guardWhereNullColumn
    ? sql` and ${sql.identifier(OTHER)}.${sql.identifier(sqlColumnName(target.guardWhereNullColumn))} is null`
    : sql``;
  return sql` and not exists (
    select 1 from ${table} as ${sql.identifier(OTHER)}
    where ${sql.identifier(OTHER)}.${sql.identifier(sqlColumnName(target.column))} = ${toId}
    ${sql.join(matches, sql``)}${live}
  )`;
}

/**
 * `and <other endpoint> is distinct from <winner>` — the rows a
 * distinct-endpoints CHECK would refuse after the move (#405).
 *
 * A DIFFERENT question from {@link absenceGuard}, and the reason that one cannot
 * be widened to cover it: the absence guard asks whether the WINNER already
 * holds an equivalent row, and in a collapse no such row exists — the offending
 * row is the one being moved. Both are applied where a target names both.
 *
 * `is distinct from`, never `<>`. The other endpoint is nullable (a relation's
 * target may be a family, a variant or a typed key), and `NULL <> '…'` is NULL,
 * so a plain `<>` would drop every row whose other endpoint is empty out of the
 * UPDATE — silently refusing to move exactly the ordinary rows this guard is not
 * about.
 *
 * ONE comparison, against the WINNER. Comparing the loser as well would cover
 * `(loser, loser)`, which cannot exist: the CHECK is unconditional and total, so
 * it refuses `(x, x)` at INSERT — asserted, with a control, in
 * `curation-writes.realdb.test.ts`. A comparison that can never fire is
 * not defence in depth, it is a line that makes the guard look wider than it is.
 * A table whose distinct-endpoints CHECK is PARTIAL, or was added `NOT VALID`,
 * would need that second comparison and does not exist here.
 */
function collapseGuard(target: RehomeTarget, toId: string) {
  if (!target.distinctFromColumn) return sql``;
  return sql` and ${qualified(target.distinctFromColumn)} is distinct from ${toId}`;
}

/** The mirror of {@link absenceGuard}: the rows that WOULD collide. */
function presenceGuard(target: RehomeTarget, toId: string) {
  const uniqueWith = target.uniqueWith ?? [];
  const table = target.column.table;
  const matches = uniqueWith.map(
    (column) =>
      sql` and ${sql.identifier(OTHER)}.${sql.identifier(sqlColumnName(column))} is not distinct from ${qualified(column)}`,
  );
  const activeOther = target.statusColumn
    ? sql` and ${sql.identifier(OTHER)}.${sql.identifier(sqlColumnName(target.statusColumn))} = 'active'`
    : sql``;
  return sql` and exists (
    select 1 from ${table} as ${sql.identifier(OTHER)}
    where ${sql.identifier(OTHER)}.${sql.identifier(sqlColumnName(target.column))} = ${toId}
    ${sql.join(matches, sql``)}${activeOther}
  )`;
}

/**
 * Run one UPDATE and report how many rows it moved.
 *
 * The count comes back through a CTE rather than from the driver's own affected
 * -row report, so it is the same number on every driver and can be asserted
 * against the phase record without knowing which one is underneath.
 */
async function runCounted(db: DatabaseOrTransaction, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute(sql`with moved as (${statement}) select count(*)::int as moved from moved`);
  const first: unknown = rows[0];
  if (first && typeof first === 'object' && 'moved' in first) {
    return Number((first as { moved: number }).moved);
  }
  return 0;
}

/**
 * Move one entity id to another INSIDE an array column (#716).
 *
 * `array_replace` alone is not enough and the reason is not hypothetical: a
 * shopper who excluded BOTH merchants — which is ordinary, since a duplicate
 * pair is two records of one business and somebody with a grievance may well
 * have named both — would end up holding the winner TWICE. `verify` re-runs
 * every rehoming and requires zero rows, so that duplicate would be moved again
 * on the second pass, and a residual that persists fails the job. Hence the
 * de-duplication, and hence it belongs in the same statement rather than in a
 * tidy-up beside it.
 *
 * Idempotent for the reason every statement here is: the WHERE matches only rows
 * whose array still CONTAINS the loser, so a completed phase re-run moves
 * nothing and reports zero.
 *
 * Ordering is not preserved — `array_agg(distinct … order by …)` returns the
 * survivors sorted. That is deliberate rather than incidental: these columns are
 * SETS (ids nothing may use, ids a query filters to), no reader indexes into
 * them, and a deterministic order is what lets a test assert the result exactly.
 * A future array whose order carries meaning must not use this function.
 *
 * There is no `coalesce(…, '{}')` on the aggregate, deliberately. A row reaching
 * it holds the loser, so it holds at least the winner afterwards and the
 * aggregate cannot be empty; if that reasoning is ever wrong the column's NOT
 * NULL raises, which is loud. Defaulting to an empty array instead would erase
 * every exclusion on the row — silently, and in the direction nobody checks.
 */
export async function applyBareArrayRehome(
  rehome: BareArrayRehome,
  fromId: string,
  toId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const table = rehome.column.table;
  const columnName = sql.identifier(sqlColumnName(rehome.column));
  return runCounted(
    db,
    sql`update ${table}
        set ${columnName} = (
              select array_agg(distinct element order by element)
                from unnest(array_replace(${qualified(rehome.column)}, ${fromId}, ${toId}))
                  as element
            )${updatedAtClause(rehome.column)}
        where ${qualified(rehome.column)} @> array[${fromId}]::text[]
        returning 1`,
  );
}

/**
 * Execute one plan entry.
 *
 * Idempotent by construction, which is what #59 merge invariant 2's "rehomed
 * idempotently" and acceptance 3's replay both rest on: every statement's WHERE
 * matches only rows still pointing at the LOSER, so a second run of a completed
 * phase moves nothing and reports zero.
 */
export async function applyRehomeTarget(
  target: RehomeTarget,
  fromId: string,
  toId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (target.disposition === 'retained_by_tombstone' || target.disposition === 'untouched') {
    return 0;
  }

  const table = target.column.table;
  const columnName = sql.identifier(sqlColumnName(target.column));
  const bumpUpdatedAt = updatedAtClause(target.column);
  /**
   * The columns that carry a SECOND copy of the same id, set in the same
   * statement. A row whose CHECK requires two columns to agree cannot be moved
   * one column at a time — the intermediate state does not exist.
   */
  const alsoSet = (target.alsoSetColumns ?? []).map(
    (column) => sql`, ${sql.identifier(sqlColumnName(column))} = ${toId}`,
  );
  const alsoSetClause = alsoSet.length > 0 ? sql.join(alsoSet, sql``) : sql``;
  let moved = 0;

  if (target.disposition === 'repoint_or_supersede') {
    if (!target.statusColumn || !target.supersededStatus) {
      throw new Error(
        `rehome plan entry for ${getTableName(table)}.${sqlColumnName(target.column)} is ` +
          '`repoint_or_supersede` without a status column and superseded value; the collision ' +
          'it names has no way to be resolved.',
      );
    }
    const statusName = sql.identifier(sqlColumnName(target.statusColumn));
    // The colliding rows FIRST: they move AND lose their active status, so the
    // partial unique's predicate no longer covers them.
    moved += await runCounted(
      db,
      sql`update ${table}
          set ${columnName} = ${toId}${alsoSetClause}, ${statusName} = ${target.supersededStatus}${bumpUpdatedAt}
          where ${qualified(target.column)} = ${fromId}
            and ${qualified(target.statusColumn)} = 'active'
            ${presenceGuard(target, toId)}
          returning 1`,
    );
  }

  const guard =
    target.disposition === 'repoint_if_absent' ||
    (target.disposition === 'conflict_gated' && (target.uniqueWith?.length ?? 0) > 0)
      ? absenceGuard(target, toId)
      : sql``;
  const collapse = collapseGuard(target, toId);

  moved += await runCounted(
    db,
    sql`update ${table}
        set ${columnName} = ${toId}${alsoSetClause}${bumpUpdatedAt}
        where ${qualified(target.column)} = ${fromId}${guard}${collapse}
        returning 1`,
  );

  return moved;
}

/**
 * How many rows one plan entry WOULD move — the impact estimate's per-target
 * count (#59 security 2).
 *
 * It runs the same predicate the executor does, minus the guard, so the number
 * an operator is shown is the number of rows that currently point at the loser
 * rather than a separate query that could drift from the statement.
 * `retained_by_tombstone` and `untouched` count ZERO, because the estimate
 * measures what MOVES.
 */
export async function countRehomeTarget(
  target: RehomeTarget,
  fromId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (target.disposition === 'retained_by_tombstone' || target.disposition === 'untouched') {
    return 0;
  }
  const rows = await db.execute(
    sql`select count(*)::int as moved from ${target.column.table}
        where ${qualified(target.column)} = ${fromId}${activeScope(target)}`,
  );
  const first: unknown = rows[0];
  if (first && typeof first === 'object' && 'moved' in first) {
    return Number((first as { moved: number }).moved);
  }
  return 0;
}

/**
 * Move ONE row — the split's own primitive (#59 split invariant 1).
 *
 * A split reassigns exactly the rows an operator named, so it addresses them by
 * primary key rather than by "everything pointing at X". The CAS on the FROM
 * value is what makes a replay converge: a row already moved matches nothing
 * and reports `false`, so a resumed `assignments` phase re-applies nothing even
 * if its `applied_at` write was the statement that was lost.
 */
export async function reassignRowById(
  column: AnyPgColumn,
  rowId: string,
  fromId: string,
  toId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const table = column.table;
  const columns: Record<string, Column> = getTableColumns(table);
  const idColumn = columns.id;
  if (!idColumn) {
    throw new Error(
      `${getTableName(table)} has no \`id\` column, so a split cannot address one of its rows.`,
    );
  }
  const moved = await runCounted(
    db,
    sql`update ${table}
        set ${sql.identifier(sqlColumnName(column))} = ${toId}${updatedAtClause(column)}
        where ${qualified(idColumn)} = ${rowId} and ${qualified(column)} = ${fromId}
        returning 1`,
  );
  return moved === 1;
}
