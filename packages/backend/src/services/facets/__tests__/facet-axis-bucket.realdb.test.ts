/**
 * #616: the facet SERVICE offered a bucket the list rails could not match — and
 * now both rails answer it.
 *
 * This file was written as a MEASUREMENT that deliberately fixed nothing, and it
 * is what settled the question. #616 asked whether search and browse should
 * learn to read `canonical_variant_attributes`; its author then corrected it,
 * because `canonical-search.realdb.test.ts` had carried the opposite decision
 * since #70 itself (commit `11fed314`):
 *
 * > `canonical_variant_attributes` (the option axes that DEFINE a variant) and
 * > `canonical_attribute_values` (facts a source asserted, one of which may be
 * > SELECTED) are different tables answering different questions.
 *
 * So the question this file actually answered was not "which table should search
 * read" but "does the FACET rail publish an answer that decision makes
 * unmatchable". It does, measured below through the real services — and that is
 * what overturned the #70 reading. The tables do answer different questions; it
 * does not follow that a filter may ignore one of them while the count beside it
 * reads both.
 *
 * The reproduction had to be built carefully: the first one drove
 * `countVariantAttributeBuckets` directly with an UNREGISTERED key, which proves
 * a repository counts something and not that a shopper is offered it.
 * `planFacets` builds the rail from attribute DEFINITIONS, so a key with no
 * `attribute_definitions` row is never planned.
 *
 * ## The shape, which is the whole point
 *
 * A key that IS registered, scoped to a real category, offered through
 * `resolveFacets` — the composer `POST /facets` calls — with its values recorded
 * three ways in ONE facet:
 *
 * ```
 *   red    canonical_variant_attributes only   ← the axis-only case
 *   black  canonical_variant_attributes only   ← a second one, so the facet is
 *                                                not suppressed as `single_value`
 *   gold   canonical_attribute_values (selected, variant grain)
 * ```
 *
 * `gold` is the POSITIVE CONTROL and it is what makes the other two readable. An
 * empty result for `red` could just as easily mean the filter was mis-keyed, the
 * fixture never committed, or the constraint spelling was wrong; `gold` running
 * through the identical call and returning its product rules all three out.
 *
 * ## Where each half is measured
 *
 * - the OFFER half at `resolveFacets`, the service — never at a repository;
 * - the LIST half at `runCanonicalSearch`, the #70 service, AND at
 *   `findProductIdsSatisfyingAttributes`, the one function `canonical-search`
 *   and `product-browse` BOTH call with the constraint list verbatim.
 *
 * Neither half is a claim about a storefront screen. `app/(app)/categories/
 * [handle].tsx` renders the facet rail beside a grid fed by `GET /listings` and
 * passes the selection to neither — so the contradiction below is reachable
 * through the HTTP surfaces (`POST /facets` with `GET /search?attributes=`) and
 * is not what that screen does today.
 *
 * ## What kills these four cases, measured
 *
 * Two mutations, applied one at a time to a committed tree, and their halves do
 * not overlap — which is what says neither half is riding on the other:
 *
 * - dropping the axis `union all` from `countVariantAttributeBuckets`
 *   (`facetRepository.ts`) reds the two FACET cases and leaves the two list
 *   ones green. It does more than remove `red` and `black`: with only `gold`
 *   live the facet falls under `FACET_MIN_DISTINCT_VALUES` and is suppressed
 *   `single_value`, so the whole control disappears. That was option 1's cost,
 *   measured rather than argued, and it is why option 1 was NOT taken: axes are
 *   what the matcher writes for most variants, so narrowing the count would have
 *   stopped colour and size being offered at all.
 * - removing the `canonical_variant_attributes` branch from
 *   `findProductIdsSatisfyingAttributes`'s `atVariant` reds the two LIST cases
 *   and leaves the two facet ones green. That branch is option 2, now taken:
 *   it also inverted `a variant OPTION assignment does not satisfy an attribute
 *   filter` in `db/__tests__/canonical-search.realdb.test.ts`, which states the
 *   overturn and why.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files. Every id, the category, the
 * attribute KEY and the search term carry this run's suffix; the definition is
 * scoped to this run's own category rather than left unscoped, because an
 * unscoped active definition applies to every category and would appear in a
 * sibling's facet plan.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { categories } from '../../../db/schema/catalog.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { merchants } from '../../../db/schema/merchants.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
} from '../../../db/schema/attributeRegistry.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  canonicalVariantAttributes,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import { findProductIdsSatisfyingAttributes } from '../../../db/search/searchCandidateRepository.js';
import { runCanonicalSearch } from '../../search/canonical-search.service.js';
import { resolveFacets } from '../facet.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const CATEGORY = `axf-cat-${RUN}`;
const SOURCE = `axf-src-${RUN}`;
const RECORD = `axf-rec-${RUN}`;
const MERCHANT = `axf-merch-${RUN}`;
const DEFINITION = `axf-def-${RUN}`;
const SCOPE_ROW = `axf-defcat-${RUN}`;

/** Lowercase snake, which `attribute_definitions_key_shape_check` requires. */
const KEY = `axf_finish_${RUN}`;

/** A distinctive word so the lexical stage retrieves exactly this run's rows. */
const TERM = `axfwidget${RUN}`;

const AXIS_RED = `axf-p-axis-red-${RUN}`;
const AXIS_BLACK = `axf-p-axis-black-${RUN}`;
const SELECTED_GOLD = `axf-p-selected-gold-${RUN}`;
const PRODUCT_IDS = [AXIS_RED, AXIS_BLACK, SELECTED_GOLD];

const variantIds: string[] = [];
const valueIds: string[] = [];
const offerIds: string[] = [];

/**
 * The fixture clock, safely in the PAST (#253, `fixture-date-census.test.ts`).
 *
 * `STALE_AT` is DERIVED from `NOW` rather than written as a second literal that
 * could drift past it — every offer predicate in both domains is
 * `stale_at > now` against the CALLER's clock, and `NOW` here is that caller.
 */
const OBSERVED = new Date('2025-12-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:00:00.000Z');
const STALE_AT = new Date(NOW.getTime() + 86_400_000);

/** A canonical variant, remembered for teardown. */
async function addVariant(productId: string, index: number): Promise<string> {
  const id = `axf-v-${index}-${RUN}`;
  variantIds.push(id);
  await db.insert(canonicalVariants).values({
    id,
    productId,
    // `canonical_variants_signature_shape_check` wants 64 lowercase hex.
    signature: createHash('sha256').update(id).digest('hex'),
    name: `variant ${String(index)}`,
    isDefault: true,
    status: 'active',
    firstSeenAt: OBSERVED,
  });
  return id;
}

/** A normalized AXIS assignment — the matcher's own table, and #70's exclusion. */
async function addAxis(variantId: string, value: string): Promise<void> {
  await db.insert(canonicalVariantAttributes).values({
    id: `axf-a-${uuidv7().slice(-10)}-${RUN}`,
    variantId,
    attributeKey: KEY,
    displayValue: value,
    normalizedValue: value,
    normalizationState: 'normalized',
  });
}

/** A SELECTED registry value at VARIANT grain — the control both rails read. */
async function addSelectedVariantValue(variantId: string, value: string): Promise<void> {
  const id = `axf-cav-${uuidv7().slice(-10)}-${RUN}`;
  valueIds.push(id);
  await db.insert(canonicalAttributeValues).values({
    id,
    variantId,
    attributeDefinitionId: DEFINITION,
    definitionVersion: 1,
    attributeKey: KEY,
    sourceDisplayValue: value,
    normalizedText: value,
    normalizationState: 'normalized',
    selectionState: 'selected',
    sourceRecordId: RECORD,
    observedAt: OBSERVED,
  });
}

/** An EXTERNAL offer, so every product is one the list rails would serve. */
async function addOffer(canonicalVariantId: string): Promise<void> {
  const id = `axf-o-${uuidv7().slice(-10)}-${RUN}`;
  offerIds.push(id);
  await db.insert(offers).values({
    id,
    kind: 'external',
    status: 'active',
    canonicalVariantId,
    merchantId: MERCHANT,
    sourceRecordId: RECORD,
    destinationUrl: `https://example.invalid/${id}`,
    priceAmount: 20_000,
    priceCurrency: 'EUR',
    availability: 'in_stock',
    condition: 'new',
    conditionMappingState: 'declared',
    country: 'ES',
    observedAt: OBSERVED,
    firstSeenAt: OBSERVED,
    lastSeenAt: OBSERVED,
    staleAt: STALE_AT,
  });
}

/** Every product this run owns that satisfies one constraint on {@link KEY}. */
async function filterByValue(value: string): Promise<string[]> {
  const matched = await findProductIdsSatisfyingAttributes(db, PRODUCT_IDS, [
    { key: KEY, value },
  ]);
  return [...matched].sort();
}

/** The same question through #70's service, narrowed to this run's products. */
async function searchByValue(value?: string): Promise<string[]> {
  const outcome = await runCanonicalSearch(
    {
      term: TERM,
      kinds: ['product'],
      filters: value === undefined ? {} : { attributes: [{ key: KEY, value }] },
      limit: 20,
      now: NOW,
    },
    db,
  );
  return [...outcome.canonicalProductIds]
    .filter((id): id is string => id !== undefined && PRODUCT_IDS.includes(id))
    .sort();
}

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(categories).values({
    id: CATEGORY,
    key: `axf.root.${RUN}`,
    name: 'Axis facet root',
    slug: `axf-root-${RUN}`,
    ancestorIds: [],
    lifecycle: 'published',
    selectable: true,
    position: 0,
  });

  // A REGISTERED, ACTIVE, filterable, variant-defining attribute — which is what
  // `planFacets` needs before a shopper is offered anything at all, and what the
  // first reproduction of #616 was missing.
  // Drafted first and activated below, which is the order production writes in
  // (`draftAttributeDefinition` then `publishAttributeDefinition`) and the only
  // one `attribute_definition_categories_frozen` permits: a scope is part of
  // what the version MEANS, so it cannot be added after publication.
  await db.insert(attributeDefinitions).values({
    id: DEFINITION,
    key: KEY,
    version: 1,
    lifecycleState: 'draft',
    label: 'Axis finish',
    valueType: 'string',
    cardinality: 'single',
    variantDefining: true,
    filterable: true,
    sortable: false,
    hardConstraintCapable: true,
  });
  // Scoped to THIS run's category. An unscoped definition applies everywhere and
  // would appear in every parallel file's facet plan.
  await db.insert(attributeDefinitionCategories).values({
    id: SCOPE_ROW,
    attributeDefinitionId: DEFINITION,
    categoryId: CATEGORY,
    includeDescendants: true,
  });
  await db
    .update(attributeDefinitions)
    .set({ lifecycleState: 'active', publishedAt: OBSERVED })
    .where(eq(attributeDefinitions.id, DEFINITION));

  await db.insert(catalogSources).values({
    id: SOURCE,
    kind: 'operator',
    name: `axis facet realdb ${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  await db.insert(sourceRecords).values({
    id: RECORD,
    sourceId: SOURCE,
    externalId: `axf-ext-${RUN}`,
    externalType: 'offer',
    observedAt: OBSERVED,
    // `source_records_content_hash_shape_check` wants a sha-256 hex digest.
    contentHash: createHash('sha256').update(RUN).digest('hex'),
  });
  await db.insert(merchants).values({
    id: MERCHANT,
    name: `Axis facet merchant ${RUN}`,
    slug: `axf-merchant-${RUN}`,
  });

  await db.insert(canonicalProducts).values(
    PRODUCT_IDS.map((id, index) => ({
      id,
      slug: `${id}-slug`,
      name: `${TERM} ${String(index)}`,
      normalizedName: `${TERM} ${String(index)}`,
      categoryId: CATEGORY,
      status: 'active' as const,
      firstSeenAt: OBSERVED,
    })),
  );

  const redVariant = await addVariant(AXIS_RED, 1);
  await addAxis(redVariant, 'red');
  await addOffer(redVariant);

  const blackVariant = await addVariant(AXIS_BLACK, 2);
  await addAxis(blackVariant, 'black');
  await addOffer(blackVariant);

  // The control: the SAME key, at the SAME grain, recorded as a selected value.
  const goldVariant = await addVariant(SELECTED_GOLD, 3);
  await addSelectedVariantValue(goldVariant, 'gold');
  await addOffer(goldVariant);
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
  // The shared helper, not a direct delete: a sibling's `runMatch` can record a
  // `match_decisions` row citing this file's fixture and both citing columns are
  // `ON DELETE restrict`. `canonical-fixture-census.test.ts` fails the build on a
  // direct delete of these tables.
  await deleteTestCanonicalRows(db, { productIds: PRODUCT_IDS, variantIds });
  // Demote first: an ACTIVE version refuses DELETE, which IS
  // `mercaria_attribute_definition_immutable` working. The same teardown as
  // `attribute-registry.realdb.test.ts` and `canonical-catalog.realdb.test.ts`.
  // The demote also has to precede the scope delete below, because
  // `attribute_definition_categories_frozen` refuses that one too while the
  // parent is published.
  await db
    .update(attributeDefinitions)
    .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
    .where(inArray(attributeDefinitions.id, [DEFINITION]));
  await db
    .delete(attributeDefinitionCategories)
    .where(inArray(attributeDefinitionCategories.id, [SCOPE_ROW]));
  await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, [DEFINITION]));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, [RECORD]));
  await db.delete(catalogSources).where(inArray(catalogSources.id, [SOURCE]));
  await db.delete(merchants).where(inArray(merchants.id, [MERCHANT]));
  await db.delete(categories).where(inArray(categories.id, [CATEGORY]));
  await closePostgres();
});

/** The rail as a shopper receives it, for this run's category. */
async function railBuckets(): Promise<Map<string, number>> {
  const { response } = await resolveFacets(
    {
      scope: { kind: 'category', categoryId: CATEGORY },
      selection: [],
      locale: 'en',
      displayCurrency: 'EUR',
      now: NOW,
    },
    db,
  );
  const facet = response.facets.find((entry) => entry.key === KEY);
  if (facet === undefined) return new Map();
  if (facet.values.shape !== 'buckets') return new Map();
  return new Map(facet.values.buckets.map((bucket) => [bucket.key, bucket.count]));
}

describe('#616 — an attribute recorded only on the variant AXIS', () => {
  it('the facet SERVICE offers the axis-only values as buckets, beside the selected one', async () => {
    const buckets = await railBuckets();

    // The control first: without it, three counts of 1 could be three readings
    // of one mechanism rather than of two different tables.
    expect(buckets.get('gold')).toBe(1);

    // MEASURED: a shopper IS offered `red` and `black`, with non-zero counts,
    // from `canonical_variant_attributes` alone.
    expect(buckets.get('red')).toBe(1);
    expect(buckets.get('black')).toBe(1);
  });

  it('…and #70’s list rail now RESOLVES them, which is what #616 closed', async () => {
    // Positive control on the search rail itself: unfiltered, the term retrieves
    // all three of this run's products, so a filtered answer below is
    // attributable to the filter and not to retrieval.
    expect(await searchByValue()).toEqual([...PRODUCT_IDS].sort());

    // The control value, through the identical call.
    expect(await searchByValue('gold')).toEqual([SELECTED_GOLD]);

    // Until #616 both of these were `[]` — offered by the count above and
    // matched by nothing, which is the contradiction this file was written to
    // measure. `findProductIdsSatisfyingAttributes` now reads
    // `canonical_variant_attributes` correlated to the same variant.
    expect(await searchByValue('red')).toEqual([AXIS_RED]);
    expect(await searchByValue('black')).toEqual([AXIS_BLACK]);
  });

  it('…which is the ONE function both list services call, measured directly', async () => {
    // `canonical-search.service.ts` and `product-browse.service.ts` pass their
    // `filters.attributes` to this verbatim, so the browse rail's answer is this
    // answer and needs no second fixture.
    expect(await filterByValue('gold')).toEqual([SELECTED_GOLD]);
    expect(await filterByValue('red')).toEqual([AXIS_RED]);
    expect(await filterByValue('black')).toEqual([AXIS_BLACK]);
  });

  it('the facet ALSO counts an axis-only product as having the attribute', async () => {
    // `countProductsWithAttribute` unions the axis table too, so `unknownCount`
    // — the number the rail publishes as "products we hold no value for" —
    // reports zero rather than the two the filter cannot reach. The disagreement
    // is not confined to the buckets.
    const { response } = await resolveFacets(
      {
        scope: { kind: 'category', categoryId: CATEGORY },
        selection: [],
        locale: 'en',
        displayCurrency: 'EUR',
        now: NOW,
      },
      db,
    );
    const facet = response.facets.find((entry) => entry.key === KEY);
    expect(facet).toBeDefined();
    expect(response.matchedProductCount).toBe(3);
    expect(facet?.unknownCount).toBe(0);
  });
});
