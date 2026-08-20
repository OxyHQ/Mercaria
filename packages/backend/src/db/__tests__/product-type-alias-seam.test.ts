/**
 * `product_type_aliases` has no reader, and this file says WHY and WHEN (#732).
 *
 * #732 reports three alias tables written and read by nothing. Two are closed
 * in the same change this file lands with: `category_aliases` is now read by
 * the deterministic search-intent interpreter, and `attribute_value_aliases` is
 * now read by its enum pass. The third is deliberately left open, and a
 * paragraph in a doc is not a thing anybody trips over — so the reasoning is
 * asserted here, against the two facts it rests on.
 *
 * ## Why not the authoring product-type list
 *
 * `GET /catalog-authoring/product-types?categoryId=` is the obvious candidate
 * and is the wrong one. Its answer is already narrowed to ONE category
 * (`listPublishedProductTypesForCategory`), and its only client —
 * `packages/dashboard/app/(app)/products/wizard/index.tsx` — renders every
 * option returned as a chip, with no search box in that step or in the category
 * step above it. A `q` parameter there would be an API parameter no caller
 * sends: a mechanism that is green and inert by construction, which is the
 * exact defect #732 files against the table.
 *
 * The vocabulary says the same thing. `PRODUCT_TYPE_ALIAS_KINDS` is
 * `synonym | search_term | legacy_name | misspelling | transliteration |
 * abbreviation | regional_term`, and the schema's own doc calls the lookup
 * index "a shopper's word in a locale → the types it might mean". An authoring
 * wizard is not a shopper.
 *
 * ## What is actually missing
 *
 * A product-type FILTER in retrieval. `SearchFilters` has no member for one and
 * `services/search/` never mentions a product-type id or key, so a reader wired
 * on the search side today could only ever report `unsupported_by_retrieval` —
 * a reader that can never resolve, which is worse than none, because it makes
 * #367's "a search for regional synonyms resolves to the same
 * category/type/value" look answered at the type grain when it is not.
 *
 * ## So the gate is the PREREQUISITE, not the absence
 *
 * Assertion 1 states the premise and is what fires: the day `SearchFilters`
 * grows a product-type member, this test goes red and whoever added it reads
 * the paragraph above. Assertion 2 is the census that makes "no reader" a
 * measured fact rather than a memory, with its one exemption named and
 * REQUIRED to match — an exemption that cannot match is a guard that excuses
 * nothing while looking like care.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_TYPE_ALIAS_KINDS } from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEARCH_CONTRACT = join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'search.ts');

/** The drizzle binding. A reader has to name it — there is no other handle. */
const BINDING = /productTypeAliases/;

/**
 * Where a reference is not a READ, with the reason.
 *
 * `db/schema/productTypes.ts` DECLARES the table. `impact-plan.ts` names its
 * foreign key in the merge-plan census — a disposition, not a query; a merge
 * rehomes those rows and never reads one to answer anything.
 *
 * Each entry is asserted to MATCH below. A list of paths that no longer exist
 * excuses nothing and reads exactly like a clean census.
 */
const NOT_A_READER: readonly { path: string; why: string }[] = [
  { path: 'db/schema/productTypes.ts', why: 'declares the table' },
  {
    path: 'services/catalog-governance/impact-plan.ts',
    why: 'names the foreign key in the merge-plan census — a disposition, not a query',
  },
];

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      // A test may name the table in order to test it, and this file does.
      if (entry === '__tests__') continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Strip comments: every module here documents the table in prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('#732 — the product-type alias seam, and the change that opens it', () => {
  it('retrieval still has no product-type filter — the premise', () => {
    const contract = stripComments(readFileSync(SEARCH_CONTRACT, 'utf8'));
    // The vacuity floor. A moved or renamed file would read as an empty
    // contract, which contains no product-type member for the wrong reason.
    expect(contract).toContain('interface SearchFilters');
    expect(contract).toContain('categorySlugs');
    expect(
      /productType/i.test(contract),
      [
        '`SearchFilters` grew a product-type member.',
        'That is the prerequisite #732 was waiting on: wire `product_type_aliases`',
        'into the deterministic interpreter the way `category_aliases` is wired',
        '(a batched `normalized_alias = ANY(...)` in `plan.service.ts`, the rows',
        'handed to `interpretDeterministically`), then delete this assertion.',
      ].join(' '),
    ).toBe(false);
  });

  it('no production module reads the table — the census', () => {
    const files = walk(join(SRC_ROOT, 'db')).concat(
      walk(join(SRC_ROOT, 'services')),
      walk(join(SRC_ROOT, 'routes')),
      walk(join(SRC_ROOT, 'controllers')),
    );
    // Floored, because a walk that resolved to nothing finds no reader either.
    expect(files.length).toBeGreaterThanOrEqual(1400);

    const referencing = files
      .filter((file) => BINDING.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC_ROOT, file).replaceAll('\\', '/'));

    const exempt = NOT_A_READER.map((entry) => entry.path);
    for (const entry of NOT_A_READER) {
      expect(
        referencing,
        `the exemption "${entry.path}" (${entry.why}) matches nothing — an exemption that cannot match excuses nothing`,
      ).toContain(entry.path);
    }
    expect(referencing.filter((file) => !exempt.includes(file))).toEqual([]);
  });

  it('the detector fires on a real reference — the mutation self-test', () => {
    // Without this, a broken pattern would report a clean census forever.
    expect(BINDING.test(stripComments('const rows = await db.select().from(productTypeAliases);'))).toBe(
      true,
    );
    expect(BINDING.test(stripComments('// mentions productTypeAliases in prose only'))).toBe(false);
  });

  it('the alias vocabulary is a shopper vocabulary, which is why', () => {
    // Named as a value rather than left in prose: three of these seven are
    // words #367 lists by hand under "localized aliases, synonyms, regional
    // terms, abbreviations, common misspellings and transliterations", and none
    // of them is a thing a merchant filling in an authoring wizard types.
    expect([...PRODUCT_TYPE_ALIAS_KINDS].sort()).toEqual([
      'abbreviation',
      'legacy_name',
      'misspelling',
      'regional_term',
      'search_term',
      'synonym',
      'transliteration',
    ]);
  });
});
