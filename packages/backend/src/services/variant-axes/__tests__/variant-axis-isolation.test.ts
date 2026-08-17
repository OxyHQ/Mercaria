/**
 * The walls around the typed-variant-axis domain (#367 step 4, ADR 0007 D6/D7).
 *
 * Five scanned gates over every module in `services/variant-axes/`,
 * `db/variantAxes/` and `db/schema/variantAxes.ts` — the whole DIRECTORIES, so
 * each wall holds for modules nobody has written yet. Every one carries a
 * vacuity floor read off the real tree (a scan of nothing passes every pattern)
 * and a mutation self-test proving the detector fires on the shape it is hunting.
 *
 * ## Why each wall is here rather than being a habit
 *
 * 1. **No canonical identity.** ADR 0007 D7: a merchant's claim and Mercaria's
 *    selected canonical fact are different rows, both retained. A module here
 *    reaching `canonical_attribute_values` would make a claim a canonical fact
 *    by being written, skipping #56's selection and provenance machinery.
 * 2. **No fuzzy matching.** ADR 0007 D6 names the failure by name: inventing a
 *    normalization for `Tono` because it looks like `Color` is the false merge
 *    #58 is shaped around. The detector hunts CALL SHAPES and imports rather
 *    than words, because `LEGACY_OPTION_FORBIDDEN_FOLDS` states the prohibition
 *    using those very words as VALUES — a word-based scan would fire on the list
 *    that exists to prevent the thing.
 * 3. **No matrix generator.** "Matrices are sparse — nothing generates the full
 *    Cartesian product as rows" is an ABSENCE, and an absence is only checkable
 *    if something is looking for the thing.
 * 4. **No write to the legacy option tables.** ADR 0007 D13 retains both, and
 *    "retained, not silently normalized" is a property of the call graph here:
 *    this domain READS them and the catalog repositories keep the writes.
 * 5. **No ranking, fee or referral reference.** ADR 0007's non-goals: ranking is
 *    #74's, behind its versioned policy, and a variant axis is one join from a
 *    plan-weighted ordering.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_OPTION_FORBIDDEN_FOLDS,
  LEGACY_OPTION_NAME_FOLDS,
} from '../legacy-resolution.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const SCANNED_DIRECTORIES = [
  join(SRC_ROOT, 'services', 'variant-axes'),
  join(SRC_ROOT, 'db', 'variantAxes'),
];

/** Every production module in the domain. Tests are excluded — they name what they refuse. */
function domainFiles(): string[] {
  const files: string[] = [];
  for (const root of SCANNED_DIRECTORIES) {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) continue;
      if (!entry.endsWith('.ts')) continue;
      files.push(full);
    }
  }
  files.push(join(SRC_ROOT, 'db', 'schema', 'variantAxes.ts'));
  files.push(join(SRC_ROOT, 'scripts', 'backfill-variant-axes.ts'));
  return files;
}

/**
 * Strip comments before scanning.
 *
 * Load-bearing rather than tidy: every module in this domain documents what it
 * refuses to do in the same vocabulary the detectors hunt, so an unstripped scan
 * fires on the prose explaining why the thing is forbidden. Two agents and one
 * lead have been bitten by exactly that in this repository.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A canonical identity, in every spelling that reaches one. */
const CANONICAL_REFERENCE =
  /canonical_products|canonical_variants|canonical_attribute_values|canonicalProducts\b|canonicalVariants\b|canonicalAttributeValues\b|schema\/canonicalCatalog|canonical\/canonical-/;

/**
 * A similarity metric, as a CALL or an IMPORT.
 *
 * Call-shaped on purpose. `LEGACY_OPTION_FORBIDDEN_FOLDS` names
 * `fuzzy_match`, `trigram_similarity` and `edit_distance` as string VALUES, and a
 * bare-word scan would report the prohibition list as a violation — the check
 * that fires on its own guard rail.
 */
const FUZZY_REFERENCE =
  /\b(similarity|levenshtein|jaroWinkler|jaro_winkler|editDistance|soundex|metaphone|damerau|fuzzyMatch|closestMatch|bestMatch)\s*\(|from\s+'(?:[^']*\/)?(?:fuse(?:\.js)?|fuzzysort|fuzzy|leven|fast-levenshtein|fastest-levenshtein|string-similarity|natural)'|pg_trgm|<->|word_similarity/;

/** A generator that would turn an axis list into rows. */
const MATRIX_GENERATOR_REFERENCE =
  /\b(cartesian|cartesianProduct|crossProduct|allCombinations|permutations|generateMatrix|expandMatrix|buildMatrix)\b/;

/**
 * A WRITE to either legacy option table.
 *
 * Read access is legitimate and is what `legacyOptionRepository.ts` exists for,
 * so the detector is about the STATEMENT rather than the table.
 */
const LEGACY_OPTION_WRITE_REFERENCE =
  /\.(insert|update|delete)\(\s*(listingOptions|productVariantOptionValues)\b|catalog\/listingRepository|catalog\/variantRepository|catalog-write\.service|replaceListingOptions|replaceVariantOptionValues/;

/** Ranking, fees and referrals — ADR 0007's non-goals. */
const COMMERCIAL_REFERENCE =
  /services\/ranking\/|\.\.\/ranking\/|rankingPolicy|rankOffers|ranking_policy_versions|services\/fees\/|\.\.\/fees\/|fee_schedules|marketplace_fee|services\/referral|referral_|services\/payments\/|\.\.\/payments\//;

describe('the enumeration itself', () => {
  it('finds every module in the domain, with a floor read off the real tree', () => {
    // A scan of nothing passes every pattern below. The floor is counted from
    // the directories rather than hard-coded, so a module added later is
    // scanned; the absolute minimum is what catches a walk that silently found
    // no files at all.
    const files = domainFiles();
    expect(files.length, 'the domain scan found almost nothing — did the walk work?')
      .toBeGreaterThanOrEqual(8);
    for (const file of files) {
      expect(readFileSync(file, 'utf8').length, `${file} is empty`).toBeGreaterThan(200);
    }
  });

  it('strips comments, which is what stops the detectors firing on their own prose', () => {
    // The mutation self-test for the stripper. Both comment forms, and the
    // `:` guard that keeps a `https://` inside a string from being eaten.
    expect(stripComments('const a = 1; // similarity(x, y)')).not.toContain('similarity(');
    expect(stripComments('/* cartesian */ const a = 1;')).not.toContain('cartesian');
    expect(stripComments("const url = 'https://x';")).toContain('https://x');
    // And the positive control: a REAL call survives the stripper.
    expect(stripComments('const s = similarity(a, b);')).toContain('similarity(');
  });
});

describe('wall 1 — no canonical identity, in either direction', () => {
  it('no module in the domain names a canonical entity', () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (CANONICAL_REFERENCE.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the detector fires on the shape it is hunting', () => {
    expect(CANONICAL_REFERENCE.test("import { canonicalAttributeValues } from '../schema/x.js';"))
      .toBe(true);
    expect(CANONICAL_REFERENCE.test('await db.select().from(canonicalVariants);')).toBe(true);
    // And does NOT fire on the one canonical module the domain legitimately
    // imports: #56's own value folder, which is a pure string function and
    // reaches no canonical table.
    expect(CANONICAL_REFERENCE.test("import { normalizeOptionValue } from '../canonical/variant-signature.js';"))
      .toBe(false);
  });
});

describe('wall 2 — nothing in this domain guesses', () => {
  it('no similarity metric is called or imported', () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (FUZZY_REFERENCE.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the detector fires on a call and on an import', () => {
    expect(FUZZY_REFERENCE.test('const score = similarity(a, b);')).toBe(true);
    expect(FUZZY_REFERENCE.test("import Fuse from 'fuse.js';")).toBe(true);
    expect(FUZZY_REFERENCE.test('order by name <-> $1')).toBe(true);
    // And NOT on the prohibition list, which names those very concepts as
    // string values so the refusal can be checked.
    expect(FUZZY_REFERENCE.test("const forbidden = ['fuzzy_match', 'edit_distance'];")).toBe(false);
    // Nor on `'operator_refused'`, which contains `fuse` — measured on the first
    // run of this file, and the reason the import branch anchors the specifier
    // at its closing quote rather than matching a substring anywhere in it.
    expect(FUZZY_REFERENCE.test("sql`x is not distinct from 'operator_refused'`")).toBe(false);
  });

  it('the fold list and the forbidden-fold list are DISJOINT', () => {
    const permitted = new Set(LEGACY_OPTION_NAME_FOLDS);
    for (const forbidden of LEGACY_OPTION_FORBIDDEN_FOLDS) {
      expect(permitted.has(forbidden), `${forbidden} is in both lists`).toBe(false);
    }
    expect(LEGACY_OPTION_NAME_FOLDS.length).toBe(5);
    expect(LEGACY_OPTION_FORBIDDEN_FOLDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('wall 3 — matrices are sparse', () => {
  it('nothing generates a Cartesian product', () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (MATRIX_GENERATOR_REFERENCE.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the detector fires on a generator', () => {
    expect(MATRIX_GENERATOR_REFERENCE.test('const rows = cartesianProduct(axes);')).toBe(true);
    expect(MATRIX_GENERATOR_REFERENCE.test('function expandMatrix(axes) {}')).toBe(true);
    expect(MATRIX_GENERATOR_REFERENCE.test('const rows = await listVariantAxisAssignments(db, ids);'))
      .toBe(false);
  });
});

describe('wall 4 — the legacy option tables are READ, never written', () => {
  it('no module in the domain writes one', () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (LEGACY_OPTION_WRITE_REFERENCE.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('and the domain DOES read them — the positive control', () => {
    // Without this the wall above is satisfied by a domain that never touches
    // the legacy tables at all, which would mean the backfill reads nothing.
    const legacyRepository = readFileSync(
      join(SRC_ROOT, 'db', 'variantAxes', 'legacyOptionRepository.ts'),
      'utf8',
    );
    expect(legacyRepository).toContain('listingOptions');
    expect(legacyRepository).toContain('productVariantOptionValues');
    expect(stripComments(legacyRepository)).toContain('.select()');
  });

  it('the detector fires on a write and not on a read', () => {
    expect(LEGACY_OPTION_WRITE_REFERENCE.test('await db.insert(listingOptions).values(rows);'))
      .toBe(true);
    expect(LEGACY_OPTION_WRITE_REFERENCE.test('await tx.delete(productVariantOptionValues);'))
      .toBe(true);
    expect(LEGACY_OPTION_WRITE_REFERENCE.test('await db.select().from(listingOptions);')).toBe(false);
  });
});

describe('wall 5 — no ranking, fee or referral reference', () => {
  it('no module in the domain reaches a commercial ordering', () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (COMMERCIAL_REFERENCE.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the detector fires on the shape it is hunting', () => {
    expect(COMMERCIAL_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("from '../../db/payments/ledgerRepository.js'")).toBe(false);
    expect(COMMERCIAL_REFERENCE.test("from '../../services/payments/redact.js'")).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* #454: the detector must match the IDIOM, not one spelling of it            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * These detectors named each forbidden domain by its `services/<domain>/` path
 * only, which is not the specifier a module inside this domain writes: a
 * sibling directory is one `../` away, so the real import is `'../<domain>/…'`
 * and it passed the wall untouched. MEASURED on `origin/main` by executing each
 * pattern against that spelling.
 *
 * One relative alternative per domain covers EVERY depth, because however many
 * `../` segments precede it the last always abuts the directory name.
 *
 * The probes below are written from the IDIOM rather than from the regex — a
 * self-test derived from the pattern can only confirm the pattern matches
 * itself. The imported SYMBOL is deliberately neutral in each: the sibling
 * probe in `freshness-isolation.test.ts` imported `rankOffers`, which its
 * pattern matches by function NAME, so it passed without ever exercising the
 * path alternative it appeared to cover.
 */
describe('#454: a relative import cannot walk around these detectors', () => {
  it('COMMERCIAL_REFERENCE sees a sibling-relative import', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { helper } from '../payments/thing.service.js';"),
      "a module here reaches payments as '../payments/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../../services/payments/thing.service.js';")).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { helper } from '../fees/thing.service.js';"),
      "a module here reaches fees as '../fees/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../../services/fees/thing.service.js';")).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { helper } from '../ranking/thing.service.js';"),
      "a module here reaches ranking as '../ranking/…' and that must not pass",
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../../services/ranking/thing.service.js';")).toBe(true);
    // The negative half, or the widening would fire on ordinary imports.
    expect(COMMERCIAL_REFERENCE.test("import { helper } from '../payments-display/format.js';")).toBe(false);
    expect(COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

});
