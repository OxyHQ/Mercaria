/**
 * #313 — a drizzle column object in a SELECT-list `sql` template renders BARE,
 * and then binds to whatever table the surrounding scope offers.
 *
 * ## The measured mechanism, which is NOT the one that was first recorded
 *
 * `PgDialect.buildSelection` (drizzle-orm 0.45.2, `pg-core/dialect.js:142`) is
 * handed `{ isSingleTable }`. When that is true it walks every chunk of a
 * selection-position `sql` template and REWRITES each `PgColumn` into
 * `sql.identifier(getColumnCasing(c))` — a bare, unqualified name. Nothing else
 * in the dialect touches a user-supplied template: the other two rewrite sites
 * are the UPDATE `set` target (line 110) and the ON CONFLICT target list
 * (line 361), where a bare name is correct and required.
 *
 * So the affected positions are exactly two, and they are the complete set:
 *
 *   - a field of `.select({...})` / `.selectDistinct` / `.selectDistinctOn`
 *   - a field of `.returning({...})`  (insert: always single-table;
 *     update: single-table unless it has a `from`)
 *
 * A bare name is harmless while the statement has ONE table in scope — it can
 * only resolve to that table. It becomes a silent wrong answer the moment the
 * template opens an inner scope, because a correlated subquery brings its own
 * table and the bare name binds to THAT one:
 *
 *   db.select({
 *     n: sql`(select count(*) from listing_photos p where p.listing_id = ${listings.id})`,
 *   }).from(listings)
 *
 *   -- emitted:
 *   select (select count(*) from listing_photos p where p.listing_id = "id") ...
 *                                                                      ^^^^
 *                                                        binds to p."id"
 *
 * Measured end to end against a real Postgres server: an independent raw-SQL
 * control confirmed four photo rows existed; the query above returned 0 for
 * every row, raised nothing, and produced exactly the number a genuinely
 * photo-less listing produces. `qualified()` returned 4.
 *
 * ## Two consequences worth stating, because both are counter-intuitive
 *
 * **A JOIN hides it.** With a join, `isSingleTable` is false, no rewrite
 * happens, and the identical template renders `"listings"."id"` and is correct.
 * So the bug is not a property of the template — it is a property of the
 * template PLUS the shape of the query it lands in, and adding or removing an
 * unrelated join silently changes the answer.
 *
 * **A WHERE clause is never rewritten.** `buildSelection` is not involved, so a
 * correlated reference in a `.where()` renders fully qualified and is correct.
 * There are 37 such templates in this repository and all of them are fine.
 *
 * ## What this gate does, and why it is scoped the way it is
 *
 * It fails the build on a selection-position `sql` template that interpolates a
 * real drizzle column AND opens an inner `select ... from` scope. It does not
 * ask whether the query has a join: `qualified()` is correct either way, the
 * join-dependence above is precisely what makes "it works today" worthless, and
 * the census found zero findings under the stricter rule, so the broader rule
 * costs nothing and needs no exemption list to erode.
 *
 * It deliberately does NOT flag the same shape in a `.where()`. That is not
 * leniency — it is the difference between the 37 safe uses and the dangerous
 * one, and a gate that could not tell them apart would be turned off by the
 * first person to hit it.
 *
 * Two things make the zero it currently reports mean something. The floors
 * below prove each half of the conjunction is detectable on real code — 165
 * selection-position templates DO interpolate a resolved column, 129 templates
 * DO open an inner scope, and 37 combine both in other positions — so a zero
 * cannot come from a detector that stopped resolving columns or stopped seeing
 * subqueries. And the controls prove the detector fires on the real shape,
 * including through an aliased and a namespaced import, both of which occur in
 * this repository.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableColumns, is, sql, Table } from 'drizzle-orm';
import { DATABASE_CASING, qualified } from '@oxyhq/db';
import * as schema from '../schema/index';
import { listings } from '../schema/catalog';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Both directories that hold drizzle queries, not just `src/`.
 *
 * `scripts/` carries `offer-load-benchmark.ts` and the e2e harnesses, which
 * issue real selects — and a scan that never opened a file reports it clean,
 * which is the failure this whole gate is about. `vitest.config.ts` includes
 * `scripts/` in its test glob for the same reason.
 */
const SCANNED_ROOTS = ['src', 'scripts'].map((dir) => join(PACKAGE_ROOT, dir));

/** The selection positions `buildSelection` rewrites. Complete, per the dialect. */
const SELECTION_METHODS = new Set(['select', 'selectDistinct', 'selectDistinctOn', 'returning']);

/**
 * A template opens an inner scope only via a nested `select ... from`.
 *
 * Matching a bare `from` was tried first and is WRONG: it flags
 * `extract(epoch from ${col})`, which is SQL's `EXTRACT(field FROM source)`
 * syntax and introduces no table at all. That produced three false positives on
 * the first run of this census — `merchantCatalogRepository`, `matchQueueRepository`
 * and `curationRepository` — every one of them a timestamp aggregate.
 */
const opensInnerScope = (literal: string): boolean => /\bselect\b[\s\S]*\bfrom\b/i.test(literal);

/** Every exported drizzle table, and the columns it really has. */
const schemaTables = new Map<string, Set<string>>();
for (const [name, value] of Object.entries(schema as Record<string, unknown>)) {
  if (!is(value as never, Table)) continue;
  schemaTables.set(name, new Set(Object.keys(getTableColumns(value as never))));
}

interface Finding {
  file: string;
  line: number;
  columns: string[];
}

interface ScanStats {
  selectionTemplates: number;
  selectionTemplatesWithColumn: number;
  templatesOpeningInnerScope: number;
  correlatedColumnOutsideSelection: number;
}

const emptyStats = (): ScanStats => ({
  selectionTemplates: 0,
  selectionTemplatesWithColumn: 0,
  templatesOpeningInnerScope: 0,
  correlatedColumnOutsideSelection: 0,
});

/**
 * The detector, run over one file's source.
 *
 * Column resolution goes through the REAL schema rather than a naming
 * heuristic, so `row.id` and `config.status` are not mistaken for columns.
 * Aliased (`import { orders as ordersTable }`) and namespaced
 * (`import * as schema`) imports are both resolved, because both occur here and
 * a resolver blind to them reports a clean estate for the files that use them.
 */
function scanSource(file: string, text: string, stats: ScanStats): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];

  const localTable = new Map<string, string>();
  const namespaces = new Set<string>();
  const collectImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      } else {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (schemaTables.has(imported)) localTable.set(element.name.text, imported);
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(source);

  const resolveColumn = (expression: ts.Expression): string | null => {
    if (!ts.isPropertyAccessExpression(expression)) return null;
    const column = expression.name.text;
    const target = expression.expression;

    if (ts.isIdentifier(target)) {
      const table =
        localTable.get(target.text) ?? (schemaTables.has(target.text) ? target.text : null);
      if (table && schemaTables.get(table)?.has(column)) return `${table}.${column}`;
      return null;
    }
    // `schema.listings.id`
    if (
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      namespaces.has(target.expression.text)
    ) {
      const table = target.name.text;
      if (schemaTables.get(table)?.has(column)) return `${table}.${column}`;
    }
    return null;
  };

  /** Is this template a VALUE in the object literal handed to a selection call? */
  const inSelectionPosition = (node: ts.Node): boolean => {
    const property = node.parent;
    if (!property || !ts.isPropertyAssignment(property)) return false;
    const object = property.parent;
    if (!object || !ts.isObjectLiteralExpression(object)) return false;
    const call = object.parent;
    if (!call || !ts.isCallExpression(call)) return false;
    // `selectDistinctOn(columns, fields)` puts the fields in argument 1, so the
    // argument INDEX is not part of the test.
    if (!call.arguments.some((argument) => argument === object)) return false;
    return (
      ts.isPropertyAccessExpression(call.expression) &&
      SELECTION_METHODS.has(call.expression.name.text)
    );
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'sql'
    ) {
      const literal = ts.isTemplateExpression(node.template)
        ? node.template.head.text +
          node.template.templateSpans.map((span) => span.literal.text).join(' ')
        : node.template.text;
      const spans = ts.isTemplateExpression(node.template) ? node.template.templateSpans : [];
      const columns = spans
        .map((span) => resolveColumn(span.expression))
        .filter((name): name is string => name !== null);

      const innerScope = opensInnerScope(literal);
      const selection = inSelectionPosition(node);

      if (innerScope) stats.templatesOpeningInnerScope++;
      if (selection) {
        stats.selectionTemplates++;
        if (columns.length > 0) stats.selectionTemplatesWithColumn++;
      } else if (columns.length > 0 && innerScope) {
        stats.correlatedColumnOutsideSelection++;
      }

      if (selection && innerScope && columns.length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        findings.push({ file, line: line + 1, columns });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return findings;
}

/** Walk a directory for `.ts`, the house pattern. */
function collectSourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = SCANNED_ROOTS.flatMap((root) => collectSourceFiles(root));
const stats = emptyStats();
const findings = files.flatMap((file) =>
  scanSource(relative(PACKAGE_ROOT, file).split(sep).join('/'), readFileSync(file, 'utf8'), stats),
);

describe('#313 — a column object in a selection-position sql template', () => {
  it('renders BARE, which is why this gate exists', () => {
    // The premise, pinned against drizzle itself rather than described. If a
    // future drizzle qualifies these chunks, this assertion fails and the gate
    // can be retired — rather than going on guarding a hazard that no longer
    // exists, which is how a gate quietly becomes decoration.
    const db = drizzle({} as never, { casing: DATABASE_CASING });
    const correlated = sql<string>`(select count(*) from listing_condition_photos p where p.listing_id = ${listings.id})`;

    const single = db.select({ id: listings.id, n: correlated }).from(listings).toSQL().sql;
    expect(single, 'a single-table select must still emit the BARE name').toContain(
      'p.listing_id = "id"',
    );
    expect(single).not.toContain('p.listing_id = "listings"."id"');

    // The remedy, pinned in the same currency.
    const fixed = db
      .select({
        id: listings.id,
        n: sql<string>`(select count(*) from listing_condition_photos p where p.listing_id = ${qualified(listings.id)})`,
      })
      .from(listings)
      .toSQL().sql;
    expect(fixed, '`qualified()` must survive the rewrite').toContain(
      'p.listing_id = "listings"."id"',
    );

    // And the position that is NOT rewritten, which is what stops this gate
    // flagging the 37 safe correlated references in `.where()`.
    const whereClause = db
      .select({ id: listings.id })
      .from(listings)
      .where(sql`exists (select 1 from listing_condition_photos p where p.listing_id = ${listings.id})`)
      .toSQL().sql;
    expect(whereClause, 'a WHERE clause is never rewritten').toContain(
      'p.listing_id = "listings"."id"',
    );
  });

  it('is detected — positive control, including through an alias and a namespace', () => {
    // A positive control in the same currency as the measurement: these run
    // through the very detector the repository scan uses. Without them, a
    // detector that resolved no columns at all would report the same clean
    // estate the repository legitimately has.
    const direct = scanSource(
      'control-direct.ts',
      `import { listings } from '../schema/catalog';
       const q = db.select({
         n: sql<string>\`(select count(*) from photos p where p.listing_id = \${listings.id})\`,
       }).from(listings);`,
      emptyStats(),
    );
    expect(direct).toHaveLength(1);
    expect(direct[0].columns).toEqual(['listings.id']);

    const aliased = scanSource(
      'control-alias.ts',
      `import { listings as listingTable } from '../schema/catalog';
       const q = db.select({
         n: sql<string>\`(select count(*) from photos p where p.listing_id = \${listingTable.id})\`,
       }).from(listingTable);`,
      emptyStats(),
    );
    expect(aliased, 'an aliased import must still resolve').toHaveLength(1);

    const namespaced = scanSource(
      'control-namespace.ts',
      `import * as schema from '../schema/index';
       const q = db.select({
         n: sql<string>\`(select count(*) from photos p where p.listing_id = \${schema.listings.id})\`,
       }).from(schema.listings);`,
      emptyStats(),
    );
    expect(namespaced, 'a namespaced import must still resolve').toHaveLength(1);

    const returning = scanSource(
      'control-returning.ts',
      `import { listings } from '../schema/catalog';
       const q = db.insert(listings).values(row).returning({
         n: sql<string>\`(select count(*) from photos p where p.listing_id = \${listings.id})\`,
       });`,
      emptyStats(),
    );
    expect(returning, '`returning` is rewritten too').toHaveLength(1);
  });

  it('does not flag the shapes that are genuinely safe — negative controls', () => {
    // Each of these is a real class this repository contains. A gate that
    // flagged them would be disabled by whoever hit it first, so each one is
    // pinned rather than left to judgement.
    const remedy = scanSource(
      'control-qualified.ts',
      `import { listings } from '../schema/catalog';
       const q = db.select({
         n: sql<string>\`(select count(*) from photos p where p.listing_id = \${qualified(listings.id)})\`,
       }).from(listings);`,
      emptyStats(),
    );
    expect(remedy, '`qualified()` is the remedy and must be accepted').toHaveLength(0);

    const extract = scanSource(
      'control-extract.ts',
      `import { matchQueue } from '../schema/matching';
       const q = db.select({
         age: sql<number>\`extract(epoch from (now() - min(\${matchQueue.createdAt})))\`,
       }).from(matchQueue);`,
      emptyStats(),
    );
    expect(extract, 'EXTRACT(field FROM source) opens no scope').toHaveLength(0);

    const whereClause = scanSource(
      'control-where.ts',
      `import { listings } from '../schema/catalog';
       const q = db.select({ id: listings.id }).from(listings)
         .where(sql\`exists (select 1 from photos p where p.listing_id = \${listings.id})\`);`,
      emptyStats(),
    );
    expect(whereClause, 'a WHERE clause is not rewritten by buildSelection').toHaveLength(0);

    const noSubquery = scanSource(
      'control-no-subquery.ts',
      `import { priceAlerts } from '../schema/priceAlerts';
       const q = db.select({
         pending: sql<number>\`count(*) filter (where \${priceAlerts.state} = 'pending')::int\`,
       }).from(priceAlerts);`,
      emptyStats(),
    );
    expect(noSubquery, 'a bare name with one table in scope resolves correctly').toHaveLength(0);

    const notAColumn = scanSource(
      'control-not-a-column.ts',
      `const q = db.select({
         n: sql<string>\`(select count(*) from photos p where p.listing_id = \${row.id})\`,
       }).from(listings);`,
      emptyStats(),
    );
    expect(notAColumn, '`row.id` is not a drizzle column').toHaveLength(0);
  });

  it('scanned enough to mean something', () => {
    // "I found none" and "I could not see any" produce the same number. Every
    // floor below is a component of the conjunction the gate looks for, each
    // measured non-zero on real repository code, so a zero can only be the
    // intersection and never a dead detector.
    expect(schemaTables.size, 'schema failed to load').toBeGreaterThanOrEqual(250);
    expect(files.length, 'the walk found no source').toBeGreaterThanOrEqual(1_000);
    expect(
      stats.selectionTemplates,
      'no selection-position sql templates seen — the position test is broken',
    ).toBeGreaterThanOrEqual(150);
    expect(
      stats.selectionTemplatesWithColumn,
      'no column resolved in a selection template — column resolution is broken',
    ).toBeGreaterThanOrEqual(80);
    expect(
      stats.templatesOpeningInnerScope,
      'no template opened an inner scope — the subquery test is broken',
    ).toBeGreaterThanOrEqual(60);
    expect(
      stats.correlatedColumnOutsideSelection,
      'the full conjunction was found nowhere at all, so its absence in the ' +
        'selection position says nothing — 37 such templates exist in `.where()`',
    ).toBeGreaterThanOrEqual(15);
  });

  it('appears nowhere in this repository', () => {
    const report = findings.map((f) => `${f.file}:${f.line} [${f.columns.join(', ')}]`);
    expect(
      report,
      'A selection-position `sql` template interpolates a drizzle column into a ' +
        'correlated subquery. drizzle renders that column BARE, so it binds to ' +
        "the subquery's own table and the query silently returns the wrong " +
        'answer with no error. Wrap the column in `qualified()` from `@oxyhq/db`.',
    ).toEqual([]);
  });
});
