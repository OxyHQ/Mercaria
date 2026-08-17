/**
 * Variant-level attribute filters must be answered by ONE variant — issue #567.
 *
 * The facet rail already does this: `db/facets/facetRepository.ts` nests every
 * variant predicate inside one `exists` correlated to a single
 * `canonical_variants` row. The SEARCH and BROWSE rails did not. Each ran one
 * statement per constraint — `findProductIdsSatisfyingAttribute`, resolving to a
 * PRODUCT id — and intersected the results, so a product survived when a red
 * variant existed AND a size-43 variant existed, with no single variant being
 * both.
 *
 * The two rails serve one page. The correlated one produces the COUNT and the
 * uncorrelated one produced the LIST, so a category page could render
 * `matchedProductCount: 1` above a result set containing a second, crossed
 * product.
 *
 * ## The fixture is built for the FALSE MATCH, and its crossing is ASSERTED
 *
 * ```
 *   crossed     red   / 41      ← a red one exists
 *               black / 43      ← a 43 exists, and no red 43
 *   genuine     red   / 43      ← one variant that is both
 * ```
 *
 * `facets.realdb.test.ts` seeds exactly this shape and states why: a fixture
 * with one variant per product cannot tell the two implementations apart. It is
 * rebuilt here rather than shared because that file drives the facet rail and
 * this one drives search and browse — and a fixture reached through a helper two
 * domains away is one somebody edits for the other caller's benefit.
 *
 * The crossing is not taken on trust from the constants above. Case 1 reads the
 * REAL rows back and writes out the naive per-requirement derivation the fix
 * replaced, asserting that it admits `crossed` — so if somebody edits an axis
 * value and un-crosses the fixture, this file says so instead of going quietly
 * green. That is the failure this test class actually has: a predicate matching
 * NOTHING returns nothing too, and reads identically green.
 *
 * ## Four things, not one
 *
 * 1. the crossed fixture, with its crossing asserted from the rows;
 * 2. a POSITIVE control — `genuine` returned under exactly the same filters, so
 *    "the crossed one is absent" cannot be satisfied by a dead predicate;
 * 3. EACH HALF alone, which returns `crossed` from each of its two variants, so
 *    both requirements are demonstrably live rather than jointly broken;
 * 4. both RAILS, because the fix has to land on both and each has its own entry.
 *
 * ## A real server, through the PUBLIC entries
 *
 * `runCanonicalSearch` and `browseCatalogProducts`, not the repository, so this
 * file is meaningful against the code before the fix as well as after it.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every searchable string and every id carries a per-run suffix, every read is
 * keyed on ids this file created, and nothing counts a whole table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { SearchFilters } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { runCanonicalSearch } from '../canonical-search.service.js';
import { browseCatalogProducts } from '../../catalog-pages/product-browse.service.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run: parallel siblings share the database. */
const RUN = `svf${uuidv7().replace(/-/gu, '').slice(-8)}`;
const TERM = `Qwyxvar ${RUN}`;
const NOW = new Date('2026-06-01T12:00:00.000Z');

const COLOUR = `colour_${RUN}`;
const SIZE = `shoe_size_eu_${RUN}`;

const created = {
  products: [] as string[],
  variants: [] as string[],
  sources: [] as string[],
  sourceRecords: [] as string[],
  brands: [] as string[],
};

let sourceRecordId = '';
/** The browse rail scopes by BRAND or family, never by a term — so the fixture needs one. */
let brandId = '';
let crossedProductId = '';
let genuineProductId = '';

/** An empty `inArray` is a statement with no predicate — never let one through. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

async function insertProduct(suffix: string): Promise<string> {
  const name = `${TERM} ${suffix}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name,
      normalizedName: name.toLowerCase(),
      slug: name.toLowerCase().replace(/[^a-z0-9]+/gu, '-'),
      brandId,
      searchTokens: [],
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  if (product === undefined) throw new Error('product insert returned no row');
  created.products.push(product.id);
  return product.id;
}

async function insertVariant(productId: string): Promise<string> {
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId,
      signature: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (variant === undefined) throw new Error('variant insert returned no row');
  created.variants.push(variant.id);
  return variant.id;
}

/** One SELECTED value at VARIANT grain — the grain the whole issue is about. */
async function addVariantValue(variantId: string, key: string, value: string): Promise<void> {
  await db.insert(canonicalAttributeValues).values({
    variantId,
    attributeKey: key,
    sourceDisplayValue: value,
    normalizedText: value,
    normalizationState: 'normalized',
    selectionState: 'selected',
    sourceRecordId,
  });
}

beforeAll(async () => {
  db = await connectPostgres();

  const brandName = `Qwyxbrand ${RUN}`;
  const [brand] = await db
    .insert(brands)
    .values({ name: brandName, normalizedName: brandName.toLowerCase(), slug: `qwyxbrand-${RUN}` })
    .returning({ id: brands.id });
  if (brand === undefined) throw new Error('brand insert returned no row');
  brandId = brand.id;
  created.brands.push(brand.id);

  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `qwyx-source-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (source === undefined) throw new Error('source insert returned no row');
  created.sources.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'product',
      externalId: `ext-${RUN}`,
      observedAt: NOW,
      contentHash: uuidv7().replace(/-/gu, '').padEnd(64, 'a').slice(0, 64),
      payload: {},
    })
    .returning({ id: sourceRecords.id });
  if (record === undefined) throw new Error('source record insert returned no row');
  sourceRecordId = record.id;
  created.sourceRecords.push(record.id);

  // The CROSSED product: a red 41 and a black 43, and no variant that is both.
  crossedProductId = await insertProduct('crossed');
  const crossedRed = await insertVariant(crossedProductId);
  const crossedBlack = await insertVariant(crossedProductId);
  await addVariantValue(crossedRed, COLOUR, 'red');
  await addVariantValue(crossedRed, SIZE, '41');
  await addVariantValue(crossedBlack, COLOUR, 'black');
  await addVariantValue(crossedBlack, SIZE, '43');

  // The GENUINE product: ONE variant that is both. The positive control.
  genuineProductId = await insertProduct('genuine');
  const genuine = await insertVariant(genuineProductId);
  await addVariantValue(genuine, COLOUR, 'red');
  await addVariantValue(genuine, SIZE, '43');
}, 120_000);

afterAll(async () => {
  await db
    .delete(canonicalAttributeValues)
    .where(inArray(canonicalAttributeValues.variantId, safeIds(created.variants)));
  await deleteTestCanonicalRows(db, {
    variantIds: created.variants,
    productIds: created.products,
  });
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(created.sourceRecords)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(created.sources)));
  await db.delete(brands).where(inArray(brands.id, safeIds(created.brands)));
  await closePostgres();
}, 120_000);

/** Red AND 43 — the filter pair the whole issue is about. */
const RED_AND_43: SearchFilters = {
  attributes: [
    { key: COLOUR, value: 'red' },
    { key: SIZE, value: '43' },
  ],
};

async function searchIds(filters: SearchFilters): Promise<string[]> {
  const outcome = await runCanonicalSearch(
    { term: TERM, kinds: ['product'], filters, limit: 20, now: NOW },
    db,
  );
  return outcome.response.results.flatMap((result) =>
    result.kind === 'product' ? [result.canonicalProductId] : [],
  );
}

async function browseIds(filters: SearchFilters): Promise<string[]> {
  const page = await browseCatalogProducts(
    {
      scope: { kind: 'brand', brandId },
      filters: { attributes: filters.attributes ?? [] },
      limit: 20,
      // The offer half is not what this file measures; `withdrawn` is the state
      // #60's comparison lever produces when it is off, and it keeps the card's
      // price summary out of the way of the attribute filter under test.
      offerContext: 'withdrawn',
      now: NOW,
    },
    db,
  );
  return page.products.map((product) => product.canonicalProductId);
}

describe('a variant-level filter set is answered by ONE variant (#567)', () => {
  it('the fixture really is crossed, and the naive derivation admits it', async () => {
    // Read back from the REAL rows, not from the constants above: editing an
    // axis value must not be able to leave this file measuring an uncrossed
    // pair, which would pass against the broken query and the fixed one alike.
    const rows = await db
      .select({
        variantId: canonicalAttributeValues.variantId,
        key: canonicalAttributeValues.attributeKey,
        value: canonicalAttributeValues.normalizedText,
      })
      .from(canonicalAttributeValues)
      .where(inArray(canonicalAttributeValues.variantId, safeIds(created.variants)));

    const byVariant = new Map<string, Map<string, string>>();
    for (const row of rows) {
      if (row.variantId === null) continue;
      const entry = byVariant.get(row.variantId) ?? new Map<string, string>();
      if (row.value !== null) entry.set(row.key, row.value);
      byVariant.set(row.variantId, entry);
    }

    const crossedVariants = [...byVariant.entries()].filter(([variantId]) =>
      created.variants.includes(variantId),
    );
    expect(crossedVariants.length, 'the fixture wrote no variant values at all').toBe(3);

    // Per REQUIREMENT, at product grain — the derivation the fix replaced.
    const productOf = new Map<string, string>();
    const variantRows = await db
      .select({ id: canonicalVariants.id, productId: canonicalVariants.productId })
      .from(canonicalVariants)
      .where(inArray(canonicalVariants.id, safeIds(created.variants)));
    for (const row of variantRows) productOf.set(row.id, row.productId);

    const productsWithRed = new Set(
      [...byVariant.entries()]
        .filter(([, values]) => values.get(COLOUR) === 'red')
        .map(([variantId]) => productOf.get(variantId)),
    );
    const productsWith43 = new Set(
      [...byVariant.entries()]
        .filter(([, values]) => values.get(SIZE) === '43')
        .map(([variantId]) => productOf.get(variantId)),
    );

    // The crossed product satisfies each requirement SEPARATELY …
    expect(productsWithRed.has(crossedProductId)).toBe(true);
    expect(productsWith43.has(crossedProductId)).toBe(true);

    // … and NO single variant of it satisfies both. That is the crossing, and it
    // is the whole reason this fixture can tell the two implementations apart.
    const crossedBoth = [...byVariant.entries()].filter(
      ([variantId, values]) =>
        productOf.get(variantId) === crossedProductId &&
        values.get(COLOUR) === 'red' &&
        values.get(SIZE) === '43',
    );
    expect(crossedBoth, 'the fixture is NOT crossed — this file would prove nothing').toEqual([]);

    // The control product has exactly such a variant.
    const genuineBoth = [...byVariant.entries()].filter(
      ([variantId, values]) =>
        productOf.get(variantId) === genuineProductId &&
        values.get(COLOUR) === 'red' &&
        values.get(SIZE) === '43',
    );
    expect(genuineBoth).toHaveLength(1);
  }, 60_000);

  it('SEARCH returns the genuine product and NOT the crossed one', async () => {
    const ids = await searchIds(RED_AND_43);
    // The positive control first: an absent crossed product proves nothing if
    // the predicate has stopped matching anything at all.
    expect(ids, 'the control product is missing — the filter matches NOTHING').toContain(
      genuineProductId,
    );
    expect(
      ids,
      'the crossed product was returned: red in one variant, 43 in another, and no variant both',
    ).not.toContain(crossedProductId);
  }, 60_000);

  it('BROWSE returns the genuine product and NOT the crossed one', async () => {
    const ids = await browseIds(RED_AND_43);
    expect(ids, 'the control product is missing — the filter matches NOTHING').toContain(
      genuineProductId,
    );
    expect(
      ids,
      'the crossed product was returned: red in one variant, 43 in another, and no variant both',
    ).not.toContain(crossedProductId);
  }, 60_000);

  it('each half ALONE returns the crossed product, so both requirements are live', async () => {
    // Without this, "the crossed product is absent" is equally satisfied by a
    // requirement that has stopped matching anything — the two look identical
    // from the assertion above.
    const red = await searchIds({ attributes: [{ key: COLOUR, value: 'red' }] });
    expect(red).toContain(crossedProductId);
    expect(red).toContain(genuineProductId);

    const size = await searchIds({ attributes: [{ key: SIZE, value: '43' }] });
    expect(size).toContain(crossedProductId);
    expect(size).toContain(genuineProductId);
  }, 60_000);
});
