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
 * ## Five things, not one
 *
 * 1. the crossed fixture, with its crossing asserted from the rows;
 * 2. a POSITIVE control — `genuine` returned under exactly the same filters, so
 *    "the crossed one is absent" cannot be satisfied by a dead predicate;
 * 3. EACH HALF alone, which returns `crossed` from each of its two variants, so
 *    both requirements are demonstrably live rather than jointly broken;
 * 4. both RAILS, because the fix has to land on both and each has its own entry;
 * 5. the two rails AGREEING — the facet COUNT against the result LIST, over one
 *    filter set. That is the assertion the original defect would have failed:
 *    each rail was internally consistent and only their DISAGREEMENT was the
 *    bug, so no test of either rail alone was ever going to name it. Cases 2-4
 *    pin this rail against a known answer; case 5 pins it against the rail a
 *    shopper sees it beside.
 *
 * ## …and the same five over the OTHER variant table (#616)
 *
 * A variant's colour may be a registry value in `canonical_attribute_values` or
 * the option assignment that DEFINES it in `canonical_variant_attributes`. The
 * facet rail always read both; the list rails read only the first, so a shopper
 * was offered "Red (3)" above an empty list. Both rails now read both tables,
 * and the crossing is re-asserted over AXIS values — because a widening is
 * exactly where a correlation gets traded away by accident.
 *
 * The MIXED pair is the one that earns its place: one requirement answered from
 * each table, so a rail running one `exists` per TABLE — each free to find its
 * own variant — reports a product no single variant of which is both. It is
 * #567's failure shape, reachable through a door #567 could not see.
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
  canonicalVariantAttributes,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import {
  countFacetMatchedProducts,
  NO_FACET_REQUIREMENTS,
  type FacetQueryContext,
} from '../../../db/facets/facetRepository.js';
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
const RAM = `ram_gb_${RUN}`;

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
/** #616's fixture: the same crossing, recorded as option AXES instead. */
let axisCrossedProductId = '';
let axisGenuineProductId = '';
/** …and the pair that crosses ACROSS the two tables. */
let mixedCrossedProductId = '';
let mixedGenuineProductId = '';
/** A stored RANGE, for the third divergence this pair of issues turned up. */
let rangeProductId = '';

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

/**
 * One OPTION AXIS at variant grain — the OTHER table the facet rail reads.
 *
 * `canonical_variant_attributes` holds the assignments that DEFINE a variant,
 * which is where the matcher writes colour and size for most of the catalogue.
 * Until #616 the facet rail read it and the two list rails did not, so a shopper
 * was offered "Red (3)" above an empty list.
 */
async function addAxis(variantId: string, key: string, value: string): Promise<void> {
  await db.insert(canonicalVariantAttributes).values({
    variantId,
    attributeKey: key,
    displayValue: value,
    normalizedValue: value,
    normalizationState: 'normalized',
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

  // #616, the same crossing recorded entirely as option AXES. Both requirements
  // now have to be answered from a table the list rails could not read at all,
  // and the CROSSED half has to stay excluded while they learn to.
  axisCrossedProductId = await insertProduct('axis-crossed');
  const axisRed41 = await insertVariant(axisCrossedProductId);
  const axisBlack43 = await insertVariant(axisCrossedProductId);
  await addAxis(axisRed41, COLOUR, 'red');
  await addAxis(axisRed41, SIZE, '41');
  await addAxis(axisBlack43, COLOUR, 'black');
  await addAxis(axisBlack43, SIZE, '43');

  axisGenuineProductId = await insertProduct('axis-genuine');
  const axisGenuine = await insertVariant(axisGenuineProductId);
  await addAxis(axisGenuine, COLOUR, 'red');
  await addAxis(axisGenuine, SIZE, '43');

  // The MIXED pair — the strongest form of the property, because one
  // requirement is answered from each TABLE and the correlation has to hold
  // across them. A per-table `exists` free to pick its own variant satisfies
  // `mixedCrossed` while no single variant of it is both.
  mixedCrossedProductId = await insertProduct('mixed-crossed');
  const mixedRedAxis = await insertVariant(mixedCrossedProductId);
  const mixed43Value = await insertVariant(mixedCrossedProductId);
  await addAxis(mixedRedAxis, COLOUR, 'red');
  await addVariantValue(mixed43Value, SIZE, '43');

  mixedGenuineProductId = await insertProduct('mixed-genuine');
  const mixedGenuine = await insertVariant(mixedGenuineProductId);
  await addAxis(mixedGenuine, COLOUR, 'red');
  await addVariantValue(mixedGenuine, SIZE, '43');

  // A value stored as a RANGE — 8 to 16 GB — rather than a scalar.
  rangeProductId = await insertProduct('range');
  const ranged = await insertVariant(rangeProductId);
  await db.insert(canonicalAttributeValues).values({
    variantId: ranged,
    attributeKey: RAM,
    sourceDisplayValue: '8-16 GB',
    normalizedNumber: 8,
    // `canonical_attribute_values_range_check`: a range is a lower bound, an
    // upper bound AND two strictnesses, or it is not a range.
    normalizedNumberMax: 16,
    rangeLowerInclusive: true,
    rangeUpperInclusive: true,
    normalizationState: 'normalized',
    selectionState: 'selected',
    sourceRecordId,
  });
}, 120_000);

afterAll(async () => {
  await db
    .delete(canonicalVariantAttributes)
    .where(inArray(canonicalVariantAttributes.variantId, safeIds(created.variants)));
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

    // Per REQUIREMENT, at product grain — the derivation the fix replaced.
    const productOf = new Map<string, string>();
    const variantRows = await db
      .select({ id: canonicalVariants.id, productId: canonicalVariants.productId })
      .from(canonicalVariants)
      .where(inArray(canonicalVariants.id, safeIds(created.variants)));
    for (const row of variantRows) productOf.set(row.id, row.productId);

    // Scoped to THIS case's two products rather than to every variant the file
    // creates: #616's axis and mixed fixtures live in the same run, and a global
    // count here would have to be edited every time one is added — which is a
    // guard that gets relaxed rather than one that holds.
    const pairVariants = [...byVariant.entries()].filter(([variantId]) => {
      const owner = productOf.get(variantId);
      return owner === crossedProductId || owner === genuineProductId;
    });
    expect(pairVariants.length, 'the fixture wrote no variant values at all').toBe(3);

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

  it('the FACET COUNT and the RESULT LIST agree over the same filters', async () => {
    // The assertion #567 was missing. Each rail was internally consistent — the
    // facet count was right and the result list was wrong — so nothing that
    // measured ONE of them could name the defect. What a shopper saw was the
    // DISAGREEMENT: `matchedProductCount: 1` rendered above a list of two.
    const fixture = [crossedProductId, genuineProductId];

    const context: FacetQueryContext = {
      // Scoped to the two products this file inserted, never to a category:
      // this database is shared with every other worktree, and a count over a
      // category would be a number about somebody else's rows.
      scope: { kind: 'products', canonicalProductIds: fixture },
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        variant: [
          { key: COLOUR, values: ['red'] },
          { key: SIZE, values: ['43'] },
        ],
      },
      now: NOW,
    };

    const facetCount = await countFacetMatchedProducts(db, context);
    // Both lists narrowed to the SAME two ids the facet scope names, so the
    // three numbers are answers to one question rather than three.
    const searchList = (await searchIds(RED_AND_43)).filter((id) => fixture.includes(id));
    const browseList = (await browseIds(RED_AND_43)).filter((id) => fixture.includes(id));

    // The vacuity floor FIRST. Three rails agreeing at ZERO is exactly what a
    // filter matching nothing looks like, and it satisfies every equality below.
    expect(
      facetCount,
      'the facet rail matched NOTHING — every agreement below would be vacuous',
    ).toBe(1);
    // Then the rails against EACH OTHER — the part a per-rail test cannot
    // express, and the headline diagnosis, so it is asserted BEFORE membership.
    // Under the defect this read 2 against a facet count of 1, which is
    // literally the page: a list longer than the number rendered above it.
    expect(
      searchList.length,
      'SEARCH disagrees with the FACET COUNT — the list and the number above it describe different sets',
    ).toBe(facetCount);
    expect(
      browseList.length,
      'BROWSE disagrees with the FACET COUNT — the list and the number above it describe different sets',
    ).toBe(facetCount);

    // …and finally WHICH product each rail returned. Agreement on a count is
    // not agreement on a set: two rails could each answer 1 with different rows.
    expect(searchList, 'SEARCH returned the wrong product').toEqual([genuineProductId]);
    expect(browseList, 'BROWSE returned the wrong product').toEqual([genuineProductId]);

    // Populations on SUCCESS, via stdout: vitest's default reporter (what CI
    // runs) suppresses `console.*` from a test that PASSED, so a `console.log`
    // here would be invisible in exactly the run somebody reads.
    process.stdout.write(
      `[#567 rails agree] scope=${fixture.length} facet=${facetCount} ` +
        `search=${searchList.length} browse=${browseList.length}\n`,
    );
  }, 60_000);

  it('the AXIS-only pair behaves identically — #616, correlation intact', async () => {
    // Until #616 both list rails read `canonical_attribute_values` alone, so
    // BOTH of these were absent: the facet rail counted them and nothing matched
    // them. The control is asserted first for the usual reason — "the crossed
    // one is absent" is equally satisfied by a filter that matches nothing.
    const search = await searchIds(RED_AND_43);
    expect(search, 'the AXIS control is missing — the axis branch matches NOTHING').toContain(
      axisGenuineProductId,
    );
    expect(
      search,
      'the axis-CROSSED product was returned: red on one variant, 43 on another, and no variant both',
    ).not.toContain(axisCrossedProductId);

    const browse = await browseIds(RED_AND_43);
    expect(browse, 'the AXIS control is missing — the axis branch matches NOTHING').toContain(
      axisGenuineProductId,
    );
    expect(browse, 'the axis-CROSSED product was returned').not.toContain(axisCrossedProductId);
  }, 60_000);

  it('a set crossed ACROSS the two tables is refused, which is the real widening test', async () => {
    // The case an incorrect widening passes and a correct one fails. Each
    // requirement is met by a different TABLE, so a rail that ran one `exists`
    // per table — each free to find its own variant — reports `mixedCrossed`,
    // while `mixedGenuine` is the identical pair of facts on ONE variant.
    //
    // The two `exists` therefore both have to correlate to the SAME `cv`, which
    // is #567's property surviving #616 rather than being traded for it.
    const search = await searchIds(RED_AND_43);
    expect(search, 'the MIXED control is missing — the cross-table filter matches NOTHING').toContain(
      mixedGenuineProductId,
    );
    expect(
      search,
      'the cross-table CROSSED product was returned: colour from one variant, size from another',
    ).not.toContain(mixedCrossedProductId);

    const browse = await browseIds(RED_AND_43);
    expect(browse, 'the MIXED control is missing').toContain(mixedGenuineProductId);
    expect(browse, 'the cross-table CROSSED product was returned').not.toContain(
      mixedCrossedProductId,
    );
  }, 60_000);

  it('the FACET COUNT and the RESULT LIST agree over the AXIS and MIXED pairs too', async () => {
    // Case 5 one table over. The count is what a shopper reads above the list,
    // and #616's symptom was precisely that the two described different sets —
    // "Red (3)" above nothing at all.
    const fixture = [
      axisCrossedProductId,
      axisGenuineProductId,
      mixedCrossedProductId,
      mixedGenuineProductId,
    ];

    const context: FacetQueryContext = {
      // Scoped to the four products this block inserted, never a category: the
      // database is shared with every other worktree.
      scope: { kind: 'products', canonicalProductIds: fixture },
      requirements: {
        ...NO_FACET_REQUIREMENTS,
        variant: [
          { key: COLOUR, values: ['red'] },
          { key: SIZE, values: ['43'] },
        ],
      },
      now: NOW,
    };

    const facetCount = await countFacetMatchedProducts(db, context);
    const searchList = (await searchIds(RED_AND_43)).filter((id) => fixture.includes(id));
    const browseList = (await browseIds(RED_AND_43)).filter((id) => fixture.includes(id));

    // The vacuity floor FIRST: two genuine products, two crossed ones.
    expect(
      facetCount,
      'the facet rail matched NOTHING — every agreement below would be vacuous',
    ).toBe(2);
    expect(
      searchList.length,
      'SEARCH disagrees with the FACET COUNT over the axis/mixed pairs',
    ).toBe(facetCount);
    expect(
      browseList.length,
      'BROWSE disagrees with the FACET COUNT over the axis/mixed pairs',
    ).toBe(facetCount);

    // Agreement on a count is not agreement on a set.
    expect([...searchList].sort()).toEqual([axisGenuineProductId, mixedGenuineProductId].sort());
    expect([...browseList].sort()).toEqual([axisGenuineProductId, mixedGenuineProductId].sort());

    process.stdout.write(
      `[#616 rails agree] scope=${fixture.length} facet=${facetCount} ` +
        `search=${searchList.length} browse=${browseList.length}\n`,
    );
  }, 60_000);

  it('a stored RANGE answers a min bound on BOTH rails, not just the count', async () => {
    // The THIRD divergence #628/#616 turned up, measured rather than reasoned:
    // the facet rail reads `coalesce(normalized_number_max, normalized_number)`
    // for a lower bound — the UPPER end of 8–16 GB satisfies "at least 12" — and
    // the list rails read `normalized_number` alone, so the count offered a
    // range the list could not match. #616's symptom through a second door.
    const scope = [rangeProductId];
    const context: FacetQueryContext = {
      scope: { kind: 'products', canonicalProductIds: scope },
      requirements: { ...NO_FACET_REQUIREMENTS, variant: [{ key: RAM, min: 12 }] },
      now: NOW,
    };

    // The vacuity floor is a bound BOTH spellings satisfy (8 >= 4 and 16 >= 4):
    // without it, three rails answering 1 could be three readings of the scalar
    // path rather than of the range.
    const lowContext: FacetQueryContext = {
      scope: { kind: 'products', canonicalProductIds: scope },
      requirements: { ...NO_FACET_REQUIREMENTS, variant: [{ key: RAM, min: 4 }] },
      now: NOW,
    };
    expect(
      await countFacetMatchedProducts(db, lowContext),
      'the RANGE control matched nothing — the fixture never committed',
    ).toBe(1);
    expect(
      await searchIds({ attributes: [{ key: RAM, minNumber: 4 }] }),
      'the RANGE control is missing from SEARCH',
    ).toContain(rangeProductId);

    // …then the bound that only the coalesce spelling reaches.
    const facetCount = await countFacetMatchedProducts(db, context);
    const search = (await searchIds({ attributes: [{ key: RAM, minNumber: 12 }] })).filter((id) =>
      scope.includes(id),
    );
    const browse = (await browseIds({ attributes: [{ key: RAM, minNumber: 12 }] })).filter((id) =>
      scope.includes(id),
    );

    expect(facetCount, 'the facet rail matched NOTHING — the agreements would be vacuous').toBe(1);
    expect(search.length, 'SEARCH disagrees with the FACET COUNT over a stored range').toBe(
      facetCount,
    );
    expect(browse.length, 'BROWSE disagrees with the FACET COUNT over a stored range').toBe(
      facetCount,
    );

    // And the bound the range genuinely fails, so the agreement above is not
    // just "everything matches".
    expect(
      await countFacetMatchedProducts(db, {
        ...context,
        requirements: { ...NO_FACET_REQUIREMENTS, variant: [{ key: RAM, min: 17 }] },
      }),
      'a bound ABOVE the range still matched — the predicate is not live',
    ).toBe(0);
    expect(
      (await searchIds({ attributes: [{ key: RAM, minNumber: 17 }] })).filter((id) =>
        scope.includes(id),
      ),
    ).toEqual([]);
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
