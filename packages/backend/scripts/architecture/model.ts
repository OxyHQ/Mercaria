/**
 * The DERIVED model behind `docs/catalog-architecture-diagrams.md`.
 *
 * Nothing in this file is a claim about the schema. Every fact it returns is
 * read out of an artefact that already decides the question — drizzle's own
 * table reflection for cardinality, the migration SQL for the population, the
 * gated module table in `docs/catalog-table-ownership.md` for the grouping, and
 * the production source itself for who writes what. The renderer beside it
 * turns that model into mermaid, and the gate beside them both regenerates and
 * compares, so a hand edit to the diagram cannot survive.
 *
 * The reason it is built this way rather than drawn is in
 * `docs/catalog-table-ownership.md`: four separate figures in that document had
 * silently rotted before #857 removed them, and a DIAGRAM is a worse home for a
 * rotting fact than a sentence is — a wrong arrow is read as an architectural
 * decision rather than as an error.
 *
 * It lives under `scripts/` and not under `src/` for a reason that is easy to
 * lose: the write census below scans `src/**` for drizzle write calls, so a
 * module under `src/` that names those call shapes would match ITSELF. That is
 * the shape `catalog-identity-isolation.test.ts` works around by splitting its
 * forbidden names into fragments; keeping the scanner outside the scanned tree
 * removes the problem instead of dodging it. `scripts/**` is typechecked
 * (tsconfig `include`), linted (`eslint src scripts build.ts`) and carries
 * vitest cases (`vitest.config.ts` `include`), so nothing is given up.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_CASING } from '@oxyhq/db';
import { Column, getTableName, is } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { MIGRATIONS_FOLDER } from '../../src/db/migrationsFolder.js';
import * as schema from '../../src/db/schema/index.js';

/**
 * The SQL name of a column, resolved through drizzle's OWN casing machinery
 * with the repository's OWN constant.
 *
 * `column.name` is the schema property (`categoryId`); the DDL says
 * `category_id`, because `DATABASE_CASING` is passed to both drizzle-kit
 * (`drizzle.config.ts`) and the runtime handle (`src/db/postgres.ts`). Applying
 * a hand-written snake_case rule here would be a THIRD implementation of that
 * conversion, free to disagree with the two that decide the real schema — so
 * the one drizzle uses is the one that renders these labels.
 */
const casing = new CasingCache(DATABASE_CASING);
const sqlColumnName = (column: PgColumn): string => casing.getColumnCasing(column);

/**
 * The epic's first migration.
 *
 * Deliberately the SAME constant `catalog-table-ownership-census.test.ts`
 * anchors, and deliberately re-declared rather than imported from that test
 * file: a test file is not a module anything should depend on, and the gate
 * beside this one asserts the two agree. `0086` is the trap it exists for — it
 * creates four `referral_pilot_*` tables and sits immediately under a long run
 * of catalogue migrations, so it reads as the start of the run to anyone who
 * finds the boundary by scrolling.
 */
export const FIRST_EPIC_MIGRATION_IDX = 88;

/** The repository root, found by walking up rather than by counting `..`. */
export function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 12; hops += 1) {
    if (
      readdirSync(dir).includes('docs') &&
      readdirSync(dir).includes('packages') &&
      readdirSync(dir).includes('package.json')
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the repository root above this module. Everything below reads files ' +
      'relative to it; a fallback here would produce a model built from nothing.',
  );
}

export const REPO_ROOT = repositoryRoot();
export const SRC_ROOT = join(REPO_ROOT, 'packages', 'backend', 'src');
export const OWNERSHIP_DOC = join(REPO_ROOT, 'docs', 'catalog-table-ownership.md');
export const DIAGRAM_DOC = join(REPO_ROOT, 'docs', 'catalog-architecture-diagrams.md');

/* ------------------------------------------------------------------ *
 * The drizzle side: tables, and what drizzle itself will emit for them
 * ------------------------------------------------------------------ */

/** Every drizzle table the barrel exports, by SQL name. */
export const tablesByName: ReadonlyMap<string, PgTable> = new Map(
  Object.values(schema).flatMap((value) => (is(value, PgTable) ? [[getTableName(value), value]] : [])),
);

/**
 * The barrel's export NAME for each table, which is what a repository writes in
 * `db.insert(categoryAliases)`. Built from the barrel rather than from a naming
 * rule, because the mapping is not always mechanical.
 */
export const tableNameBySymbol: ReadonlyMap<string, string> = new Map(
  Object.entries(schema).flatMap(([exportName, value]) =>
    is(value, PgTable) ? [[exportName, getTableName(value)]] : [],
  ),
);

/* ------------------------------------------------------ *
 * The population: every table a migration at/after 0088   *
 * created. Derived from the SQL, never from a hand list.  *
 * ------------------------------------------------------ */

/**
 * A `CREATE TABLE` the migrator will actually execute.
 *
 * Anchored at column 0, which is what distinguishes a statement from the header
 * comments in this chain that discuss `CREATE TABLE` in prose: drizzle-kit
 * emits every statement flush left and every comment behind `--`.
 */
const CREATE_TABLE = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gm;

export interface CreatedTable {
  readonly table: string;
  readonly migration: string;
  readonly idx: number;
}

export function censusCreatedTables(): readonly CreatedTable[] {
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const found: CreatedTable[] = [];
  for (const name of files) {
    const idx = Number.parseInt(name.slice(0, 4), 10);
    if (!Number.isInteger(idx)) continue;
    const sql = readFileSync(join(MIGRATIONS_FOLDER, name), 'utf8');
    for (const match of sql.matchAll(CREATE_TABLE)) {
      found.push({ table: match[1], migration: name, idx });
    }
  }
  return found;
}

/** The derived population: table name → the migration index that created it. */
export function epicPopulation(): ReadonlyMap<string, number> {
  const first = new Map<string, number>();
  for (const entry of censusCreatedTables()) {
    const seen = first.get(entry.table);
    if (seen === undefined || entry.idx < seen) first.set(entry.table, entry.idx);
  }
  return new Map(
    [...first].filter(([, idx]) => idx >= FIRST_EPIC_MIGRATION_IDX).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/* ------------------------------------------------------------------ *
 * The grouping: read out of the GATED module table, not re-decided    *
 * ------------------------------------------------------------------ */

/**
 * The header of the module table in `docs/catalog-table-ownership.md`.
 *
 * The document holds several markdown tables and only this one answers "which
 * module owns this". Anchoring on the header row rather than on "the first
 * table" means a new table inserted above it does not silently re-point this
 * parse at the wrong rows — it makes the parse find nothing, which the floors
 * below catch loudly.
 */
const MODULE_TABLE_HEADER = '| Module | Schema file | Repositories | Tables |';

export interface ModuleAssignment {
  readonly module: string;
  readonly tables: readonly string[];
}

/**
 * Module → the epic tables it owns, parsed out of the gated table.
 *
 * Only identifiers that are REAL drizzle tables survive: the Tables column also
 * names schema files and columns in backticks, and a parse that took every
 * backticked word would put `db/schema/catalog.ts:128` in a diagram.
 */
export function moduleAssignments(doc: string, known: ReadonlySet<string>): readonly ModuleAssignment[] {
  const lines = doc.split('\n');
  const headerAt = lines.findIndex((line) => line.trim() === MODULE_TABLE_HEADER);
  if (headerAt < 0) return [];
  const found: ModuleAssignment[] = [];
  for (let cursor = headerAt + 2; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trimStart().startsWith('|')) break;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 4) continue;
    const moduleName = cells[0].trim();
    const tables = [
      ...new Set(
        [...cells[3].matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]).filter((name) => known.has(name)),
      ),
    ];
    if (moduleName.length > 0 && tables.length > 0) found.push({ module: moduleName, tables });
  }
  return found;
}

/* ------------------------------------------- *
 * Cardinality, derived from drizzle reflection *
 * ------------------------------------------- */

/**
 * `exactlyOne` — every column of the foreign key is NOT NULL, so a child row
 * always names a parent. `zeroOrOne` — at least one is nullable.
 */
export type ParentCardinality = 'exactlyOne' | 'zeroOrOne';

/**
 * `atMostOne` — a unique constraint proves a parent has no more than one child
 * across this key. `many` — nothing in the schema bounds it.
 *
 * There is deliberately no `oneOrMore`: "every parent must have at least one
 * child" is not expressible in a foreign key, a NOT NULL or a unique index, so
 * no member of this type may claim it. That is the honest half of the
 * derivation and the renderer states it in the legend rather than guessing.
 */
export type ChildCardinality = 'atMostOne' | 'many';

export interface CardinalityEdge {
  readonly child: string;
  readonly parent: string;
  readonly columns: readonly string[];
  readonly parentSide: ParentCardinality;
  readonly childSide: ChildCardinality;
  readonly onDelete: string;
}

/**
 * Every column set the table is unique on, EXCLUDING partial unique indexes.
 *
 * A partial unique constrains only the rows matching its predicate, so it says
 * nothing about the table — reading one as a 1:1 is the "guard wider than the
 * index it guards" mistake `merge-plan.ts` records, pointed the other way.
 * Expression indexes are skipped for the same reason: a unique over
 * `lower(name)` is not a unique over `name`.
 */
export function uniqueColumnSets(table: PgTable): readonly ReadonlySet<string>[] {
  const config = getTableConfig(table);
  const sets: ReadonlySet<string>[] = [];

  /**
   * Declared property name → SQL name, built from the table's REAL columns.
   *
   * An index's entries are `IndexedColumn`, not `Column`, so `is(x, Column)` is
   * false for every one of them and `getColumnCasing` will not take them. That
   * is worth stating because of how it failed: treating a non-`Column` as an
   * expression and skipping the index made this function drop EVERY unique
   * index, which turned the epic's one real 1:1 into a 1:N and produced a
   * diagram that was merely less true — no error, no empty output, nothing to
   * notice. It was caught by a known-answer baseline
   * (`native_variant_signatures`), which is why the gate beside this asserts
   * that edge by name rather than only counting.
   */
  const sqlNameByKey = new Map(config.columns.map((column) => [column.name, sqlColumnName(column)]));

  for (const constraint of config.uniqueConstraints) {
    sets.push(new Set(constraint.columns.map(sqlColumnName)));
  }
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    if (index.config.where) continue;
    const names: string[] = [];
    let expression = false;
    for (const column of index.config.columns) {
      const key = is(column, Column) ? sqlColumnName(column as PgColumn) : sqlNameByKey.get((column as { name?: string })?.name ?? '');
      if (key === undefined) expression = true;
      else names.push(key);
    }
    if (expression) continue;
    sets.push(new Set(names));
  }
  const inlinePrimary = config.columns.filter((column) => column.primary).map(sqlColumnName);
  if (inlinePrimary.length > 0) sets.push(new Set(inlinePrimary));
  for (const primary of config.primaryKeys) {
    sets.push(new Set(primary.columns.map(sqlColumnName)));
  }

  // An EMPTY set would make the subset test below vacuously true — `[].every()`
  // is `true` — and turn every foreign key on the table into a claimed 1:1.
  // None exists today (measured: zero across all 452 tables), which is exactly
  // why the guard has to be here rather than in a comment: the day drizzle
  // reflects one, the failure is a diagram asserting relationships the schema
  // does not have, in the direction that looks like a deliberate design.
  return sets.filter((set) => set.size > 0);
}

/** Every foreign key drizzle will emit, with the cardinality the schema proves. */
export function cardinalityEdges(): readonly CardinalityEdge[] {
  const edges: CardinalityEdge[] = [];
  for (const [name, table] of tablesByName) {
    const config = getTableConfig(table);
    const uniques = uniqueColumnSets(table);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const columns = reference.columns.map(sqlColumnName);
      const columnSet = new Set(columns);
      edges.push({
        child: name,
        parent: getTableName(reference.foreignTable),
        columns,
        parentSide: reference.columns.every((column) => column.notNull) ? 'exactlyOne' : 'zeroOrOne',
        // A unique whose columns are a SUBSET of the foreign key's columns pins
        // every one of them for a given parent row, so at most one child can
        // exist. A unique over a SUPERSET does not: `(category_id, locale)`
        // permits many aliases per category.
        childSide: uniques.some((unique) => [...unique].every((column) => columnSet.has(column)))
          ? 'atMostOne'
          : 'many',
        onDelete: foreignKey.onDelete ?? 'no action',
      });
    }
  }
  return edges.sort(
    (left, right) =>
      left.child.localeCompare(right.child) ||
      left.parent.localeCompare(right.parent) ||
      left.columns.join().localeCompare(right.columns.join()),
  );
}

/* --------------------------------------------------- *
 * Write ownership, measured over the production source *
 * --------------------------------------------------- */

/**
 * Every production module under `src/`, with comments stripped.
 *
 * Comments are removed because a census over source that reads them measures
 * prose: this repository documents what its modules refuse to do in the same
 * vocabulary those modules would use to do it, and `catalog-table-ownership.md`
 * itself quotes `.insert(`/`.update(` while describing a gate.
 */
export function productionSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const rel = relative(SRC_ROOT, path);
      if (rel.split(sep).includes('__tests__')) continue;
      sources.set(rel, stripComments(readFileSync(path, 'utf8')));
    }
  };
  walk(SRC_ROOT);
  return sources;
}

/**
 * Block and line comments out, string and template literals kept.
 *
 * Kept because a raw-SQL write lives inside a template literal, so a stripper
 * that removed literals would make the raw-SQL half of the census answer a
 * clean zero — the failure mode with no symptom.
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (mode === 'code') {
      if (two === '//') {
        mode = 'line';
        index += 2;
        continue;
      }
      if (two === '/*') {
        mode = 'block';
        index += 2;
        continue;
      }
      if (source[index] === "'") mode = 'single';
      else if (source[index] === '"') mode = 'double';
      else if (source[index] === '`') mode = 'template';
      out += source[index];
      index += 1;
      continue;
    }
    if (mode === 'line') {
      if (source[index] === '\n') {
        mode = 'code';
        out += '\n';
      }
      index += 1;
      continue;
    }
    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code';
        index += 2;
        continue;
      }
      if (source[index] === '\n') out += '\n';
      index += 1;
      continue;
    }
    // Inside a literal: copy through, honouring backslash escapes so an escaped
    // quote does not end it early.
    if (source[index] === '\\') {
      out += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (source[index] === closer) mode = 'code';
    out += source[index];
    index += 1;
  }
  return out;
}

export type WriteOperation = 'insert' | 'update' | 'delete';

export interface TableWriter {
  /** The directory the writing module sits in, relative to `src/`. */
  readonly directory: string;
  readonly files: readonly string[];
  readonly operations: readonly WriteOperation[];
}

/** A drizzle write through the query builder: `.insert(categoryAliases)`. */
const BUILDER_WRITE = /\.(insert|update|delete)\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g;

/**
 * A write in raw SQL, which the builder scan cannot see at all.
 *
 * Included because the builder scan alone would report "no application writer"
 * for a table only ever written through `db.execute(sql\`…\`)`, and "nobody
 * writes this" is exactly the reading under which a second writer gets added.
 */
const RAW_WRITE = /\b(?:insert\s+into|update|delete\s+from)\s+"?([a-z][a-z0-9_]*)"?/gi;

/** For each table, every directory under `src/` that issues a write against it. */
export function writeCensus(
  sources: ReadonlyMap<string, string>,
  symbols: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): ReadonlyMap<string, readonly TableWriter[]> {
  const perTable = new Map<string, Map<string, { files: Set<string>; operations: Set<WriteOperation> }>>();
  const record = (table: string, file: string, operation: WriteOperation): void => {
    if (!known.has(table)) return;
    const directory = dirname(file) === '.' ? '(src root)' : dirname(file).split(sep).join('/');
    let byDirectory = perTable.get(table);
    if (!byDirectory) {
      byDirectory = new Map();
      perTable.set(table, byDirectory);
    }
    let bucket = byDirectory.get(directory);
    if (!bucket) {
      bucket = { files: new Set(), operations: new Set() };
      byDirectory.set(directory, bucket);
    }
    bucket.files.add(file.split(sep).join('/'));
    bucket.operations.add(operation);
  };

  for (const [file, source] of sources) {
    for (const match of source.matchAll(BUILDER_WRITE)) {
      const table = symbols.get(match[2]);
      if (table) record(table, file, match[1] as WriteOperation);
    }
    for (const match of source.matchAll(RAW_WRITE)) {
      const verb = match[0].trim().slice(0, 6).toLowerCase();
      const operation: WriteOperation = verb.startsWith('insert')
        ? 'insert'
        : verb.startsWith('update')
          ? 'update'
          : 'delete';
      record(match[1].toLowerCase(), file, operation);
    }
  }

  return new Map(
    [...perTable]
      .map(
        ([table, byDirectory]) =>
          [
            table,
            [...byDirectory]
              .map(([directory, bucket]) => ({
                directory,
                files: [...bucket.files].sort(),
                operations: [...bucket.operations].sort(),
              }))
              .sort((left, right) => left.directory.localeCompare(right.directory)),
          ] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/* --------------------- *
 * The assembled model    *
 * --------------------- */

export interface ArchitectureModel {
  readonly population: ReadonlyMap<string, number>;
  readonly modules: readonly ModuleAssignment[];
  readonly edges: readonly CardinalityEdge[];
  readonly writers: ReadonlyMap<string, readonly TableWriter[]>;
}

export function buildModel(): ArchitectureModel {
  const population = epicPopulation();
  const known = new Set(population.keys());
  const doc = readFileSync(OWNERSHIP_DOC, 'utf8');
  return {
    population,
    modules: moduleAssignments(doc, known),
    edges: cardinalityEdges(),
    writers: writeCensus(productionSources(), tableNameBySymbol, known),
  };
}
