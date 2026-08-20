/**
 * #628: which variant STATUSES may answer an attribute filter — measured across
 * the three rails that serve one page.
 *
 * This pinned a DEFECT and now pins the DECISION that closed it. The reason it
 * had to drive all three rails is the one #625 records for #616: the
 * contradiction is invisible from any one rail, so the only thing that makes it
 * a fact anybody can act on is a case that fails when either side moves.
 *
 * ## The defect
 *
 * An operator marked a variant `suppressed` — the "do not show" — and the
 * product kept appearing in the filtered result list because of that variant's
 * attributes, while the facet count beside it correctly excluded it. Suppression
 * that does not suppress is worse than a count/list disagreement: somebody took
 * an action and it silently did nothing.
 *
 * ## Three spellings of one question, and the third was WIDER than either
 *
 * | where | predicate on `canonical_variants.status` |
 * | --- | --- |
 * | `db/facets/facetRepository.ts`, all ten variant-grain reads | `cv.status = 'active'` |
 * | `findVariantIntentMatches` (`db/search/searchCandidateRepository.ts`) | `in ('active','discontinued')` |
 * | `findProductIdsSatisfyingAttributes` (same file) | none at all |
 *
 * `CanonicalCatalogStatus` is `draft | active | discontinued | merged |
 * suppressed`, so with no predicate a `merged` TOMBSTONE — the losing half of a
 * completed merge — also satisfied a filter. #628 originally reasoned that from
 * the absent predicate and said so; this file MEASURED all three of the statuses
 * neither other rail admits, so nothing here rests on reading SQL.
 *
 * ## The decision
 *
 * All three spellings are now `SHOPPER_VISIBLE_CATALOG_STATUSES` — `active` and
 * `discontinued` — one constant in `@mercaria/shared-types`, read by the facet
 * rail and by `findProductIdsSatisfyingAttributes`. Both sides moved: the lists
 * stopped admitting `suppressed`, `merged` and `draft`, and the COUNT started
 * admitting `discontinued`, which it had been excluding while both lists
 * returned it.
 *
 * The `zeta` case is the one that identifies the answer. Every other
 * expectation here is equally satisfied by `= 'active'`, so without a
 * `discontinued` subject this file could not tell the chosen set from the
 * narrower one — and the narrower one was the first candidate fix.
 *
 * ## The fixture isolates STATUS, which is the whole experiment
 *
 * Every value below is a SELECTED `canonical_attribute_values` row at VARIANT
 * grain — a shape all three rails read. So the only variable between a subject
 * and the controls is `canonical_variants.status`.
 *
 * Without that isolation the probe proves nothing: a suppressed variant carrying
 * an AXIS value would be excluded by the search rail for #616's entirely
 * separate reason, and `facet=0 search=1` would read as a status finding when it
 * was an axis finding. One confounder, two candidate causes, and a fixture that
 * mixes them cannot tell which it measured.
 *
 * `beta` exists so the facet clears `FACET_MIN_DISTINCT_VALUES` and is offered
 * at all; `alpha` is the vacuity floor and is asserted FIRST, because three
 * rails agreeing at zero is exactly what a filter matching nothing looks like
 * and it would satisfy every equality after it.
 *
 * ## What kills it
 *
 * Removing the `cv.status` predicate from `findProductIdsSatisfyingAttributes`
 * — restoring the defect — reds the three subject cases and leaves the control
 * green. Narrowing either rail to `= 'active'` instead reds `zeta` alone, on
 * both the facet and the list halves, which is why that case exists.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files: every id, the attribute KEY
 * and the category are namespaced to this run, and the teardown deletes only
 * those. `merged_into_id` is `ON DELETE restrict`, so the merge pointer is
 * cleared before the variants are deleted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { categories } from '../../../db/schema/catalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { merchants } from '../../../db/schema/merchants.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
} from '../../../db/schema/attributeRegistry.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import { findProductIdsSatisfyingAttributes } from '../../../db/search/searchCandidateRepository.js';
import { browseCatalogProducts } from '../../catalog-pages/product-browse.service.js';
import { resolveFacets } from '../facet.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const CATEGORY = `vsf-cat-${RUN}`;
const BRAND = `vsf-brand-${RUN}`;
const SOURCE = `vsf-src-${RUN}`;
const RECORD = `vsf-rec-${RUN}`;
const MERCHANT = `vsf-merch-${RUN}`;
const DEFINITION = `vsf-def-${RUN}`;
const SCOPE_ROW = `vsf-defcat-${RUN}`;

/** Lowercase snake, which `attribute_definitions_key_shape_check` requires. */
const KEY = `vsf_finish_${RUN}`;

const ACTIVE_A = `vsf-p-active-a-${RUN}`;
const ACTIVE_B = `vsf-p-active-b-${RUN}`;
const SUPPRESSED = `vsf-p-suppressed-${RUN}`;
const MERGED = `vsf-p-merged-${RUN}`;
const DRAFT = `vsf-p-draft-${RUN}`;
const DISCONTINUED = `vsf-p-discontinued-${RUN}`;
const PRODUCT_IDS = [ACTIVE_A, ACTIVE_B, SUPPRESSED, MERGED, DRAFT, DISCONTINUED];

const variantIds: string[] = [];
const valueIds: string[] = [];
const offerIds: string[] = [];
/** Cleared before teardown — `merged_into_id` is `ON DELETE restrict`. */
const mergedVariantIds: string[] = [];

/** The fixture clock, safely in the PAST (#253, `fixture-date-census.test.ts`). */
const OBSERVED = new Date('2025-12-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:00:00.000Z');
const STALE_AT = new Date(NOW.getTime() + 86_400_000);

/** One variant at a named status, remembered for teardown. */
async function addVariant(
  productId: string,
  index: number,
  status: 'active' | 'suppressed' | 'merged' | 'draft' | 'discontinued',
  mergedIntoId?: string,
): Promise<string> {
  const id = `vsf-v-${index}-${RUN}`;
  variantIds.push(id);
  if (status === 'merged') mergedVariantIds.push(id);
  await db.insert(canonicalVariants).values({
    id,
    productId,
    // `canonical_variants_signature_shape_check` wants 64 lowercase hex.
    signature: createHash('sha256').update(id).digest('hex'),
    name: `variant ${String(index)}`,
    isDefault: true,
    status,
    // `canonical_variants_merged_state_check` is a biconditional: the pointer is
    // present exactly when the status is `merged`.
    ...(mergedIntoId === undefined ? {} : { mergedIntoId }),
    firstSeenAt: OBSERVED,
  });
  return id;
}

/** A SELECTED registry value at VARIANT grain — the shape all three rails read. */
async function addSelectedVariantValue(variantId: string, value: string): Promise<void> {
  const id = `vsf-cav-${uuidv7().slice(-10)}-${RUN}`;
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
  const id = `vsf-o-${uuidv7().slice(-10)}-${RUN}`;
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

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(categories).values({
    id: CATEGORY,
    key: `vsf.root.${RUN}`,
    name: 'Variant status root',
    slug: `vsf-root-${RUN}`,
    ancestorIds: [],
    lifecycle: 'published',
    selectable: true,
    position: 0,
  });
  await db.insert(brands).values({
    id: BRAND,
    slug: `vsf-brand-${RUN}`,
    name: `Variant status brand ${RUN}`,
    normalizedName: `variant status brand ${RUN}`,
  });
  await db.insert(attributeDefinitions).values({
    id: DEFINITION,
    key: KEY,
    version: 1,
    lifecycleState: 'active',
    label: 'Variant status finish',
    valueType: 'string',
    cardinality: 'single',
    variantDefining: true,
    filterable: true,
    publishedAt: OBSERVED,
  });
  // Scoped to THIS run's category: an unscoped active definition applies
  // everywhere and would appear in every parallel file's facet plan.
  await db.insert(attributeDefinitionCategories).values({
    id: SCOPE_ROW,
    attributeDefinitionId: DEFINITION,
    categoryId: CATEGORY,
    includeDescendants: true,
  });
  await db.insert(catalogSources).values({
    id: SOURCE,
    kind: 'operator',
    name: `variant status realdb ${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  await db.insert(sourceRecords).values({
    id: RECORD,
    sourceId: SOURCE,
    externalId: `vsf-ext-${RUN}`,
    externalType: 'offer',
    observedAt: OBSERVED,
    // `source_records_content_hash_shape_check` wants a sha-256 hex digest.
    contentHash: createHash('sha256').update(RUN).digest('hex'),
  });
  await db.insert(merchants).values({
    id: MERCHANT,
    name: `Variant status merchant ${RUN}`,
    slug: `vsf-merchant-${RUN}`,
  });

  await db.insert(canonicalProducts).values(
    PRODUCT_IDS.map((id, index) => ({
      id,
      slug: `${id}-slug`,
      name: `vsfwidget${RUN} ${String(index)}`,
      normalizedName: `vsfwidget${RUN} ${String(index)}`,
      categoryId: CATEGORY,
      brandId: BRAND,
      status: 'active' as const,
      firstSeenAt: OBSERVED,
    })),
  );

  const activeA = await addVariant(ACTIVE_A, 1, 'active');
  await addSelectedVariantValue(activeA, 'alpha');
  await addOffer(activeA);

  const activeB = await addVariant(ACTIVE_B, 2, 'active');
  await addSelectedVariantValue(activeB, 'beta');
  await addOffer(activeB);

  const suppressed = await addVariant(SUPPRESSED, 3, 'suppressed');
  await addSelectedVariantValue(suppressed, 'gamma');
  await addOffer(suppressed);

  // A tombstone: the losing half of a completed merge, pointing at its winner.
  const merged = await addVariant(MERGED, 4, 'merged', activeA);
  await addSelectedVariantValue(merged, 'delta');
  await addOffer(merged);

  const draft = await addVariant(DRAFT, 5, 'draft');
  await addSelectedVariantValue(draft, 'epsilon');
  await addOffer(draft);

  // The subject that distinguishes the two candidate answers. #628 could not
  // carry it — no rail excluded `discontinued` then, so it measured nothing.
  const discontinued = await addVariant(DISCONTINUED, 6, 'discontinued');
  await addSelectedVariantValue(discontinued, 'zeta');
  await addOffer(discontinued);
}, 120_000);

afterAll(async () => {
  if (db === undefined) return;
  if (offerIds.length > 0) await db.delete(offers).where(inArray(offers.id, offerIds));
  if (valueIds.length > 0) {
    await db.delete(canonicalAttributeValues).where(inArray(canonicalAttributeValues.id, valueIds));
  }
  // `merged_into_id` is `ON DELETE restrict`, so the pointer goes before the
  // rows. The CHECK is a biconditional, so the status has to move with it.
  for (const id of mergedVariantIds) {
    await db
      .update(canonicalVariants)
      .set({ status: 'draft', mergedIntoId: null })
      .where(eq(canonicalVariants.id, id));
  }
  // The shared helper, not a direct delete: a sibling's `runMatch` can record a
  // `match_decisions` row citing this file's fixture and both citing columns are
  // `ON DELETE restrict`. `canonical-fixture-census.test.ts` fails the build on a
  // direct delete of these tables.
  await deleteTestCanonicalRows(db, { productIds: PRODUCT_IDS, variantIds });
  await db
    .delete(attributeDefinitionCategories)
    .where(inArray(attributeDefinitionCategories.id, [SCOPE_ROW]));
  // Demote first: an ACTIVE version refuses DELETE, which IS
  // `mercaria_attribute_definition_immutable` working.
  await db
    .update(attributeDefinitions)
    .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
    .where(inArray(attributeDefinitions.id, [DEFINITION]));
  await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, [DEFINITION]));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, [RECORD]));
  await db.delete(catalogSources).where(inArray(catalogSources.id, [SOURCE]));
  await db.delete(merchants).where(inArray(merchants.id, [MERCHANT]));
  await db.delete(brands).where(inArray(brands.id, [BRAND]));
  await db.delete(categories).where(inArray(categories.id, [CATEGORY]));
  await closePostgres();
});

/** What each rail answers for one value of {@link KEY}. */
interface RailAnswers {
  readonly facet: number;
  readonly search: number;
  readonly browse: number;
}

async function railAnswers(value: string): Promise<RailAnswers> {
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
  const facetCount =
    facet === undefined || facet.values.shape !== 'buckets'
      ? 0
      : (facet.values.buckets.find((bucket) => bucket.key === value)?.count ?? 0);

  // The one function `canonical-search.service.ts` and `product-browse.service.ts`
  // both pass their `filters.attributes` to, verbatim.
  const search = await findProductIdsSatisfyingAttributes(db, PRODUCT_IDS, [{ key: KEY, value }]);

  // …and the browse SERVICE, measured rather than inferred from that shared
  // call: the shared call is an argument, not an observation.
  const page = await browseCatalogProducts(
    {
      scope: { kind: 'brand', brandId: BRAND },
      filters: { attributes: [{ key: KEY, value }] },
      offerContext: 'included',
      limit: 24,
      now: NOW,
    },
    db,
  );

  return { facet: facetCount, search: search.length, browse: page.products.length };
}

describe('#628 — which variant statuses may answer an attribute filter', () => {
  it('the vacuity floor: an ACTIVE variant is counted AND listed by all three rails', async () => {
    // Asserted first and on its own. Three rails agreeing at zero is exactly
    // what a filter matching nothing looks like, and it satisfies every
    // equality below it.
    expect(await railAnswers('alpha')).toEqual({ facet: 1, search: 1, browse: 1 });
  });

  it('a DISCONTINUED variant is counted AND listed — the half that widened', async () => {
    // The case that says WHICH answer was taken, and the only one that can.
    // Every other expectation in this file is satisfied by `active` alone; this
    // one fails under it, so without it the file cannot tell
    // `SHOPPER_VISIBLE_CATALOG_STATUSES` from `= 'active'`.
    //
    // `discontinued` is included because the vocabulary separates it from the
    // decision to hide: the maker stopped making it, which is a fact a source
    // observed, not Mercaria's `suppressed`. Excluding it would also have made
    // this filter NARROWER than `findVariantIntentMatches` in the same file.
    //
    // The FACET rail is the side that moved here — it counted 0 while both
    // lists returned the product, so this pair disagreed in the other direction
    // before #628 and is not a regression of the count.
    expect(await railAnswers('zeta')).toEqual({ facet: 1, search: 1, browse: 1 });
  });

  it('a SUPPRESSED variant answers NOTHING — the operator\'s "do not show"', async () => {
    // Was `{ facet: 0, search: 1, browse: 1 }`: excluded from the count and
    // still answering both lists, so somebody took an action and it silently did
    // nothing. That is the defect #628 named.
    expect(await railAnswers('gamma')).toEqual({ facet: 0, search: 0, browse: 0 });
  });

  it('nor does a MERGED tombstone — the losing half of a completed merge', async () => {
    // #628 reasoned this from the absent predicate and labelled it as such;
    // measured here before and after, so nothing rests on reading SQL.
    expect(await railAnswers('delta')).toEqual({ facet: 0, search: 0, browse: 0 });
  });

  it('nor a DRAFT variant, which nothing has published', async () => {
    expect(await railAnswers('epsilon')).toEqual({ facet: 0, search: 0, browse: 0 });
  });
});
