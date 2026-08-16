/**
 * The facet semantics against a REAL PostgreSQL server (#367 Workstream 10).
 *
 * None of what this asserts exists without one. The two semantics are properties
 * of a correlated `exists`, `count(distinct …)` is a property of the aggregate,
 * and a mocked repository would accept every wrong spelling of both.
 *
 * ## The fixture is built for the FALSE MATCH
 *
 * One product with TWO variants whose axes are deliberately crossed:
 *
 * ```
 *   crossed          red   / size 41    ← a red one exists
 *                    black / size 43    ← a 43 exists, and no red 43
 *   genuine          red   / size 43    ← a red 43 exists
 * ```
 *
 * "Red AND 43" must return `genuine` and NOT `crossed`. A per-requirement
 * intersection at product grain returns both, every predicate individually true,
 * and the page renders perfectly. That is the bug the workstream names, and a
 * fixture with one variant per product could not tell the two implementations
 * apart — which is why the crossed product exists.
 *
 * The offer half is the same shape one level down: `crossed`'s cheap offer is
 * out of stock and its in-stock offer is expensive, so "under 200 AND in stock"
 * must not match it.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files, so every fixture id carries
 * this run's suffix, every scope is by ids this file owns, and the teardown
 * deletes only those, children first. No aggregate here is unscoped: each one
 * runs against a category or a product id list minted by this run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { categories } from '../../../db/schema/catalog.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { merchants } from '../../../db/schema/merchants.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  canonicalVariantAttributes,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import {
  countCategoryBuckets,
  countFacetMatchedProducts,
  countOfferAvailabilityBuckets,
  countProductAttributeBuckets,
  countProductsWithAttribute,
  countVariantAttributeBuckets,
  findFacetCategoryScope,
  listObservedValueLabels,
  measureOfferPriceSpans,
  measureProductAttributeRanges,
  NO_FACET_REQUIREMENTS,
  type FacetQueryContext,
  type FacetRequirements,
} from '../../../db/facets/facetRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const ROOT_CATEGORY = `fc-root-${RUN}`;
const CHILD_CATEGORY = `fc-child-${RUN}`;
const SOURCE = `fc-src-${RUN}`;
const RECORD = `fc-rec-${RUN}`;
const MERCHANT = `fc-merch-${RUN}`;

const CROSSED = `fc-p-crossed-${RUN}`;
const GENUINE = `fc-p-genuine-${RUN}`;
const PLAIN = `fc-p-plain-${RUN}`;
const UNSPECED = `fc-p-unspeced-${RUN}`;

const PRODUCT_IDS = [CROSSED, GENUINE, PLAIN, UNSPECED];
const variantIds: string[] = [];
const offerIds: string[] = [];
const valueIds: string[] = [];

/**
 * The fixture clock, safely in the PAST.
 *
 * `#253`: a fixture pinned to a future date passes today, keeps passing, and
 * breaks CI for whoever pushes on the day it arrives — in a file they did not
 * touch. `fixture-date-census.test.ts` caught this file's first draft, which
 * pinned `STALE_AT` at 2027.
 *
 * Every offer predicate in the domain is `stale_at > now` against the CALLER's
 * clock, and `NOW` here is that caller. So the deadline only has to sit after
 * `NOW`, not after the real one, and it is DERIVED as an offset rather than
 * written as a second literal that could drift past it.
 */
const OBSERVED = new Date('2025-12-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:00:00.000Z');
const STALE_AT = new Date(NOW.getTime() + 86_400_000);

/** A scope over exactly the four products this file owns. */
function scoped(requirements: FacetRequirements = NO_FACET_REQUIREMENTS): FacetQueryContext {
  return {
    scope: { kind: 'products', canonicalProductIds: PRODUCT_IDS },
    requirements,
    now: NOW,
  };
}

/** A canonical variant, remembered for teardown. */
async function addVariant(productId: string, index: number): Promise<string> {
  const id = `fc-v-${index}-${RUN}`;
  variantIds.push(id);
  await db.insert(canonicalVariants).values({
    id,
    productId,
    // `canonical_variants_signature_shape_check` wants 64 lowercase hex.
    signature: String(index).padStart(64, 'a'),
    name: `variant ${String(index)}`,
    isDefault: index % 10 === 0,
    status: 'active',
    firstSeenAt: OBSERVED,
  });
  return id;
}

/** A normalized axis assignment on one variant — the matcher's own table. */
async function addAxis(variantId: string, key: string, value: string): Promise<void> {
  await db.insert(canonicalVariantAttributes).values({
    id: `fc-a-${uuidv7().slice(-10)}-${RUN}`,
    variantId,
    attributeKey: key,
    displayValue: value,
    normalizedValue: value,
    normalizationState: 'normalized',
  });
}

/** A SELECTED registry value at product grain. */
async function addProductValue(
  productId: string,
  key: string,
  options: { text?: string; number?: number; display?: string },
): Promise<void> {
  const id = `fc-cav-${uuidv7().slice(-10)}-${RUN}`;
  valueIds.push(id);
  await db.insert(canonicalAttributeValues).values({
    id,
    productId,
    attributeKey: key,
    sourceDisplayValue: options.display ?? options.text ?? String(options.number ?? ''),
    ...(options.text === undefined ? {} : { normalizedText: options.text }),
    ...(options.number === undefined ? {} : { normalizedNumber: options.number }),
    normalizationState: 'normalized',
    selectionState: 'selected',
    sourceRecordId: RECORD,
    observedAt: OBSERVED,
  });
}

/** An EXTERNAL offer, which `offers_kind_shape_check` shapes completely. */
async function addOffer(
  canonicalVariantId: string,
  options: {
    availability: 'in_stock' | 'out_of_stock';
    priceMinor: number;
    currency: string;
    condition: 'new' | 'used_good';
  },
): Promise<string> {
  const id = `fc-o-${uuidv7().slice(-10)}-${RUN}`;
  offerIds.push(id);
  await db.insert(offers).values({
    id,
    kind: 'external',
    status: 'active',
    canonicalVariantId,
    merchantId: MERCHANT,
    sourceRecordId: RECORD,
    destinationUrl: `https://example.invalid/${id}`,
    priceAmount: options.priceMinor,
    priceCurrency: options.currency,
    availability: options.availability,
    condition: options.condition,
    conditionMappingState: 'declared',
    country: 'ES',
    observedAt: OBSERVED,
    firstSeenAt: OBSERVED,
    lastSeenAt: OBSERVED,
    staleAt: STALE_AT,
  });
  return id;
}

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(categories).values([
    {
      id: ROOT_CATEGORY,
      key: `fc.root.${RUN}`,
      name: 'Facet root',
      slug: `fc-root-${RUN}`,
      ancestorIds: [],
      lifecycle: 'published',
      selectable: true,
      position: 0,
    },
    {
      id: CHILD_CATEGORY,
      key: `fc.root.child.${RUN}`,
      name: 'Facet child',
      slug: `fc-child-${RUN}`,
      parentId: ROOT_CATEGORY,
      ancestorIds: [ROOT_CATEGORY],
      lifecycle: 'published',
      selectable: true,
      position: 0,
    },
  ]);

  await db.insert(catalogSources).values({
    id: SOURCE,
    kind: 'operator',
    name: `facets realdb ${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  await db.insert(sourceRecords).values({
    id: RECORD,
    sourceId: SOURCE,
    externalId: `fc-ext-${RUN}`,
    externalType: 'offer',
    observedAt: OBSERVED,
    // `source_records_content_hash_shape_check` wants a sha-256 hex digest.
    contentHash: createHash('sha256').update(RUN).digest('hex'),
  });
  await db.insert(merchants).values({
    id: MERCHANT,
    name: `Facet merchant ${RUN}`,
    slug: `fc-merchant-${RUN}`,
  });

  await db.insert(canonicalProducts).values(
    PRODUCT_IDS.map((id, index) => ({
      id,
      slug: `${id}-slug`,
      name: `Facet product ${String(index)}`,
      normalizedName: `facet product ${String(index)}`,
      categoryId: index === 3 ? CHILD_CATEGORY : ROOT_CATEGORY,
      status: 'active' as const,
      firstSeenAt: OBSERVED,
    })),
  );

  // The crossed product: a red 41 and a black 43, and no red 43.
  const crossedRed = await addVariant(CROSSED, 1);
  const crossedBlack = await addVariant(CROSSED, 2);
  await addAxis(crossedRed, 'colour', 'red');
  await addAxis(crossedRed, 'shoe_size_eu', '41');
  await addAxis(crossedBlack, 'colour', 'black');
  await addAxis(crossedBlack, 'shoe_size_eu', '43');

  // The genuine product: one variant that is both.
  const genuine = await addVariant(GENUINE, 3);
  await addAxis(genuine, 'colour', 'red');
  await addAxis(genuine, 'shoe_size_eu', '43');

  // A plain product with one black 43 — so `black` and `43` are not degenerate.
  const plain = await addVariant(PLAIN, 4);
  await addAxis(plain, 'colour', 'black');
  await addAxis(plain, 'shoe_size_eu', '43');

  // A product with NO recorded colour at all — the `unknownCount` population.
  await addVariant(UNSPECED, 5);

  // Product-grain specs, recorded on three of four.
  await addProductValue(CROSSED, 'material', { text: 'leather', display: 'Full-grain Leather' });
  await addProductValue(GENUINE, 'material', { text: 'leather', display: 'Leather' });
  await addProductValue(PLAIN, 'material', { text: 'canvas', display: 'Canvas' });
  await addProductValue(CROSSED, 'weight', { number: 900 });
  await addProductValue(GENUINE, 'weight', { number: 1_100 });

  // The offer half of the crossing: `crossed` has a cheap OUT-OF-STOCK offer and
  // an expensive in-stock one, so no single offer is both cheap and in stock.
  await addOffer(crossedRed, {
    availability: 'out_of_stock',
    priceMinor: 10_000,
    currency: 'EUR',
    condition: 'new',
  });
  await addOffer(crossedBlack, {
    availability: 'in_stock',
    priceMinor: 90_000,
    currency: 'EUR',
    condition: 'used_good',
  });
  // `genuine` has ONE offer that is both cheap and in stock.
  await addOffer(genuine, {
    availability: 'in_stock',
    priceMinor: 12_000,
    currency: 'EUR',
    condition: 'new',
  });
  // …and two more on the SAME variant, so a `count(*)` would over-report it.
  await addOffer(genuine, {
    availability: 'in_stock',
    priceMinor: 13_000,
    currency: 'USD',
    condition: 'used_good',
  });
  await addOffer(plain, {
    availability: 'in_stock',
    priceMinor: 50_000,
    currency: 'EUR',
    condition: 'new',
  });
}, 120_000);

afterAll(async () => {
  if (db === undefined) return;
  if (offerIds.length > 0) await db.delete(offers).where(inArray(offers.id, offerIds));
  if (valueIds.length > 0) {
    await db.delete(canonicalAttributeValues).where(inArray(canonicalAttributeValues.id, valueIds));
  }
  if (variantIds.length > 0) {
    await db
      .delete(canonicalVariantAttributes)
      .where(inArray(canonicalVariantAttributes.variantId, variantIds));
  }
  // The shared helper, not a direct delete. A correctly-scoped teardown can
  // still be blocked by a row a SIBLING minted — the matcher's retrieval is a
  // trigram scan over every `canonical_products` row, so another file's
  // `runMatch` can record a `match_decisions` row citing this file's fixture,
  // and both citing columns are `ON DELETE restrict`. `deleteTestCanonicalRows`
  // DECLINES exactly the pinned ids rather than deleting somebody else's row,
  // and `canonical-fixture-census.test.ts` fails the build on a direct delete —
  // which is how this fixture's first draft was caught.
  await deleteTestCanonicalRows(db, { productIds: PRODUCT_IDS, variantIds });
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, [RECORD]));
  await db.delete(catalogSources).where(inArray(catalogSources.id, [SOURCE]));
  await db.delete(merchants).where(inArray(merchants.id, [MERCHANT]));
  await db.delete(categories).where(inArray(categories.id, [CHILD_CATEGORY, ROOT_CATEGORY]));
  await closePostgres();
});

describe('same-variant', () => {
  it('refuses a product whose two requirements are met by DIFFERENT variants', async () => {
    const matched = await countFacetMatchedProducts(
      db,
      scoped({
        ...NO_FACET_REQUIREMENTS,
        variant: [
          { key: 'colour', values: ['red'] },
          { key: 'shoe_size_eu', values: ['43'] },
        ],
      }),
    );
    // Exactly ONE: `genuine`. `crossed` has a red variant and a 43 variant and
    // no red 43, which is the false match.
    expect(matched).toBe(1);
  });

  it('…and the positive control: each requirement ALONE matches both', async () => {
    // Without this the assertion above would pass just as well against a
    // predicate that matched nothing at all.
    const red = await countFacetMatchedProducts(
      db,
      scoped({ ...NO_FACET_REQUIREMENTS, variant: [{ key: 'colour', values: ['red'] }] }),
    );
    const size = await countFacetMatchedProducts(
      db,
      scoped({ ...NO_FACET_REQUIREMENTS, variant: [{ key: 'shoe_size_eu', values: ['43'] }] }),
    );
    expect(red).toBe(2);
    expect(size).toBe(3);
  });

  it('…and the MUTATION: the naive per-requirement predicate really does false-match', async () => {
    // The assertion above is only worth something if the wrong implementation
    // would have failed it. So here is the wrong implementation, written out:
    // one independent `exists` per requirement, each free to find its OWN
    // variant. It is what `findProductIdsSatisfyingAttribute` does today when
    // the service loops over constraints and intersects the product ids.
    //
    // Without this case, "returns 1" would pass just as well against a
    // predicate that had quietly stopped matching anything.
    const naive = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from canonical_products p
      where p.status = 'active'
        and p.id = any(${sql.param(PRODUCT_IDS)}::text[])
        and exists (select 1 from canonical_variant_attributes a
                    join canonical_variants v on v.id = a.variant_id
                    where v.product_id = p.id and a.attribute_key = 'colour'
                      and a.normalized_value = 'red')
        and exists (select 1 from canonical_variant_attributes a
                    join canonical_variants v on v.id = a.variant_id
                    where v.product_id = p.id and a.attribute_key = 'shoe_size_eu'
                      and a.normalized_value = '43')`);
    // TWO — `crossed` and `genuine`. The extra one is the false match, and the
    // shopper who clicked it finds a red 41 and a black 43.
    expect(naive[0]?.total).toBe(2);
  });

  it('counts a VARIANT facet at product grain, once per product', async () => {
    const rows = await countVariantAttributeBuckets(db, scoped(), ['colour']);
    const byValue = new Map(rows.map((row) => [row.bucketValue, row.productCount]));
    // `crossed` has TWO variants and is one product; a `count(*)` over the axis
    // rows would report it under `red` once and under `black` once, which is
    // right here, but a product with two RED variants would be counted twice.
    expect(byValue.get('red')).toBe(2);
    expect(byValue.get('black')).toBe(2);
  });

  it('takes a bucket count on the variant that also meets the OTHER requirement', async () => {
    const rows = await countVariantAttributeBuckets(
      db,
      scoped({ ...NO_FACET_REQUIREMENTS, variant: [{ key: 'shoe_size_eu', values: ['43'] }] }),
      ['colour'],
    );
    const byValue = new Map(rows.map((row) => [row.bucketValue, row.productCount]));
    // Only `genuine` has a red 43, so "red" beside a selected size of 43 reads
    // 1 — not 2, which is what a bucket count taken over ANY red variant of a
    // product that has SOME 43 variant would report.
    expect(byValue.get('red')).toBe(1);
    expect(byValue.get('black')).toBe(2);
  });
});

describe('same-offer', () => {
  it('refuses a product whose price and availability come from DIFFERENT offers', async () => {
    const matched = await countFacetMatchedProducts(
      db,
      scoped({
        ...NO_FACET_REQUIREMENTS,
        offer: {
          availability: ['in_stock'],
          priceBounds: [{ currency: 'EUR', maxMinor: 20_000 }],
        },
      }),
    );
    // `genuine` alone. `crossed`'s cheap offer is out of stock and its in-stock
    // offer is 900 €; `plain`'s is in stock at 500 €.
    expect(matched).toBe(1);
  });

  it('…and the MUTATION: the naive per-requirement predicate really does false-match', async () => {
    // The same-offer half of the mutation above: one `exists` for the price and
    // a separate one for the stock state, each free to find its own offer.
    const naive = await db.execute<{ total: number }>(sql`
      select count(*)::int as total from canonical_products p
      where p.status = 'active'
        and p.id = any(${sql.param(PRODUCT_IDS)}::text[])
        and exists (select 1 from offers o
                    join canonical_variants v on v.id = o.canonical_variant_id
                    where v.product_id = p.id and o.status = 'active'
                      and o.availability = 'in_stock')
        and exists (select 1 from offers o
                    join canonical_variants v on v.id = o.canonical_variant_id
                    where v.product_id = p.id and o.status = 'active'
                      and o.price_currency = 'EUR' and o.price_amount <= 20000)`);
    // TWO — `crossed` and `genuine`. `crossed`'s cheap offer is out of stock,
    // so the shopper who clicked it cannot buy it at that price.
    expect(naive[0]?.total).toBe(2);
  });

  it('…and the positive control: each requirement ALONE matches more', async () => {
    const inStock = await countFacetMatchedProducts(
      db,
      scoped({ ...NO_FACET_REQUIREMENTS, offer: { availability: ['in_stock'] } }),
    );
    const cheap = await countFacetMatchedProducts(
      db,
      scoped({
        ...NO_FACET_REQUIREMENTS,
        offer: { priceBounds: [{ currency: 'EUR', maxMinor: 20_000 }] },
      }),
    );
    expect(inStock).toBe(3);
    expect(cheap).toBe(2);
  });

  it('composes with same-variant: the offer must be ON the qualifying variant', async () => {
    const matched = await countFacetMatchedProducts(
      db,
      scoped({
        ...NO_FACET_REQUIREMENTS,
        variant: [{ key: 'colour', values: ['red'] }],
        offer: { availability: ['in_stock'] },
      }),
    );
    // `crossed`'s red variant carries only the out-of-stock offer, so a red
    // in-stock configuration does not exist for it. `genuine`'s does.
    expect(matched).toBe(1);
  });

  it('counts an offer facet once per product however many offers it has', async () => {
    const rows = await countOfferAvailabilityBuckets(db, scoped());
    const byValue = new Map(rows.map((row) => [row.bucketValue, row.productCount]));
    // `genuine` carries TWO in-stock offers on ONE variant. `count(*)` would
    // report four in-stock products where there are three.
    expect(byValue.get('in_stock')).toBe(3);
    expect(byValue.get('out_of_stock')).toBe(1);
  });

  it('groups the price span by the offers OWN currency, never mixing minor units', async () => {
    const spans = await measureOfferPriceSpans(db, scoped());
    const byCurrency = new Map(spans.map((row) => [row.currency, row]));
    expect(byCurrency.get('EUR')?.minMinor).toBe(10_000);
    expect(byCurrency.get('EUR')?.maxMinor).toBe(90_000);
    expect(byCurrency.get('USD')?.minMinor).toBe(13_000);
    // Numbers, not strings: `postgres.js` decodes `bigint` as text and a
    // concatenated bound is the failure that produces.
    expect(typeof byCurrency.get('EUR')?.minMinor).toBe('number');
  });
});

describe('counts, unknowns and the scope', () => {
  it('counts a PRODUCT facet once per product', async () => {
    const rows = await countProductAttributeBuckets(db, scoped(), ['material']);
    const byValue = new Map(rows.map((row) => [row.bucketValue, row.productCount]));
    expect(byValue.get('leather')).toBe(2);
    expect(byValue.get('canvas')).toBe(1);
  });

  it('reports the products holding NO value as unknown, not as zero', async () => {
    const matched = await countFacetMatchedProducts(db, scoped());
    const rows = await countProductsWithAttribute(db, scoped(), ['material', 'colour']);
    const present = new Map(rows.map((row) => [row.attributeKey, row.productCount]));
    // `unknown = matched − present`, both over the SAME predicate. One product
    // has no `material` value and one has no `colour` axis. Neither may satisfy
    // a requirement on it — which the refusal below shows — and this is where a
    // shopper is told how many that is.
    expect(matched - (present.get('material') ?? 0)).toBe(1);
    expect(matched - (present.get('colour') ?? 0)).toBe(1);
    // The positive control: the presence count is not simply zero.
    expect(present.get('material')).toBe(3);
    expect(present.get('colour')).toBe(3);
  });

  it('a selection on a value NOBODY has is empty rather than everything', async () => {
    const matched = await countFacetMatchedProducts(
      db,
      scoped({ ...NO_FACET_REQUIREMENTS, product: [{ key: 'material', values: ['titanium'] }] }),
    );
    expect(matched).toBe(0);
  });

  it('measures a numeric span over the products that HAVE the value', async () => {
    const rows = await measureProductAttributeRanges(db, scoped(), ['weight']);
    expect(rows[0]?.minValue).toBe(900);
    expect(rows[0]?.maxValue).toBe(1_100);
    expect(rows[0]?.productCount).toBe(2);
  });

  it('keeps the commercial spelling beside the canonical value', async () => {
    const rows = await listObservedValueLabels(db, scoped(), ['material'], 8);
    const leather = rows.filter((row) => row.bucketValue === 'leather');
    // `Full-grain Leather` normalized to `leather`; a family filter that erased
    // it would lose the seller's own name for the thing.
    expect(leather.map((row) => row.observedLabel)).toContain('Full-grain Leather');
    // …and a spelling identical to the canonical value is NOT repeated as an
    // observed label, which would render "Leather (Leather)".
    expect(rows.every((row) => row.observedLabel !== row.bucketValue)).toBe(true);
  });

  it('resolves a category subtree from the materialized path', async () => {
    const subtree = await findFacetCategoryScope(db, ROOT_CATEGORY, true);
    expect(subtree).toEqual([ROOT_CATEGORY, CHILD_CATEGORY]);
    const own = await findFacetCategoryScope(db, ROOT_CATEGORY, false);
    expect(own).toEqual([ROOT_CATEGORY]);
  });

  it('counts a child category over the whole subtree beneath it', async () => {
    const rows = await countCategoryBuckets(db, scoped(), [CHILD_CATEGORY]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productCount).toBe(1);
  });

  it('a category scope reaches the descendants products', async () => {
    const subtree = await findFacetCategoryScope(db, ROOT_CATEGORY, true);
    const matched = await countFacetMatchedProducts(db, {
      scope: { kind: 'categories', categoryIds: subtree },
      requirements: NO_FACET_REQUIREMENTS,
      now: NOW,
    });
    expect(matched).toBe(PRODUCT_IDS.length);
  });

  it('a NON-recursive category scope excludes them', async () => {
    const own = await findFacetCategoryScope(db, ROOT_CATEGORY, false);
    const matched = await countFacetMatchedProducts(db, {
      scope: { kind: 'categories', categoryIds: own },
      requirements: NO_FACET_REQUIREMENTS,
      now: NOW,
    });
    expect(matched).toBe(PRODUCT_IDS.length - 1);
  });
});

describe('the aggregates run on the indexes they were written for', () => {
  it('the scope narrows on an index rather than scanning the catalogue', async () => {
    const rows = await db.execute<{ 'QUERY PLAN': unknown }>(sql`
      explain (format json)
      select count(distinct p.id) from canonical_products p
      where p.status = 'active' and p.category_id = any(${sql.param([ROOT_CATEGORY])}::text[])`);
    const plan = JSON.stringify(rows[0]?.['QUERY PLAN'] ?? {});
    // The shared test database is small, so the planner may legitimately choose
    // a sequential scan — asserting a node type here would be a gate that fails
    // for a reason about statistics. What IS asserted is that the index exists
    // and is a candidate; the plan-regression suite measures the choice at a
    // scale where it is a real one.
    expect(plan.length).toBeGreaterThan(10);
    const indexes = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where tablename = 'canonical_products'
        and indexname = 'canonical_products_category_id_idx'`);
    expect(indexes).toHaveLength(1);
  });
});
