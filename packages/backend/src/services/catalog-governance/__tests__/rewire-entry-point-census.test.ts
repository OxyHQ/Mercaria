/**
 * Every `rewired_by_domain` claim names a path that EXISTS and IS CALLED
 * (#739).
 *
 * ## The defect
 *
 * `impact-plan.ts` marks a reference `rewired_by_domain` to mean "a real,
 * existing, idempotent path fixes these rows after the change" — its own words.
 * `impact.service.ts` filters only `rewire_path_missing` into the operator's
 * gap warning, so **a false `rewired_by_domain` is silent by construction**:
 * the preview reports no gap for rows about to be dropped, and nothing anywhere
 * goes red.
 *
 * A sweep of all fourteen path-asserting entries found TWO false. Both named a
 * real, correct, tested function with ZERO production callers:
 * `copyForwardProductTypeLocalizations` (#650, closed in this change) and
 * `issueCategoryLocalizedSlug` (still open, and now honestly labelled
 * `rewire_path_missing`). Two more named a path that ends in
 * `attribute_reindex_requests`, a queue with three enqueuers and no consumer.
 *
 * ## Why this file rather than a wider `note` regex
 *
 * `impact-plan-census.test.ts` already carried the shape, for exactly ONE
 * relation: `expect(listingPin?.note ?? '').toMatch(/applyListingProductTypeUpgrade/u)`.
 * Generalising a regex over prose is not possible — a note is a sentence, and
 * "which identifier in it is the entry point" has no answer a machine can read.
 * So the identifier moved OUT of the prose into `RewireEntryPoint`, and this is
 * what reads it.
 *
 * ## What each check can actually fail on
 *
 *  - a named symbol that no module exports — a rename, or a name never right;
 *  - a symbol exported and CALLED BY NOTHING, which is the defect itself and
 *    the one a "does the function exist" check cannot see;
 *  - a trigger no migration creates;
 *  - a queue declared undrained that has since GAINED a consumer, which is the
 *    direction a list that only grows can never report.
 *
 * Every population is walked, every walk carries a vacuity floor, and every
 * detector carries a mutation self-test — because a scan that found nothing and
 * a repository with nothing to find produce the same green.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, type Table } from 'drizzle-orm';
import { CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS } from '@mercaria/shared-types';
import { stripComments } from '../../../__tests__/package-barrel-symbols.js';
import { SRC_ROOT, walkOwnedDirectory } from '../../../__tests__/domain-population.js';
import {
  GOVERNED_REFERENCE_PLAN,
  referenceKey,
  rewireEntryPoint,
  rewiresAwaitingDrain,
  type GovernedReference,
  type RewireEntryPoint,
} from '../impact-plan.js';

/** `packages/backend/drizzle`, where every applied migration lives. */
const MIGRATIONS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');

/** This plan's own module, excluded from every call-site population. */
const PLAN_MODULE = 'services/catalog-governance/impact-plan.ts';

/**
 * Every production `.ts` under `src/`, comment-stripped, keyed by path.
 *
 * COMMENT-STRIPPED because this repository documents what it forbids in the
 * same vocabulary it forbids — `trace.service.ts`'s docblock names
 * `listPendingReindexRequests` while asserting nothing calls it — so a scan
 * that kept comments would report a caller for a function nothing calls, which
 * is precisely the reading this gate exists to refuse.
 *
 * `walkOwnedDirectory` drops the `__tests__` tree; the `.test.ts` filter drops
 * the co-located ones. A test is not a production call site, and counting one
 * would have made every entry here green for the whole time the bug was live.
 */
function productionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const relative of walkOwnedDirectory('')) {
    if (relative.endsWith('.test.ts')) continue;
    sources.set(relative, stripComments(readFileSync(join(SRC_ROOT, relative), 'utf8')));
  }
  return sources;
}

const SOURCES = productionSources();

/** Every `.sql` under `drizzle/`, concatenated. Migrations are never edited. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(join(MIGRATIONS_ROOT, name), 'utf8'))
    .join('\n');
}

const MIGRATION_SQL = migrationSql();
const MIGRATION_COUNT = readdirSync(MIGRATIONS_ROOT).filter((name) => name.endsWith('.sql')).length;

/** Every `rewired_by_domain` reference in the plan, with its subject kind. */
function pathAsserting(): { kind: string; reference: GovernedReference; entryPoint: RewireEntryPoint }[] {
  const found: { kind: string; reference: GovernedReference; entryPoint: RewireEntryPoint }[] = [];
  for (const kind of CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS) {
    for (const reference of GOVERNED_REFERENCE_PLAN[kind]) {
      const entryPoint = rewireEntryPoint(reference);
      if (entryPoint !== null) found.push({ kind, reference, entryPoint });
    }
  }
  return found;
}

/** The module that EXPORTS `symbol`, or `null`. Anchored on the export form. */
function moduleExporting(symbol: string): string | null {
  const pattern = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${symbol}\\b`,
    'u',
  );
  for (const [relative, source] of SOURCES) {
    if (relative === PLAN_MODULE) continue;
    if (pattern.test(source)) return relative;
  }
  return null;
}

/**
 * Production modules that NAME `symbol` and do not define it.
 *
 * A textual reference, not a parsed call — so a module that IMPORTS the symbol
 * and never calls it would count. That limit is stated rather than papered
 * over: distinguishing the two needs a parser, and the failure it admits is a
 * dangling import, which `@typescript-eslint/no-unused-vars` reports (as a
 * WARNING, not an error — measured, so this is a mitigation and not a second
 * gate). The defect this file exists for is a symbol NOTHING mentions, which a
 * textual scan catches exactly.
 *
 * What is deliberately NOT counted is the plan itself: a declaration citing its
 * own declaration is a control whose subject is the control. Nor is the
 * defining module, so a recursive call cannot stand in for a caller.
 */
function callSites(symbol: string, definedIn: string): string[] {
  const pattern = new RegExp(`\\b${symbol}\\b`, 'u');
  const found: string[] = [];
  for (const [relative, source] of SOURCES) {
    if (relative === PLAN_MODULE || relative === definedIn) continue;
    if (pattern.test(source)) found.push(relative);
  }
  return found;
}

/** `processed_at` -> `processedAt`, the spelling drizzle holds. */
function camelCase(name: string): string {
  return name.replace(/_([a-z])/gu, (_all, letter: string) => letter.toUpperCase());
}

/**
 * Production modules that WRITE a queue's completion column.
 *
 * Three narrowings, and each of them was a wrong answer first:
 *
 * 1. **Scoped to modules that also name the queue's own table.** `processed_at`
 *    is a column half the outboxes in this repository carry, and an unscoped
 *    scan finds `offerOutboxRepository`'s write and concludes the REINDEX queue
 *    has a consumer.
 * 2. **A property ASSIGNMENT, not the column's presence.**
 *    `isNull(attributeReindexRequests.processedAt)` is a read, and it is the
 *    only occurrence in the whole reindex path.
 * 3. **Excluding a projection alias** (`processedAt: t.processedAt`), which is
 *    how a `select({...})` spells a read and is a real shape in
 *    `providerEventRepository`. Without the lookahead, a future operator
 *    listing that projected the column would turn this gate red for a read.
 *
 * The module must also contain a write VERB, so a file that only projects
 * cannot qualify on an assignment alone.
 *
 * Matching the ENCLOSING `.set({ … })` object was tried first and is wrong: a
 * drizzle `sql` template inside it (`${offerOutboxes.requestedRevision}`)
 * contains a `}`, so a `[^}]*` body stops before reaching the column and the
 * detector reported the real writer as clean. Its positive control caught it.
 */
function completionWriters(tableName: string, columnName: string): string[] {
  const camelTable = camelCase(tableName);
  const camelColumn = camelCase(columnName);
  const namesTable = new RegExp(`\\b(?:${tableName}|${camelTable})\\b`, 'u');
  const assigns = new RegExp(
    `\\b(?:${columnName}|${camelColumn})\\s*:\\s*(?!\\w+\\.(?:${columnName}|${camelColumn})\\b)`,
    'u',
  );
  const writeVerb = /\.(?:set|values)\(/u;
  const found: string[] = [];
  for (const [relative, source] of SOURCES) {
    // The schema module DECLARES the column (`processedAt: timestamptz()`),
    // which is an assignment and is not a write of a row.
    if (relative === PLAN_MODULE || relative.startsWith('db/schema/')) continue;
    if (!namesTable.test(source)) continue;
    if (!writeVerb.test(source)) continue;
    if (assigns.test(source)) found.push(relative);
  }
  return found;
}

describe('the populations this census walks', () => {
  it('walks a src tree and a migration set that are actually populated', () => {
    // Vacuity floors, per SHAPE rather than one total: the two sources break
    // independently, and one number lets either collapse to zero while the
    // other carries it. Printed on success, so a count in a passing run makes
    // an unrelated red legible.
    expect(SOURCES.size, `the src walk found ${String(SOURCES.size)} production modules`)
      .toBeGreaterThan(900);
    expect(MIGRATION_COUNT, `the drizzle walk found ${String(MIGRATION_COUNT)} migrations`)
      .toBeGreaterThan(100);
    expect(MIGRATION_SQL.length, 'the migration concatenation is empty').toBeGreaterThan(100_000);
  });

  it('excludes the test tree, so a test can never be read as a production caller', () => {
    for (const relative of SOURCES.keys()) {
      expect(relative).not.toMatch(/__tests__|\.test\.ts$/u);
    }
    // The positive control for that exclusion: a file that DOES exist and IS a
    // test. Without it, "no path matched" is satisfied by an empty walk.
    expect(existsSync(join(SRC_ROOT, PLAN_MODULE.replace('impact-plan.ts', '__tests__/impact-plan-census.test.ts')))).toBe(true);
  });

  it('strips comments, so a docblock naming a symbol is not a call site', () => {
    // The mutation self-test for the stripper this whole file rests on. The
    // repository documents what it forbids using the forbidden spelling, so a
    // stripper that kept comments would make every `callSites` result a lie in
    // the direction that passes.
    expect(stripComments('// issueCategoryLocalizedSlug(x)')).not.toContain(
      'issueCategoryLocalizedSlug',
    );
    expect(stripComments('/**\n * issueCategoryLocalizedSlug\n */')).not.toContain(
      'issueCategoryLocalizedSlug',
    );
    expect(stripComments('const a = issueCategoryLocalizedSlug(x);')).toContain(
      'issueCategoryLocalizedSlug',
    );
  });

  it('finds a path-asserting entry for every subject kind that declares one', () => {
    const entries = pathAsserting();
    // The census's own positive control. An empty list would satisfy every
    // `for` loop below by never running its body — the #706 defect, which is
    // what makes this floor mandatory rather than decorative.
    expect(entries.length, `${String(entries.length)} references assert a rewire path`)
      .toBeGreaterThanOrEqual(13);
    // Every kind is represented, so a vocabulary member that stops being used
    // stops being checked and somebody notices.
    const kinds = new Set(entries.map((entry) => entry.entryPoint.kind));
    expect([...kinds].sort()).toEqual(['derivation', 'function', 'trigger']);
  });
});

describe('every `rewired_by_domain` entry names a path that exists', () => {
  it('names a symbol some production module EXPORTS', () => {
    for (const { reference, entryPoint } of pathAsserting()) {
      if (entryPoint.kind === 'trigger') continue;
      const exporting = moduleExporting(entryPoint.symbol);
      expect(
        exporting,
        `${referenceKey(reference)} claims ${entryPoint.symbol} rewires its rows, and no ` +
          `production module exports it. Either the symbol was renamed, or the disposition ` +
          `should be rewire_path_missing.`,
      ).not.toBeNull();
      // …and the declaration names the RIGHT module, so a move is visible here
      // rather than only in whoever greps for it next.
      expect(
        `${entryPoint.module}.ts`,
        `${referenceKey(reference)} says ${entryPoint.symbol} lives in ${entryPoint.module}`,
      ).toBe(exporting);
    }
  });

  it('names a trigger some migration CREATEs', () => {
    let checked = 0;
    for (const { reference, entryPoint } of pathAsserting()) {
      if (entryPoint.kind !== 'trigger') continue;
      checked += 1;
      expect(
        MIGRATION_SQL.includes(`CREATE TRIGGER ${entryPoint.name}`),
        `${referenceKey(reference)} claims the trigger ${entryPoint.name} rewires its rows, and ` +
          `no migration creates one by that name.`,
      ).toBe(true);
    }
    // A floor, because `continue` on every entry is a loop that asserts nothing.
    expect(checked, 'no trigger entry point was checked').toBeGreaterThanOrEqual(1);
  });
});

describe('every `rewired_by_domain` entry names a path that is CALLED', () => {
  it('has at least one production call site outside its own module', () => {
    for (const { reference, entryPoint } of pathAsserting()) {
      if (entryPoint.kind === 'trigger') continue;
      const definedIn = moduleExporting(entryPoint.symbol) ?? '';
      const callers = callSites(entryPoint.symbol, definedIn);
      expect(
        callers,
        `${referenceKey(reference)} claims ${entryPoint.symbol} rewires its rows, and NOTHING ` +
          `in production calls it. A function that exists and is never called fixes no row, ` +
          `and impact.service.ts surfaces only rewire_path_missing — so this reads to an ` +
          `operator as "these rows will be fixed". Either wire it up, or move the entry to ` +
          `rewire_path_missing.`,
      ).not.toEqual([]);
    }
  });

  it('is mutation-tested: a symbol nothing calls is REPORTED', () => {
    // Without this the check above passes on any input, including one where
    // `callSites` silently returned every module for every symbol.
    const invented = `rewireNothingCalls${'X'.repeat(3)}`;
    expect(moduleExporting(invented)).toBeNull();
    expect(callSites(invented, '')).toEqual([]);

    // And the live control in the other direction: a symbol that IS exported
    // and IS called, so an empty result cannot be the walk being broken.
    const known = moduleExporting('copyForwardProductTypeLocalizations');
    expect(known).toBe('db/catalogLocalization/productTypeLocalizationRepository.ts');
    expect(callSites('copyForwardProductTypeLocalizations', known ?? '')).toContain(
      'services/product-types/product-type.service.ts',
    );
  });

  it('is mutation-tested: a trigger no migration creates is REPORTED', () => {
    expect(MIGRATION_SQL.includes('CREATE TRIGGER mercaria_no_such_trigger_exists')).toBe(false);
    // The positive control: the real one IS found, so a broken read of the
    // migration directory cannot make the assertion above pass by finding
    // nothing at all.
    expect(MIGRATION_SQL.includes('CREATE TRIGGER mercaria_categories_localization_stale')).toBe(
      true,
    );
  });
});

describe('a rewire that ends in a queue nothing drains', () => {
  it('is DECLARED, and the declaration matches what the repository does', () => {
    let checked = 0;
    for (const { reference, entryPoint } of pathAsserting()) {
      if (entryPoint.kind !== 'function' || entryPoint.queue === undefined) continue;
      checked += 1;
      const table = getTableName(entryPoint.queue.completion.table as Table);
      const column = entryPoint.queue.completion.name;
      const writers = completionWriters(table, column);

      if (entryPoint.queue.drain.state === 'absent') {
        expect(
          writers,
          `${referenceKey(reference)} declares ${table}.${column} is never written, and ` +
            `${writers.join(', ')} writes it. The queue has a consumer now: name it in the ` +
            `drain, so the impact report stops reporting these rows as awaiting one.`,
        ).toEqual([]);
      } else {
        // The reverse direction, so closing the gap is checked as hard as
        // opening it. A `present` drain that writes nothing is a consumer that
        // claims rows and never completes them.
        expect(writers.length, `${referenceKey(reference)} declares a drain that writes nothing`)
          .toBeGreaterThan(0);
      }
    }
    expect(checked, 'no queue-terminating entry point was checked').toBeGreaterThanOrEqual(2);
  });

  it('is mutation-tested: the write detector fires on a real drizzle write', () => {
    // The detector's own liveness. Scoped to the queue's table, so the proof
    // has to come from a module that names it — `offerOutboxRepository` writes
    // `processedAt` and is exactly the false positive an unscoped scan gives.
    expect(completionWriters('offer_outboxes', 'processed_at').length).toBeGreaterThan(0);
    expect(completionWriters('attribute_reindex_requests', 'processed_at')).toEqual([]);
  });

  it('names the EXACT relations awaiting a drain', () => {
    // The exact-identity device, pointed at the third list. Adding one means a
    // rewire stopped completing; removing one means somebody built the
    // consumer — and both have to be edited here with the reason in the diff,
    // because a list that only ever grows is a warning about a solved problem.
    const awaiting = CATALOG_GOVERNANCE_COUNTED_SUBJECT_KINDS.flatMap((kind) =>
      rewiresAwaitingDrain(kind),
    ).sort();
    expect(
      awaiting,
      'A queue-terminating rewire moved. Both directions are decisions: gaining one means a ' +
        'rewire now hands off to a queue nothing empties, and losing one means #664 built the ' +
        'consumer and the drain should name it.',
    ).toEqual(
      [
        // Both are `publishAttributeDefinition` enqueuing into
        // `attribute_reindex_requests`, which has three enqueuers and no
        // consumer (#664). The second is the high-cardinality one.
        'canonical_variant_attributes.attributeDefinitionId',
        'canonical_attribute_values.attributeDefinitionId',
      ].sort(),
    );
  });
});
