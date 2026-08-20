/**
 * #737: which product statuses the brand, family and merchant AGGREGATES count.
 *
 * #628 settled the question for the filter rails — the facet count, the search
 * list and the browse list — and stopped there. These three reads sit on the
 * same pages, still spelled `status <> 'merged'`, which admits every status but
 * the tombstone: an unpublished `draft` and the operator's own `suppressed`.
 *
 * ## Each subject isolates ONE status
 *
 * The rollup subject gets its own CATEGORY, the merchant subject its own BRAND,
 * so a single count is attributable to a single status. The controls are
 * asserted FIRST in every case: three aggregates agreeing at zero is exactly
 * what an aggregate over nothing looks like, and it satisfies every equality
 * after it.
 *
 * ## The family case is a different bug, and the direction is the point
 *
 * `listFamilySharedAttributes` is not a count a shopper reads — it is a
 * UNANIMITY test, `having count(distinct product_id) = <the family's product
 * count>`. Its denominator used to be a PARAMETER supplied by
 * `family-page.service.ts`, and #628 narrowed that caller while leaving this
 * read on `<> 'merged'`. Measured: a family of two active products and one
 * suppressed one, all three carrying the same attribute, reported it as shared
 * by NOBODY —
 *
 * ```
 * CONTROL (2 active)              denominator=2  shared=1
 * SUBJECT (2 active + suppressed) denominator=2  shared=0   ← the numerator saw 3
 * ```
 *
 * — so the failure is not an inflated number but a true fact silently deleted,
 * which is the direction that ships. The repair is structural rather than a
 * predicate swap: the parameter is GONE, the read takes its own count over the
 * same predicate it compares against, and there is no argument left to
 * mismatch. `partial` is the negative control that keeps the unanimity real.
 *
 * ## Scoping
 *
 * The test database is SHARED across parallel files: every id, category, brand,
 * family and attribute key carries this run's suffix, every read is keyed on
 * rows this file created, and nothing counts a whole table. `merged_into_id` is
 * `ON DELETE restrict`, so the pointer is cleared before the rows go.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { categories } from '../../../db/schema/catalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { merchants } from '../../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import {
  canonicalAttributeValues,
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import {
  countCatalogScopeProducts,
  listBrandCategoryRollup,
  listFamilySharedAttributes,
} from '../../../db/catalogPages/catalogPageRepository.js';
import { countMerchantBrandOffers } from '../../../db/merchantPages/merchantCatalogRepository.js';
import { readProductFamilyPage } from '../family-page.service.js';

let db: Database;

const RUN = uuidv7().slice(-12);
const MERCHANT = `agg-m-${RUN}`;
const SOURCE = `agg-src-${RUN}`;
const RECORD = `agg-rec-${RUN}`;
const KEY = `agg_finish_${RUN}`;

const OBSERVED = new Date('2025-12-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:00:00.000Z');
const STALE_AT = new Date(NOW.getTime() + 86_400_000);

type Status = 'active' | 'discontinued' | 'suppressed' | 'draft' | 'merged';
const STATUSES: readonly Status[] = ['active', 'discontinued', 'suppressed', 'draft', 'merged'];

const productIds: string[] = [];
const variantIds: string[] = [];
const offerIds: string[] = [];
const brandIds: string[] = [];
const categoryIds: string[] = [];
const familyIds: string[] = [];
const valueIds: string[] = [];
/** Cleared before teardown — `merged_into_id` is `ON DELETE restrict`. */
const mergedProductIds: string[] = [];

/** status -> its own category / its own brand, so each count isolates one status. */
const categoryOf = new Map<Status, string>();
const brandOf = new Map<Status, string>();

/** The ROLLUP brand: every rollup product hangs off this one. */
const ROLLUP_BRAND = `agg-b-rollup-${RUN}`;

/**
 * Families: a control (all active), a subject (one suppressed member) and a
 * PARTIAL one, where a visible product does NOT carry the attribute. Without
 * the last, "shared=1" is equally satisfied by a predicate that matches
 * everything, and the unanimity this read exists for would go untested.
 */
const FAMILY_CONTROL = `agg-f-ctrl-${RUN}`;
const FAMILY_SUBJECT = `agg-f-subj-${RUN}`;
const FAMILY_PARTIAL = `agg-f-part-${RUN}`;

function safe(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

async function addProduct(opts: {
  id: string;
  status: Status;
  categoryId?: string;
  brandId?: string;
  familyId?: string;
  mergedIntoId?: string;
}): Promise<string> {
  productIds.push(opts.id);
  if (opts.status === 'merged') mergedProductIds.push(opts.id);
  await db.insert(canonicalProducts).values({
    id: opts.id,
    slug: `${opts.id}-slug`,
    name: `aggwidget${RUN} ${opts.id.slice(-6)}`,
    normalizedName: `aggwidget${RUN} ${opts.id.slice(-6)}`,
    status: opts.status,
    firstSeenAt: OBSERVED,
    ...(opts.categoryId === undefined ? {} : { categoryId: opts.categoryId }),
    ...(opts.brandId === undefined ? {} : { brandId: opts.brandId }),
    ...(opts.familyId === undefined ? {} : { familyId: opts.familyId }),
    ...(opts.mergedIntoId === undefined ? {} : { mergedIntoId: opts.mergedIntoId }),
  });
  return opts.id;
}

async function addVariantWithOffer(productId: string): Promise<void> {
  const variantId = `agg-v-${uuidv7().slice(-10)}-${RUN}`;
  variantIds.push(variantId);
  await db.insert(canonicalVariants).values({
    id: variantId,
    productId,
    signature: createHash('sha256').update(variantId).digest('hex'),
    isDefault: true,
    status: 'active',
    firstSeenAt: OBSERVED,
  });
  const offerId = `agg-o-${uuidv7().slice(-10)}-${RUN}`;
  offerIds.push(offerId);
  await db.insert(offers).values({
    id: offerId,
    kind: 'external',
    status: 'active',
    canonicalVariantId: variantId,
    merchantId: MERCHANT,
    sourceRecordId: RECORD,
    destinationUrl: `https://example.invalid/${offerId}`,
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

/** A SELECTED value at PRODUCT grain — what the shared-attribute read tests. */
async function addProductValue(productId: string, value: string): Promise<void> {
  const id = `agg-cav-${uuidv7().slice(-10)}-${RUN}`;
  valueIds.push(id);
  await db.insert(canonicalAttributeValues).values({
    id,
    productId,
    attributeKey: KEY,
    sourceDisplayValue: value,
    normalizedText: value,
    normalizationState: 'normalized',
    selectionState: 'selected',
    sourceRecordId: RECORD,
    observedAt: OBSERVED,
  });
}

beforeAll(async () => {
  db = await connectPostgres();

  await db.insert(merchants).values({
    id: MERCHANT,
    name: `Agg merchant ${RUN}`,
    slug: `agg-merchant-${RUN}`,
  });
  await db.insert(catalogSources).values({
    id: SOURCE,
    kind: 'feed',
    name: `agg-source-${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  await db.insert(sourceRecords).values({
    id: RECORD,
    sourceId: SOURCE,
    externalId: `agg-ext-${RUN}`,
    externalType: 'offer',
    observedAt: OBSERVED,
    contentHash: createHash('sha256').update(RUN).digest('hex'),
  });

  await db.insert(brands).values({
    id: ROLLUP_BRAND,
    name: `Agg rollup brand ${RUN}`,
    normalizedName: `agg rollup brand ${RUN}`,
    slug: `agg-rollup-${RUN}`,
  });
  brandIds.push(ROLLUP_BRAND);

  // A winner for every `merged` row (the CHECK is a biconditional).
  const winnerId = await addProduct({ id: `agg-p-winner-${RUN}`, status: 'active' });

  for (const status of STATUSES) {
    const categoryId = `agg-cat-${status}-${RUN}`;
    categoryIds.push(categoryId);
    categoryOf.set(status, categoryId);
    await db.insert(categories).values({
      id: categoryId,
      key: `agg.${status}.${RUN}`,
      name: `Agg ${status}`,
      slug: `agg-${status}-${RUN}`,
      ancestorIds: [],
      lifecycle: 'published',
      selectable: true,
      position: 0,
    });

    const brandId = `agg-b-${status}-${RUN}`;
    brandIds.push(brandId);
    brandOf.set(status, brandId);
    await db.insert(brands).values({
      id: brandId,
      name: `Agg brand ${status} ${RUN}`,
      normalizedName: `agg brand ${status} ${RUN}`,
      slug: `agg-b-${status}-${RUN}`,
    });

    // A: rollup subject — this status, in its own category, under ONE brand.
    await addProduct({
      id: `agg-p-roll-${status}-${RUN}`,
      status,
      categoryId,
      brandId: ROLLUP_BRAND,
      ...(status === 'merged' ? { mergedIntoId: winnerId } : {}),
    });

    // C: merchant subject — this status, under its OWN brand, with an offer.
    const merchProductId = await addProduct({
      id: `agg-p-merch-${status}-${RUN}`,
      status,
      brandId,
      ...(status === 'merged' ? { mergedIntoId: winnerId } : {}),
    });
    await addVariantWithOffer(merchProductId);
  }

  // B: the two families. Both members of the control are `active`; the subject
  // has one `suppressed` member, and ALL its members carry the attribute.
  for (const [familyId, slug] of [
    [FAMILY_CONTROL, 'ctrl'],
    [FAMILY_SUBJECT, 'subj'],
    [FAMILY_PARTIAL, 'part'],
  ] as const) {
    familyIds.push(familyId);
    await db.insert(canonicalProductFamilies).values({
      id: familyId,
      name: `Agg family ${slug} ${RUN}`,
      normalizedName: `agg family ${slug} ${RUN}`,
      slug: `agg-fam-${slug}-${RUN}`,
      brandId: ROLLUP_BRAND,
      productCount: 2,
    });
  }

  for (const n of [1, 2]) {
    const id = await addProduct({
      id: `agg-p-fam-ctrl-${String(n)}-${RUN}`,
      status: 'active',
      familyId: FAMILY_CONTROL,
    });
    await addProductValue(id, 'shared');
  }
  for (const [n, status] of [
    [1, 'active'],
    [2, 'active'],
    [3, 'suppressed'],
  ] as const) {
    const id = await addProduct({
      id: `agg-p-fam-subj-${String(n)}-${RUN}`,
      status,
      familyId: FAMILY_SUBJECT,
    });
    await addProductValue(id, 'shared');
  }

  // The negative control: two visible products, only ONE of which carries it.
  for (const n of [1, 2]) {
    const id = await addProduct({
      id: `agg-p-fam-part-${String(n)}-${RUN}`,
      status: 'active',
      familyId: FAMILY_PARTIAL,
    });
    if (n === 1) await addProductValue(id, 'shared');
  }
}, 240_000);

afterAll(async () => {
  if (db === undefined) return;
  if (offerIds.length > 0) await db.delete(offers).where(inArray(offers.id, offerIds));
  if (valueIds.length > 0) {
    await db.delete(canonicalAttributeValues).where(inArray(canonicalAttributeValues.id, valueIds));
  }
  for (const id of mergedProductIds) {
    await db
      .update(canonicalProducts)
      .set({ status: 'draft', mergedIntoId: null })
      .where(eq(canonicalProducts.id, id));
  }
  await deleteTestCanonicalRows(db, { productIds, variantIds });
  // `deleteTestCanonicalRows` covers products and variants only; families are
  // referenced BY products, so they go after.
  await db
    .delete(canonicalProductFamilies)
    .where(inArray(canonicalProductFamilies.id, safe(familyIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safe([RECORD])));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safe([SOURCE])));
  await db.delete(merchants).where(inArray(merchants.id, safe([MERCHANT])));
  await db.delete(brands).where(inArray(brands.id, safe(brandIds)));
  await db.delete(categories).where(inArray(categories.id, safe(categoryIds)));
  await closePostgres();
}, 240_000);

describe('#737 — which product statuses the page aggregates count', () => {
  it('the brand CATEGORY ROLLUP counts only shopper-visible products', async () => {
    const rows = await listBrandCategoryRollup(db, ROLLUP_BRAND, 50);
    const byCategory = new Map(rows.map((row) => [row.categoryId, row.productCount]));
    const countFor = (status: Status): number =>
      byCategory.get(categoryOf.get(status) ?? '') ?? 0;

    // The floor first: an aggregate over nothing satisfies every zero below.
    expect(countFor('active'), 'CONTROL: an active product was not counted').toBe(1);
    expect(countFor('discontinued'), 'a discontinued product should still count').toBe(1);

    // Was 1 apiece. `BrandPage` carries these counts BESIDE `productCount`,
    // which #628 already narrowed — so the parts could sum to more than the
    // whole on one payload, and clicking a category led to a list that
    // excluded exactly these rows.
    expect(countFor('suppressed'), 'a SUPPRESSED product is still counted').toBe(0);
    expect(countFor('draft'), 'a DRAFT product is still counted').toBe(0);
    expect(countFor('merged'), 'a merged tombstone is counted').toBe(0);
  }, 120_000);

  it('the brand rollup cannot exceed the brand total it is rendered beside', async () => {
    // The reason the rollup had to move, stated as the relation rather than as
    // five separate numbers: these are two reads on ONE payload.
    const rows = await listBrandCategoryRollup(db, ROLLUP_BRAND, 50);
    const mine = rows.filter((row) => categoryIds.includes(row.categoryId));
    const rollupSum = mine.reduce((total, row) => total + row.productCount, 0);
    const { total } = await countCatalogScopeProducts(db, {
      kind: 'brand',
      brandId: ROLLUP_BRAND,
    });

    expect(rollupSum, 'the rollup counted NOTHING — the comparison below is vacuous').toBeGreaterThan(0);
    expect(
      rollupSum,
      'the category counts sum to MORE than the brand total rendered above them',
    ).toBeLessThanOrEqual(total);
  }, 120_000);

  it('the MERCHANT per-brand offer counts admit only shopper-visible products', async () => {
    const rows = await countMerchantBrandOffers(db, { merchantId: MERCHANT, limit: 50, now: NOW });
    const byBrand = new Map(rows.map((row) => [row.brandId, row.currentOfferCount]));
    const countFor = (status: Status): number => byBrand.get(brandOf.get(status) ?? '') ?? 0;

    expect(countFor('active'), 'CONTROL: an active product\'s offer was not counted').toBe(1);
    expect(countFor('discontinued'), 'a discontinued product should still count').toBe(1);

    // These counts do not merely inflate a number: the third brand state —
    // "sells this brand, no verified relationship" — is ENUMERATED from them,
    // so a suppressed product could put a whole brand on a merchant page.
    expect(countFor('suppressed'), 'a SUPPRESSED product still lists its brand').toBe(0);
    expect(countFor('draft'), 'a DRAFT product still lists its brand').toBe(0);
    expect(countFor('merged'), 'a merged tombstone still lists its brand').toBe(0);
  }, 120_000);

  it('a family SHARED attribute survives a suppressed member, and stays unanimous', async () => {
    // Control first, and it is doing real work here: it is the shape the
    // subject differs from by exactly one suppressed row.
    const control = await listFamilySharedAttributes(db, FAMILY_CONTROL, 20);
    expect(control.map((row) => row.key), 'CONTROL: an all-active family lost its attribute').toEqual([KEY]);

    // The subject. Every one of its three products carries the attribute; one
    // is suppressed. Before #737 this was `[]` — the denominator counted two
    // and the numerator counted three, so unanimity was unsatisfiable and a
    // true fact about the family disappeared.
    const subject = await listFamilySharedAttributes(db, FAMILY_SUBJECT, 20);
    expect(
      subject.map((row) => row.key),
      'a family with a suppressed member lost an attribute all its products carry',
    ).toEqual([KEY]);

    // …and the negative control, so "shared" still means unanimous rather than
    // "some product somewhere has it".
    const partial = await listFamilySharedAttributes(db, FAMILY_PARTIAL, 20);
    expect(
      partial,
      'an attribute only ONE of two visible products carries was reported as shared',
    ).toEqual([]);
  }, 120_000);

  it('…and the family PAGE renders it, which is where the two populations met', async () => {
    // The repository test above is the mechanism; this is the surface the bug
    // actually reached. `withdrawn` keeps the offer half out of the way.
    const page = await readProductFamilyPage(
      {
        handle: `agg-fam-subj-${RUN}`,
        currency: 'EUR',
        offerContext: 'withdrawn',
        now: NOW,
      },
      db,
    );
    expect(page, 'the family page did not resolve — the assertion below is vacuous').toBeDefined();
    expect(page?.sharedAttributes.map((row) => row.key)).toEqual([KEY]);
  }, 120_000);
});
