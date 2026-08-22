/**
 * Deriving every `.orderBy(...)` in a repository, and deciding whether it is
 * TOTAL.
 *
 * ## The defect this exists to catch
 *
 * An `ORDER BY` on a non-unique column is not deterministic. Two rows with equal
 * values may come back in either order, and PostgreSQL is free to change its
 * mind between two executions of the same statement — a different plan, a
 * different worker count, a row that moved. For a `limit`-bounded read that
 * makes the truncation point arbitrary. For a KEYSET-paginated read it is worse:
 * a page can REPEAT one row and DROP another, and the row it drops is never
 * seen again by that traversal.
 *
 * It goes wrong under load rather than in a test, which is why it needs a gate
 * rather than a case. A fixture with distinct values in the ordering column
 * passes whether or not the tie-break is there — measured in this repository,
 * not hypothesized: removing `asc(categories.slug)` from `findChildCategories`
 * left the whole suite green, while removing the identical tie-break from
 * `findCategoryDescendants` turned `catalog-api-contract.realdb.test.ts` red,
 * because only THAT fixture happens to give two rows the same `position`. One of
 * four tie-breaks was defended by accident of fixture data.
 *
 * ## What "total" means here, and why it is checked against the SCHEMA
 *
 * An ordering is total when its LAST term is unique across the rows the query
 * can return, because every earlier tie is then broken by something that cannot
 * itself tie. This module answers that from the REAL drizzle table metadata —
 * `getTableConfig` — and never from the column's name. `id` is total only
 * because it is a primary key, and `slug` is total only because
 * `categories_slug_key` exists; either could stop being true in a migration that
 * says nothing about ordering, and the point of reading the schema is that such
 * a migration fails HERE.
 *
 * A PARTIAL unique index does NOT make an ordering total, and it is the one that
 * looks like it does. `uniqueIndex(...).where(sql`deleted_at is null`)` permits
 * any number of equal values among the rows it excludes, so a read whose filter
 * does not imply that predicate can still tie. Partial uniques are therefore
 * rejected, and a read that genuinely relies on one has to say so as a
 * disposition rather than pass silently.
 *
 * ## Unresolvable is a FAILURE, never a skip
 *
 * `~/Oxy/AGENTS.md`: *a gate that SKIPS what a hand-maintained map omits is not
 * a gate.* An ordering term this module cannot parse — a raw `sql` template, a
 * computed expression, a helper call — is reported as `unresolved` and the gate
 * FAILS on it. The alternative is the shape that keeps being found here: an
 * analyzer that quietly resolves six of nine sites and reports "all total".
 *
 * ## Why the TypeScript AST rather than a regex
 *
 * Every grep hazard in this area is live. A `.orderBy(` call routinely spans
 * three lines, so a line-oriented pattern drops exactly the multi-term orderings
 * — which are the ones with tie-breaks in them, i.e. the population under test.
 * Flattening with `tr` then requires every literal space to become
 * `[[:space:]]+` or it drops the same set again. And a match inside a comment or
 * a docblock counts, in a codebase whose modules document their own ordering
 * decisions in the detector's vocabulary. The AST has none of those failure
 * modes: a comment is not a `CallExpression`.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

/** One term of an `ORDER BY`, as written in the source. */
export interface OrderingTerm {
  /** The identifier the column was read from — the drizzle table's local name. */
  readonly table: string;
  /** The PROPERTY as written (`parentId`), not the database column (`parent_id`). */
  readonly property: string;
  readonly direction: 'asc' | 'desc' | 'unspecified';
}

/** One `.orderBy(...)` call site. */
export interface OrderingSite {
  /** Path as handed in, so a failure names a file a reader can open. */
  readonly file: string;
  readonly line: number;
  /** The nearest enclosing named function, for a message that says WHICH read. */
  readonly enclosing: string;
  /**
   * The terms, in order — or `null` when any argument could not be parsed.
   *
   * `null` is deliberately not an empty array: "there are no terms" and "I could
   * not read the terms" lead to opposite conclusions, and collapsing them is how
   * an analyzer reports that an unreadable site is fine.
   */
  readonly terms: readonly OrderingTerm[] | null;
  /** The source text, so an unresolved site can be read without opening the file. */
  readonly text: string;
}

function parse(file: string, source?: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source ?? readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** The nearest enclosing function/method name, or `<module>`. */
function enclosingName(node: ts.Node): string {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    if (ts.isFunctionDeclaration(cursor) && cursor.name) return cursor.name.text;
    if (ts.isMethodDeclaration(cursor) && ts.isIdentifier(cursor.name)) return cursor.name.text;
    if (
      ts.isVariableDeclaration(cursor) &&
      ts.isIdentifier(cursor.name) &&
      cursor.initializer &&
      (ts.isArrowFunction(cursor.initializer) || ts.isFunctionExpression(cursor.initializer))
    ) {
      return cursor.name.text;
    }
  }
  return '<module>';
}

/**
 * One argument to `.orderBy(...)` → a term, or `null` if it cannot be read.
 *
 * The two forms that appear: `asc(table.column)` / `desc(table.column)`, and a
 * bare `table.column` (drizzle defaults it to ascending). Anything else —
 * `sql\`...\``, a helper call, a spread, a conditional — is `null`, which the
 * gate turns into a failure.
 */
function termOf(argument: ts.Expression): OrderingTerm | null {
  if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)) {
    const direction = argument.expression.text;
    if ((direction === 'asc' || direction === 'desc') && argument.arguments.length === 1) {
      const inner = argument.arguments[0];
      if (inner && ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
        return { table: inner.expression.text, property: inner.name.text, direction };
      }
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression)) {
    return {
      table: argument.expression.text,
      property: argument.name.text,
      direction: 'unspecified',
    };
  }
  return null;
}

/** Every `.orderBy(...)` site in one file. */
export function orderingSitesIn(file: string, source?: string): OrderingSite[] {
  const parsed = parse(file, source);
  const sites: OrderingSite[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'orderBy'
    ) {
      const terms = node.arguments.map(termOf);
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      sites.push({
        file,
        line,
        enclosing: enclosingName(node),
        // An EMPTY argument list is unresolved rather than "no terms": drizzle
        // accepts a callback form, and reading it as an ordering with nothing in
        // it would report the least total site of all as total.
        terms:
          node.arguments.length === 0 || terms.some((term) => term === null)
            ? null
            : (terms as OrderingTerm[]),
        text: node.getText(parsed).replace(/\s+/g, ' ').slice(0, 200),
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);
  return sites;
}

/** Whether an ordering is total, and the evidence either way. */
export type TotalityVerdict =
  | { readonly total: true; readonly because: string }
  | { readonly total: false; readonly because: string };

/** The database column names for a list of TS property names, or a failure. */
function columnNames(
  table: PgTable,
  properties: readonly string[],
): { readonly names: string[] } | { readonly missing: string } {
  const names: string[] = [];
  for (const property of properties) {
    const column = (table as unknown as Record<string, unknown>)[property];
    const name =
      column && typeof column === 'object' ? (column as { name?: string }).name : undefined;
    if (typeof name !== 'string') return { missing: property };
    names.push(name);
  }
  return { names };
}

/**
 * Is an ordering over these PROPERTIES of this table total?
 *
 * ## The criterion, and why it is COVERAGE rather than "the last column"
 *
 * An `ORDER BY` is total when the columns it names, taken TOGETHER as a set,
 * contain every column of some unique key. Then no two distinct rows can agree
 * on all of them, so no tie survives to be broken arbitrarily. Position within
 * the ordering does not matter for this — `ORDER BY key, version` and
 * `ORDER BY version, key` are both total when `(key, version)` is unique; they
 * simply produce different (but each deterministic) orders.
 *
 * The narrower rule "the LAST term must be a single-column unique" is the one
 * that is easy to reach for, and it is wrong in the direction that costs work:
 * it reports `ORDER BY key, version` as non-total under a `(key, version)`
 * unique, which pushes whoever reads the failure to append a redundant primary
 * key to an ordering that was already total. This module used that rule for
 * exactly one iteration and it mis-reported three real fixes, which is why the
 * criterion is written down here rather than left implicit.
 *
 * ## PARTIAL uniques do not count, and that is the subtle half
 *
 * `uniqueIndex(...).where(...)` permits any number of equal values among the
 * rows its predicate excludes. A read whose own filter reproduces the predicate
 * is fine in practice — but that argument lives in a different statement from
 * this ORDER BY, sometimes a CTE away, and nothing local breaks when the filter
 * is edited. So partial uniques are refused here, and a read that genuinely
 * relies on one records a disposition saying so. The refusal MESSAGE names the
 * partial index it found, because "no unique at all" and "a unique you may not
 * lean on" lead to different fixes.
 *
 * Properties are used to index the table object rather than matched against
 * database column names, so `parentId` finds `parent_id` without this module
 * knowing the casing rule — and a property that does not exist is a REFUSAL
 * rather than a silent miss.
 */
export function orderingIsTotal(table: PgTable, properties: readonly string[]): TotalityVerdict {
  if (properties.length === 0) {
    return { total: false, because: 'the ordering names no columns' };
  }
  const resolved = columnNames(table, properties);
  if ('missing' in resolved) {
    return {
      total: false,
      because: `there is no column property named \`${resolved.missing}\` on this table`,
    };
  }
  const ordered = new Set(resolved.names);
  const config = getTableConfig(table);

  const primaryKey = Object.values(config.columns)
    .filter((column) => column.primary)
    .map((column) => column.name);
  const compositePrimaryKey = config.primaryKeys[0]?.columns.map((column) => column.name) ?? [];
  const declaredPrimaryKey = primaryKey.length > 0 ? primaryKey : compositePrimaryKey;
  if (declaredPrimaryKey.length > 0 && declaredPrimaryKey.every((name) => ordered.has(name))) {
    return { total: true, because: `the ordering covers the primary key (${declaredPrimaryKey.join(', ')})` };
  }

  for (const unique of config.uniqueConstraints) {
    const names = unique.columns.map((column) => column.name);
    if (names.every((name) => ordered.has(name))) {
      return { total: true, because: `the ordering covers unique constraint \`${unique.name}\`` };
    }
  }

  for (const candidate of config.indexes) {
    const cfg = candidate.config;
    if (!cfg.unique || cfg.where) continue;
    const names = cfg.columns.map((column) => (column as { name?: string }).name);
    if (names.every((name) => typeof name === 'string' && ordered.has(name))) {
      return { total: true, because: `the ordering covers unique index \`${cfg.name}\`` };
    }
  }

  const partial = config.indexes
    .filter((candidate) => candidate.config.unique && candidate.config.where)
    .find((candidate) =>
      candidate.config.columns.every((column) => {
        const name = (column as { name?: string }).name;
        return typeof name === 'string' && ordered.has(name);
      }),
    );
  if (partial) {
    return {
      total: false,
      because:
        `the only unique these columns cover is \`${partial.config.name}\`, which is PARTIAL — ` +
        'it permits ties among the rows its predicate excludes, and this ORDER BY cannot see ' +
        'whether the statement reproduces that predicate',
    };
  }
  return {
    total: false,
    because: `these columns (${resolved.names.join(', ')}) cover no primary key and no non-partial unique`,
  };
}
