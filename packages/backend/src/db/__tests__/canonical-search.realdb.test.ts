/**
 * Canonical multi-entity product discovery against a REAL PostgreSQL server —
 * issue #70.
 *
 * Every one of #70's thirteen test cases is answered here except two, and both
 * exceptions are deliberate rather than gaps:
 *
 * - **Case 12** (a commission, fee, referral or Pro plan cannot change organic
 *   relevance) is held STRUCTURALLY by
 *   `services/search/__tests__/search-relevance-isolation.test.ts`, because a
 *   fixture can only show that today's code does not read a fee. What this file
 *   adds is the behavioural half that IS observable: two products whose text
 *   evidence is identical and whose offer economics are opposite score
 *   identically, which is the separation of concerns as a measurement.
 * - **Case 13** (query plans use the intended indexes) belongs to
 *   `graph-plan-regression.realdb.test.ts`, which drives the same readers
 *   through `EXPLAIN` on a seeded dataset — a plan assertion needs a table big
 *   enough for the planner to face a real choice, which these fixtures are not
 *   and must not become.
 *
 * ## A real server, because half of what is under test does not exist without one
 *
 * `websearch_to_tsquery`, `ts_rank`, the `pg_trgm` `%` operator and its `<->`
 * distance, `row_number() over (partition by …)`, the generated `search_vector`
 * columns and the generated `normalized_alias` columns are all PostgreSQL. A
 * mocked repository would accept every statement in this file and prove nothing
 * about any of them.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel, so every name, slug and handle carries a per-run suffix — and the
 * suffix is inside the SEARCHABLE TEXT on purpose, so a sibling file's fixtures
 * cannot answer this file's queries and inflate a count. Teardown deletes
 * exactly what was created, children first, since every intra-graph foreign key
 * here is RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { SearchProductResult, SearchResult } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { declaredOfferCondition } from '../../services/condition/condition-mapping.service.js';
import { gs1CheckDigit } from '../../services/canonical/identifiers.js';
import { categories, listings, productVariants } from '../schema/catalog.js';
import { stores } from '../schema/stores.js';
import { deleteTestStores } from './store-teardown.js';
import { merchants, storefronts } from '../schema/merchants.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import {
  canonicalAttributeValues,
  canonicalProductAliases,
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariantAttributes,
  canonicalVariants,
  productIdentifiers,
} from '../schema/canonicalCatalog.js';
import { brands } from '../schema/organizations.js';
import { offers } from '../schema/offers.js';
import { runCanonicalSearch } from '../../services/search/canonical-search.service.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

let db: Database;

/** Unique to this run, and part of every searchable string. */
const RUN = `zx${uuidv7().replace(/-/g, '').slice(-8)}`;

const created = {
  offers: [] as string[],
  listings: [] as string[],
  stores: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  families: [] as string[],
  brands: [] as string[],
  merchants: [] as string[],
  storefronts: [] as string[],
  sources: [] as string[],
  sourceRecords: [] as string[],
  categories: [] as string[],
};

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/** A sha-256-shaped digest; `canonical_variants_signature_shape_check` demands one. */
function signature(): string {
  return uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
}

const NOW = new Date('2026-06-01T12:00:00.000Z');

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Fixture {
  brandId: string;
  otherBrandId: string;
  familyId: string;
  categoryId: string;
  phoneProId: string;
  phoneStdId: string;
  unrelatedId: string;
  twinAId: string;
  twinBId: string;
  proVariant256Id: string;
  proVariant512Id: string;
  merchantId: string;
  officialMerchantId: string;
  storefrontId: string;
  gtin: string;
  restrictedListingId: string;
}

let fixture: Fixture;

async function insertCategory(): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({ slug: `zycat-${RUN}`, name: `Zycat ${RUN}` })
    .returning({ id: categories.id });
  if (!row) throw new Error('category insert returned no row');
  created.categories.push(row.id);
  return row.id;
}

async function insertBrand(label: string): Promise<string> {
  const [row] = await db
    .insert(brands)
    .values({
      name: `${label} ${RUN}`,
      normalizedName: `${label.toLowerCase()} ${RUN}`,
      slug: `${label.toLowerCase()}-${RUN}`,
    })
    .returning({ id: brands.id });
  if (!row) throw new Error('brand insert returned no row');
  created.brands.push(row.id);
  return row.id;
}

async function insertProduct(input: {
  name: string;
  brandId?: string;
  familyId?: string;
  categoryId?: string;
  searchTokens?: string[];
  status?: 'active' | 'draft';
}): Promise<string> {
  const [row] = await db
    .insert(canonicalProducts)
    .values({
      name: input.name,
      normalizedName: input.name.toLowerCase(),
      slug: input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      brandId: input.brandId ?? null,
      familyId: input.familyId ?? null,
      categoryId: input.categoryId ?? null,
      searchTokens: input.searchTokens ?? [],
      status: input.status ?? 'active',
    })
    .returning({ id: canonicalProducts.id });
  if (!row) throw new Error('product insert returned no row');
  created.products.push(row.id);
  return row.id;
}

async function insertVariant(productId: string): Promise<string> {
  const [row] = await db
    .insert(canonicalVariants)
    .values({ productId, signature: signature() })
    .returning({ id: canonicalVariants.id });
  if (!row) throw new Error('variant insert returned no row');
  created.variants.push(row.id);
  return row.id;
}

async function insertSourceRecord(label: string): Promise<string> {
  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `search-source-${label}-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('source insert returned no row');
  created.sources.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-${label}-${RUN}`,
      observedAt: NOW,
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: {},
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('source record insert returned no row');
  created.sourceRecords.push(record.id);
  return record.id;
}

async function insertExternalOffer(input: {
  canonicalVariantId: string;
  merchantId: string;
  sourceRecordId: string;
  priceAmount?: number;
  priceCurrency?: string;
  condition?: 'new' | 'used_good';
  country?: string;
  observedAt?: Date;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  staleAt?: Date;
  storefrontId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(offers)
    .values({
      kind: 'external',
      status: 'active',
      canonicalVariantId: input.canonicalVariantId,
      merchantId: input.merchantId,
      storefrontId: input.storefrontId ?? null,
      sourceRecordId: input.sourceRecordId,
      ...declaredOfferCondition(input.condition ?? 'new'),
      destinationUrl: 'https://example.test/product',
      provider: 'test-feed',
      externalOfferId: `offer-${uuidv7()}`,
      priceAmount: input.priceAmount ?? 119_900,
      priceCurrency: input.priceCurrency ?? 'EUR',
      country: input.country ?? null,
      observedAt: input.observedAt ?? NOW,
      firstSeenAt: input.firstSeenAt ?? NOW,
      lastSeenAt: input.lastSeenAt ?? NOW,
      staleAt: input.staleAt ?? new Date(NOW.getTime() + 86_400_000),
    })
    .returning({ id: offers.id });
  if (!row) throw new Error('offer insert returned no row');
  created.offers.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();

  const categoryId = await insertCategory();
  const brandId = await insertBrand('Zybrand');
  const otherBrandId = await insertBrand('Otherbrand');

  const [family] = await db
    .insert(canonicalProductFamilies)
    .values({
      name: `Zyfam ${RUN}`,
      normalizedName: `zyfam ${RUN}`,
      slug: `zyfam-${RUN}`,
      brandId,
      productCount: 2,
    })
    .returning({ id: canonicalProductFamilies.id });
  if (!family) throw new Error('family insert returned no row');
  created.families.push(family.id);

  const phoneProId = await insertProduct({
    name: `Zyphone ${RUN} 16 Pro`,
    brandId,
    familyId: family.id,
    categoryId,
    searchTokens: ['zyphone', RUN, '16pro'],
  });
  const phoneStdId = await insertProduct({
    name: `Zyphone ${RUN} 15`,
    brandId,
    familyId: family.id,
    categoryId,
    searchTokens: ['zyphone', RUN, '15'],
  });
  const unrelatedId = await insertProduct({
    name: `Zykettle ${RUN}`,
    brandId: otherBrandId,
  });

  // A FORMER NAME, the highest-quality alias kind — `normalized_alias` is
  // GENERATED as `lower(btrim(alias))`, so nothing here writes the lookup key.
  await db.insert(canonicalProductAliases).values({
    productId: phoneProId,
    alias: `Zylegacy ${RUN} Pro`,
    kind: 'former_name',
  });

  const proVariant256Id = await insertVariant(phoneProId);
  const proVariant512Id = await insertVariant(phoneProId);
  await db.insert(canonicalVariantAttributes).values([
    {
      variantId: proVariant256Id,
      attributeKey: 'storage',
      displayValue: '256 GB',
      normalizedValue: '256gb',
      normalizationState: 'normalized',
    },
    {
      variantId: proVariant512Id,
      attributeKey: 'storage',
      displayValue: '512 GB',
      normalizedValue: '512gb',
      normalizationState: 'normalized',
    },
  ]);

  // A GTIN-13 DERIVED FROM THE RUN SUFFIX, with a computed check digit.
  //
  // Every other string this file writes carries the suffix; the barcode did not
  // at first, because a GTIN needs a valid check digit and the obvious move is
  // to reach for a well-known test value. `4006381333931` is exactly that
  // value — and `backfill.realdb.test.ts` reaches for the SAME one, so on a
  // shared database `product_identifiers_canonical_active_key` gave it to
  // whichever file inserted first and the matcher then attached that file's
  // native variant to THIS file's canonical variant. It surfaced as
  // `expected 2 canonical variants, got 1` in the OTHER file, which is the
  // worst possible place for it to appear.
  //
  // A global identifier value in a database every parallel test file shares is
  // a collision waiting for a second claimant. `gs1CheckDigit` is the writer's
  // own routine, so the derived value is as valid as the hard-coded one.
  const gtinPayload = Array.from(RUN)
    .map((character) => String(character.charCodeAt(0) % 10))
    .join('')
    .padEnd(12, '7')
    .slice(0, 12);
  const gtin = `${gtinPayload}${String(gs1CheckDigit(gtinPayload))}`;
  await db.insert(productIdentifiers).values({
    variantId: proVariant256Id,
    scheme: 'ean',
    rawValue: gtin,
    normalizedValue: gtin,
    canonicalScheme: 'gtin',
    canonicalValue: `0${gtin}`,
    status: 'active',
  });

  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Zymerch ${RUN} store`, slug: `zymerch-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('merchant insert returned no row');
  created.merchants.push(merchant.id);

  const [official] = await db
    .insert(merchants)
    .values({ name: `Zyofficial ${RUN} store`, slug: `zyofficial-${RUN}` })
    .returning({ id: merchants.id });
  if (!official) throw new Error('official merchant insert returned no row');
  created.merchants.push(official.id);

  const [storefront] = await db
    .insert(storefronts)
    .values({
      merchantId: merchant.id,
      name: `Zychannel ${RUN}`,
      slug: `zychannel-${RUN}`,
      channelKind: 'marketplace',
    })
    .returning({ id: storefronts.id });
  if (!storefront) throw new Error('storefront insert returned no row');
  created.storefronts.push(storefront.id);

  // Offers on the 256 GB variant: a cheap EUR one, a dearer USD one, a used
  // one, and one whose deadline has already passed.
  const record = await insertSourceRecord('main');
  await insertExternalOffer({
    canonicalVariantId: proVariant256Id,
    merchantId: merchant.id,
    sourceRecordId: record,
    priceAmount: 119_900,
    priceCurrency: 'EUR',
    country: 'ES',
    storefrontId: storefront.id,
  });
  await insertExternalOffer({
    canonicalVariantId: proVariant256Id,
    merchantId: official.id,
    sourceRecordId: record,
    priceAmount: 149_900,
    priceCurrency: 'USD',
  });
  await insertExternalOffer({
    canonicalVariantId: proVariant256Id,
    merchantId: merchant.id,
    sourceRecordId: record,
    priceAmount: 89_900,
    priceCurrency: 'EUR',
    condition: 'used_good',
  });
  await insertExternalOffer({
    canonicalVariantId: proVariant512Id,
    merchantId: merchant.id,
    sourceRecordId: record,
    priceAmount: 139_900,
    priceCurrency: 'EUR',
  });

  // The STALE one, on the standard model.
  //
  // Its timestamps are REALISTIC — last seen thirty days ago with a deadline
  // one day after that — rather than "seen now, expired yesterday", which is a
  // state no writer produces (`stale_at` is stamped FORWARD from
  // `last_seen_at`). The distinction is load-bearing: with the contradictory
  // shape, `assessOfferFreshness` computes a lifetime from `last_seen_at` and
  // answers `current`, so only the indexed pre-filter would have excluded it —
  // and the test would then have been measuring the pre-filter while claiming
  // to measure the derivation. Measured, by mutation-testing the pre-filter
  // away and watching this case go red.
  const lapsedSeenAt = new Date(NOW.getTime() - 30 * 86_400_000);
  await insertExternalOffer({
    canonicalVariantId: await insertVariant(phoneStdId),
    merchantId: merchant.id,
    sourceRecordId: record,
    priceAmount: 99_900,
    priceCurrency: 'EUR',
    observedAt: lapsedSeenAt,
    firstSeenAt: lapsedSeenAt,
    lastSeenAt: lapsedSeenAt,
    staleAt: new Date(lapsedSeenAt.getTime() + 86_400_000),
  });

  // A RESTRICTED native listing, projected as a native offer that the live
  // derivation must refuse.
  const [store] = await db
    .insert(stores)
    .values({
      handle: `zystore-${RUN}`,
      name: `Zystore ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!store) throw new Error('store insert returned no row');
  created.stores.push(store.id);

  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: store.id,
      title: `Zyphone ${RUN} 16 Pro native`,
      description: 'a native listing under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'restricted',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('listing insert returned no row');
  created.listings.push(listing.id);

  const [nativeVariant] = await db
    .insert(productVariants)
    .values({
      listingId: listing.id,
      title: 'Default Title',
      priceAmount: 109_900,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
    })
    .returning({ id: productVariants.id });
  if (!nativeVariant) throw new Error('native variant insert returned no row');

  const restrictedVariantId = await insertVariant(phoneProId);
  const [restrictedOffer] = await db.insert(offers).values({
    kind: 'native',
    status: 'active',
    canonicalVariantId: restrictedVariantId,
    listingId: listing.id,
    productVariantId: nativeVariant.id,
    ...declaredOfferCondition('new'),
    // CHEAPER than every other offer on this product, deliberately: if the live
    // derivation admitted a restricted listing, the summary's lowest price
    // would become this number. A fixture priced in the middle of the range
    // would make the assertion pass whether or not the rule worked.
    priceAmount: 10_000,
    priceCurrency: 'EUR',
    observedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    staleAt: new Date(NOW.getTime() + 86_400_000),
  }).returning({ id: offers.id });
  if (!restrictedOffer) throw new Error('restricted offer insert returned no row');
  created.offers.push(restrictedOffer.id);

  // A SELECTED #94 attribute value on the product — the only kind an attribute
  // filter may read. The variant option assignments above are a different
  // table and deliberately do not satisfy it.
  await db.insert(canonicalAttributeValues).values({
    productId: phoneProId,
    attributeKey: 'storage',
    sourceDisplayValue: '256 GB',
    normalizedText: '256gb',
    normalizedNumber: 256,
    normalizedUnit: 'gb',
    normalizationState: 'normalized',
    selectionState: 'selected',
    sourceRecordId: record,
    method: 'connector_declared',
  });

  // Two TWINS: identical text evidence, opposite offer economics. The pair that
  // makes #70 test case 12 observable rather than merely structural.
  const twinAId = await insertProduct({ name: `Zytwin ${RUN} alpha`, brandId });
  const twinBId = await insertProduct({ name: `Zytwin ${RUN} bravo`, brandId });
  const twinAVariant = await insertVariant(twinAId);
  const twinBVariant = await insertVariant(twinBId);
  await insertExternalOffer({
    canonicalVariantId: twinAVariant,
    merchantId: merchant.id,
    sourceRecordId: record,
    priceAmount: 1_000,
  });
  await insertExternalOffer({
    canonicalVariantId: twinBVariant,
    merchantId: merchant.id,
    sourceRecordId: record,
    priceAmount: 900_000,
  });

  fixture = {
    brandId,
    otherBrandId,
    familyId: family.id,
    categoryId,
    phoneProId,
    phoneStdId,
    unrelatedId,
    twinAId,
    twinBId,
    proVariant256Id,
    proVariant512Id,
    merchantId: merchant.id,
    officialMerchantId: official.id,
    storefrontId: storefront.id,
    gtin,
    restrictedListingId: listing.id,
  };
}, 180_000);

afterAll(async () => {
  await db.delete(offers).where(inArray(offers.id, safeIds(created.offers)));
  await db.delete(productIdentifiers).where(inArray(productIdentifiers.variantId, safeIds(created.variants)));
  await db
    .delete(canonicalVariantAttributes)
    .where(inArray(canonicalVariantAttributes.variantId, safeIds(created.variants)));
  await db
    .delete(canonicalAttributeValues)
    .where(inArray(canonicalAttributeValues.productId, safeIds(created.products)));
  await db.delete(listings).where(inArray(listings.id, safeIds(created.listings)));
  await deleteTestStores(db, safeIds(created.stores));
  await db
    .delete(canonicalProductAliases)
    .where(inArray(canonicalProductAliases.productId, safeIds(created.products)));
  await deleteTestCanonicalRows(db, {
    variantIds: created.variants,
    productIds: created.products,
  });
  await db
    .delete(canonicalProductFamilies)
    .where(inArray(canonicalProductFamilies.id, safeIds(created.families)));
  await db.delete(storefronts).where(inArray(storefronts.id, safeIds(created.storefronts)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(created.merchants)));
  await db.delete(brands).where(inArray(brands.id, safeIds(created.brands)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(created.sourceRecords)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(created.sources)));
  await db.delete(categories).where(inArray(categories.id, safeIds(created.categories)));
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function search(
  term: string,
  overrides: Partial<Parameters<typeof runCanonicalSearch>[0]> = {},
): Promise<readonly SearchResult[]> {
  const outcome = await runCanonicalSearch(
    { term, kinds: [], filters: {}, limit: 20, now: NOW, ...overrides },
    db,
  );
  return outcome.response.results;
}

function products(results: readonly SearchResult[]): SearchProductResult[] {
  return results.filter((result): result is SearchProductResult => result.kind === 'product');
}

function idsOf(results: readonly SearchResult[]): string[] {
  return results.map((result) =>
    result.kind === 'product'
      ? result.canonicalProductId
      : result.kind === 'brand'
        ? result.brandId
        : result.kind === 'product_family'
          ? result.productFamilyId
          : result.kind === 'merchant'
            ? result.merchantId
            : result.storefrontId,
  );
}

/* -------------------------------------------------------------------------- */
/*  #70's test cases                                                           */
/* -------------------------------------------------------------------------- */

describe('exact identifier lookup (case 1, acceptance 2)', () => {
  it('a bare GTIN resolves to the owning product and names the exact variant', async () => {
    const results = await search(fixture.gtin);
    const hits = products(results);
    expect(hits.map((hit) => hit.canonicalProductId)).toEqual([fixture.phoneProId]);
    expect(hits[0]?.matchStages).toContain('identifier');
    // A barcode names one configuration, and that is the strongest form of
    // variant-level intent there is (#70 entity 2).
    expect(hits[0]?.matchedVariant?.canonicalVariantId).toBe(fixture.proVariant256Id);
  });

  it('a bare identifier does NOT drag in fuzzy near-misses', async () => {
    // The reason `identifierOnly` exists: the most precise input a shopper can
    // give must not produce the least precise page. Every other entity kind and
    // every fuzzy stage is skipped.
    const results = await search(fixture.gtin);
    expect(results.every((result) => result.kind === 'product')).toBe(true);
    expect(results).toHaveLength(1);
  });

  it('a mistyped barcode falls through to the lexical stages rather than 404ing', async () => {
    // `4006381333930` has a wrong check digit, so it is not an identifier at
    // all — and a search is not an identifier assertion, so the honest answer is
    // whatever the words find, which here is nothing.
    const results = await search('4006381333930');
    expect(products(results).map((hit) => hit.canonicalProductId)).not.toContain(
      fixture.phoneProId,
    );
  });
});

describe('brand and model queries (case 2)', () => {
  it('finds the product by its full model name, on the exact-name stage', async () => {
    const hits = products(await search(`Zyphone ${RUN} 16 Pro`));
    expect(hits[0]?.canonicalProductId).toBe(fixture.phoneProId);
    expect(hits[0]?.matchStages).toContain('exact_name');
    expect(hits[0]?.brand?.id).toBe(fixture.brandId);
  });

  it('a brand query returns the BRAND as its own result kind', async () => {
    const results = await search(`Zybrand ${RUN}`);
    const brandHit = results.find((result) => result.kind === 'brand');
    expect(brandHit).toBeDefined();
    expect(brandHit?.kind === 'brand' && brandHit.brandId).toBe(fixture.brandId);
  });
});

describe('alias lookup (case 3)', () => {
  it('a FORMER NAME finds the product it used to name', async () => {
    const hits = products(await search(`Zylegacy ${RUN} Pro`));
    expect(hits.map((hit) => hit.canonicalProductId)).toContain(fixture.phoneProId);
    const hit = hits.find((candidate) => candidate.canonicalProductId === fixture.phoneProId);
    expect(hit?.matchStages).toContain('exact_alias');
  });
});

describe('product-family query (case 4)', () => {
  it('returns the family as its own result kind, with its brand', async () => {
    const results = await search(`Zyfam ${RUN}`);
    const family = results.find((result) => result.kind === 'product_family');
    expect(family).toBeDefined();
    if (family?.kind !== 'product_family') return;
    expect(family.productFamilyId).toBe(fixture.familyId);
    expect(family.brand?.id).toBe(fixture.brandId);
  });
});

describe('merchant and storefront queries (case 5)', () => {
  it('finds a merchant by name', async () => {
    const results = await search(`Zymerch ${RUN} store`);
    const merchant = results.find((result) => result.kind === 'merchant');
    expect(merchant).toBeDefined();
    if (merchant?.kind !== 'merchant') return;
    expect(merchant.merchantId).toBe(fixture.merchantId);
    // ADR 0002 D9's ONE stored verdict, republished rather than re-derived.
    expect(merchant.claimState).toBe('unclaimed');
  });

  it('finds a storefront by name, carrying the merchant that operates it', async () => {
    const results = await search(`Zychannel ${RUN}`);
    const storefront = results.find((result) => result.kind === 'storefront');
    expect(storefront).toBeDefined();
    if (storefront?.kind !== 'storefront') return;
    expect(storefront.storefrontId).toBe(fixture.storefrontId);
    expect(storefront.merchant.id).toBe(fixture.merchantId);
  });
});

describe('typo and fuzzy queries (case 6)', () => {
  it('finds the product from a misspelling, on the fuzzy stage', async () => {
    // One transposed letter in the model word. The fixture keeps the run suffix
    // so the trigram similarity is dominated by the part that is spelled right,
    // which is the real shape of a typo.
    const hits = products(await search(`Zyphnoe ${RUN} 16 Pro`));
    const hit = hits.find((candidate) => candidate.canonicalProductId === fixture.phoneProId);
    expect(hit, 'the misspelling found nothing').toBeDefined();
    expect(hit?.matchStages).toContain('fuzzy');
  });

  it('a fuzzy hit never outranks an exact one', async () => {
    // Both products share the run suffix, so both are fuzzy candidates for this
    // query; only one matches exactly. Acceptance 2 as an ordering.
    const hits = products(await search(`Zyphone ${RUN} 15`));
    expect(hits[0]?.canonicalProductId).toBe(fixture.phoneStdId);
  });
});

describe('structured filters (case 7)', () => {
  it('a brand filter excludes products of other brands', async () => {
    const hits = products(
      await search(`Zy ${RUN}`, { filters: { brandIds: [fixture.otherBrandId] } }),
    );
    expect(hits.map((hit) => hit.canonicalProductId)).not.toContain(fixture.phoneProId);
  });

  it('a category filter excludes products outside it', async () => {
    const hits = products(
      await search(`Zykettle ${RUN}`, { filters: { categorySlugs: [`zycat-${RUN}`] } }),
    );
    // `Zykettle` carries no category, so the filter removes it entirely.
    expect(hits.map((hit) => hit.canonicalProductId)).not.toContain(fixture.unrelatedId);
  });

  it('a merchant filter narrows to products that merchant actually offers', async () => {
    const hits = products(
      await search(`Zyphone ${RUN} 16 Pro`, {
        filters: { merchantIds: [fixture.officialMerchantId] },
      }),
    );
    expect(hits.map((hit) => hit.canonicalProductId)).toContain(fixture.phoneProId);

    const none = products(
      await search(`Zyphone ${RUN} 15`, { filters: { merchantIds: [fixture.officialMerchantId] } }),
    );
    // The standard model's only offer is stale AND from the other merchant, so
    // an offer-side filter removes the product from the page entirely.
    expect(none.map((hit) => hit.canonicalProductId)).not.toContain(fixture.phoneStdId);
  });

  it('a condition-SEGMENT filter narrows to offers in that segment', async () => {
    const used = products(
      await search(`Zyphone ${RUN} 16 Pro`, { filters: { conditionGroups: ['used'] } }),
    );
    const hit = used.find((candidate) => candidate.canonicalProductId === fixture.phoneProId);
    expect(hit).toBeDefined();
    expect(hit?.conditionGroups).toEqual(['used']);
    expect(hit?.offerSummary?.lowestPrice?.amount).toBe(89_900);
  });

  it('an attribute filter admits the matching #94 SELECTED value and refuses the rest', async () => {
    const matching = products(
      await search(`Zyphone ${RUN} 16 Pro`, {
        filters: { attributes: [{ key: 'storage', value: '256gb' }] },
      }),
    );
    expect(matching.map((hit) => hit.canonicalProductId)).toContain(fixture.phoneProId);

    // The fixture that makes the assertion above mean something: the same
    // product, the same key, a value it does NOT carry.
    const wrong = products(
      await search(`Zyphone ${RUN} 16 Pro`, {
        filters: { attributes: [{ key: 'storage', value: '512gb' }] },
      }),
    );
    expect(wrong.map((hit) => hit.canonicalProductId)).not.toContain(fixture.phoneProId);

    const inRange = products(
      await search(`Zyphone ${RUN} 16 Pro`, {
        filters: { attributes: [{ key: 'storage', minNumber: 200, maxNumber: 300 }] },
      }),
    );
    expect(inRange.map((hit) => hit.canonicalProductId)).toContain(fixture.phoneProId);
  });

  it('a variant OPTION assignment does not satisfy an attribute filter', async () => {
    // `canonical_variant_attributes` (the option axes that DEFINE a variant) and
    // `canonical_attribute_values` (facts a source asserted, one of which may be
    // SELECTED) are different tables answering different questions. The 512 GB
    // variant exists and carries that option — and no selected registry value
    // says so, which is why the filter above correctly refuses it.
    const hits = products(
      await search(`Zyphone ${RUN} 16 Pro`, {
        filters: { attributes: [{ key: 'storage', value: '512gb' }] },
      }),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('multi-currency price filters (case 8)', () => {
  it('compares in the filter currency and reports the conversion it used', async () => {
    const outcome = await runCanonicalSearch(
      {
        term: `Zyphone ${RUN} 16 Pro`,
        kinds: ['product'],
        filters: { price: { currency: 'EUR', maxMinor: 100_000 } },
        limit: 20,
        now: NOW,
      },
      db,
    );
    // The 899.00 EUR used offer clears the bound; the 1,199.00 EUR one does not.
    const hits = products(outcome.response.results);
    expect(hits.map((hit) => hit.canonicalProductId)).toContain(fixture.phoneProId);
    // A USD offer sat in the candidate set, so a conversion happened and the
    // response says what it converted with — #70's "explicit FX behavior".
    expect(outcome.response.fx?.currency).toBe('EUR');
    expect(outcome.response.fx?.provider).toBeDefined();
  });

  it('a bound below every offer removes the product rather than rounding it in', async () => {
    const hits = products(
      await search(`Zyphone ${RUN} 16 Pro`, {
        filters: { price: { currency: 'EUR', maxMinor: 1_000 } },
      }),
    );
    expect(hits.map((hit) => hit.canonicalProductId)).not.toContain(fixture.phoneProId);
  });
});

describe('stale offers and current-price summaries (case 9, freshness rules 1 and 3)', () => {
  it('a product whose only offer has lapsed keeps its result and carries NO price', async () => {
    const hits = products(await search(`Zyphone ${RUN} 15`));
    const hit = hits.find((candidate) => candidate.canonicalProductId === fixture.phoneStdId);
    expect(hit, 'the product disappeared instead of losing its price').toBeDefined();
    // ABSENT, never a price of zero and never the lapsed amount. #70 freshness
    // rule 1 (the product is still useful) and rule 3 (the price is not) in one
    // assertion.
    expect(hit?.offerSummary).toBeUndefined();
    expect(hit?.conditionGroups).toEqual([]);
  });

  it('a fresh product reports the lowest CURRENT price', async () => {
    const hits = products(await search(`Zyphone ${RUN} 16 Pro`));
    const hit = hits.find((candidate) => candidate.canonicalProductId === fixture.phoneProId);
    expect(hit?.offerSummary?.lowestPrice).toEqual({ amount: 89_900, currency: 'EUR' });
  });
});

describe('restricted native listings (case 10, freshness rule 5)', () => {
  it('a restricted listing contributes no sellable availability', async () => {
    // The native offer row is still ACTIVE and still stale-free; what refuses it
    // is `deriveNativeCheckoutEligibility` reading `listings.status` LIVE inside
    // the projection. The product's summary must therefore never report the
    // restricted listing's 1,099.00 as its lowest price.
    const hits = products(await search(`Zyphone ${RUN} 16 Pro`));
    const hit = hits.find((candidate) => candidate.canonicalProductId === fixture.phoneProId);
    expect(hit, 'the product disappeared entirely').toBeDefined();
    // The restricted listing's offer is the CHEAPEST on this product, so this
    // assertion fails the moment the derivation stops refusing it.
    expect(hit?.offerSummary?.lowestPrice?.amount).toBe(89_900);
  });
});

describe('deterministic pagination (case 11)', () => {
  it('pages through a broad query with no duplicate and no missing row', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const outcome = await runCanonicalSearch(
        {
          term: `Zy ${RUN}`,
          kinds: [],
          filters: {},
          limit: 2,
          now: NOW,
          ...(cursor === undefined ? {} : { cursor }),
        },
        db,
      );
      seen.push(...idsOf(outcome.response.results));
      cursor = outcome.response.nextCursor;
      if (cursor === undefined) break;
    }
    // No duplicates across pages — the property a keyset gives and an offset
    // does not.
    expect(new Set(seen).size).toBe(seen.length);

    const single = await runCanonicalSearch(
      { term: `Zy ${RUN}`, kinds: [], filters: {}, limit: 50, now: NOW },
      db,
    );
    // …and the union of the small pages is the same SET the one big page
    // returns. Compared as sets rather than as sequences on purpose: the paged
    // walk stops at whatever the cursor reached, and what must not differ is
    // membership.
    expect(new Set(seen)).toEqual(new Set(idsOf(single.response.results)));
    expect(seen.length).toBeGreaterThan(2);
  });

  it('a cursor from another query is ignored rather than misapplied', async () => {
    const first = await runCanonicalSearch(
      { term: `Zy ${RUN}`, kinds: [], filters: {}, limit: 1, now: NOW },
      db,
    );
    expect(first.response.nextCursor).toBeDefined();
    const foreign = await runCanonicalSearch(
      {
        term: `Zykettle ${RUN}`,
        kinds: [],
        filters: {},
        limit: 5,
        now: NOW,
        ...(first.response.nextCursor === undefined ? {} : { cursor: first.response.nextCursor }),
      },
      db,
    );
    // The fingerprint does not match, so the cursor is unreadable and the query
    // answers from the first page — never from a boundary that means nothing in
    // this result set.
    expect(idsOf(foreign.response.results)).toContain(fixture.unrelatedId);
  });
});

describe('one canonical entity per product, never one per listing (acceptance 1)', () => {
  it('four offers on two variants of one product produce ONE result', async () => {
    const hits = products(await search(`Zyphone ${RUN} 16 Pro`));
    const matching = hits.filter((hit) => hit.canonicalProductId === fixture.phoneProId);
    expect(matching).toHaveLength(1);
    // …and the summary counts the offers, so the fan-out is reported rather
    // than lost.
    expect(matching[0]?.offerSummary?.currentOfferCount).toBeGreaterThanOrEqual(3);
  });
});

describe('offer economics cannot change organic relevance (case 12, behavioural half)', () => {
  it('two products with identical text evidence score identically whatever their prices', async () => {
    // One is offered at 10.00 and the other at 9,000.00, from the same merchant,
    // in the same currency, with the same freshness. Relevance is computed
    // before any offer is read, so the two scores must be equal — and the
    // ORDERING between them must fall to the id tiebreak, not to the money.
    const hits = products(await search(`Zytwin ${RUN}`));
    const alpha = hits.find((hit) => hit.canonicalProductId === fixture.twinAId);
    const bravo = hits.find((hit) => hit.canonicalProductId === fixture.twinBId);
    expect(alpha, 'the cheap twin was not found').toBeDefined();
    expect(bravo, 'the expensive twin was not found').toBeDefined();
    expect(alpha?.relevance).toBe(bravo?.relevance);
  });
});

describe('the applied query is echoed, and the raw term never is', () => {
  it('reports the normalization, the tokens and how an identifier was read', async () => {
    const outcome = await runCanonicalSearch(
      { term: `  Zyphone   ${RUN}   16 Pro  `, kinds: ['product'], filters: {}, limit: 5, now: NOW },
      db,
    );
    expect(outcome.response.applied.normalized).toBe(`zyphone ${RUN} 16 pro`);
    expect(outcome.response.applied.tokens).toContain('zyphone');
    expect(outcome.response.policyVersion).toBe('sr-1');

    const identifierRead = await runCanonicalSearch(
      { term: fixture.gtin, kinds: ['product'], filters: {}, limit: 5, now: NOW },
      db,
    );
    expect(identifierRead.response.applied.identifiers.join(' ')).toContain(fixture.gtin);
  });
});
