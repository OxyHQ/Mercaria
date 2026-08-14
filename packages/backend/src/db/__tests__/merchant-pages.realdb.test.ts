/**
 * The merchant page and its catalogue browse against a REAL PostgreSQL server
 * — issue #73.
 *
 * Every property this file asserts is a property of a JOIN, a GROUP BY, a
 * keyset over an aggregate, or the live projection of an offer against the
 * listing and stock tables as they are RIGHT NOW. None of those exists under a
 * mocked repository: a mocked `select` returns whatever the fixture wrote, so a
 * deduplication that grouped by the wrong column, a scope predicate that
 * admitted another merchant's offers, or a cursor that skipped a row would all
 * look green.
 *
 * The seven acceptance criteria, each answered directly:
 *
 *  1. A merchant page can show a verified brand relationship while the brand
 *     remains a separate entity.
 *  2. A marketplace can show its own and its third-party sellers' offers
 *     without merging seller identities.
 *  3. A linked native store keeps its handle and appears as ONE link.
 *  4. An unclaimed merchant can be browsed and claimed without becoming a
 *     native store.
 *  5. Product cards are canonical and deduplicated.
 *  6. Market and storefront filters return only eligible current offers.
 *  7. (Accessibility is a storefront concern; the storefront has no test
 *     runner, so it is gated statically by
 *     `services/merchant-pages/__tests__/merchant-page-isolation.test.ts`.)
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel, so every name, slug and handle carries a per-run suffix and
 * teardown deletes exactly what it created, children first — every intra-graph
 * foreign key here is RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { MERCHANT_PAGE_FORBIDDEN_FIELDS } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { declaredOfferCondition } from '../../services/condition/condition-mapping.service.js';
import { listings } from '../schema/catalog.js';
import { stores } from '../schema/stores.js';
import { deleteTestStores } from './store-teardown.js';
import { merchants, nativeStoreLinks, storefronts } from '../schema/merchants.js';
import { brands } from '../schema/organizations.js';
import { commerceRelationships } from '../schema/relationships.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import { offers } from '../schema/offers.js';
import {
  getMerchantCatalog,
  getMerchantOffers,
} from '../../services/merchant-pages/merchant-catalog.service.js';
import {
  getMerchantPage,
  resolveCatalogScope,
} from '../../services/merchant-pages/merchant-page.service.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `oxy-operator-${RUN}`;

const created = {
  offers: [] as string[],
  sourceRecords: [] as string[],
  sources: [] as string[],
  relationships: [] as string[],
  listings: [] as string[],
  stores: [] as string[],
  storefronts: [] as string[],
  merchants: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  brands: [] as string[],
};

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/** An hour from now — comfortably inside any freshness contract. */
function future(hours = 24): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db.delete(offers).where(inArray(offers.id, safeIds(created.offers)));
  await db
    .delete(commerceRelationships)
    .where(inArray(commerceRelationships.id, safeIds(created.relationships)));
  await db.delete(listings).where(inArray(listings.id, safeIds(created.listings)));
  // Every link this file mints sits on a store it also owns, so the shared
  // teardown's store-scoped clear covers them — and covers the one it does NOT
  // own, which a delete by recorded link id never could. Links still go before
  // the merchants below, because `merchant_id` RESTRICTs them.
  await deleteTestStores(db, safeIds(created.stores));
  await deleteTestCanonicalRows(db, {
    variantIds: created.variants,
    productIds: created.products,
  });
  await db.delete(storefronts).where(inArray(storefronts.id, safeIds(created.storefronts)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(created.merchants)));
  await db.delete(brands).where(inArray(brands.id, safeIds(created.brands)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(created.sourceRecords)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(created.sources)));
  await closePostgres();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

async function mintMerchant(label: string, claimState?: 'claimed'): Promise<string> {
  const [row] = await db
    .insert(merchants)
    .values({
      name: `MP ${label} ${RUN}`,
      slug: `mp-${label}-${RUN}`,
      ...(claimState === undefined
        ? {}
        : { claimState, claimedByOxyUserId: OPERATOR, claimedAt: new Date() }),
    })
    .returning({ id: merchants.id });
  if (!row) throw new Error('mintMerchant returned no row');
  created.merchants.push(row.id);
  return row.id;
}

async function mintStorefront(input: {
  label: string;
  operatorMerchantId: string;
  country?: string;
  verified?: boolean;
  publicUrl?: string;
}): Promise<string> {
  const [row] = await db
    .insert(storefronts)
    .values({
      merchantId: input.operatorMerchantId,
      name: `MP storefront ${input.label} ${RUN}`,
      slug: `mp-storefront-${input.label}-${RUN}`,
      channelKind: 'marketplace',
      country: input.country ?? null,
      publicUrl: input.publicUrl ?? null,
      firstSeenAt: new Date(),
      ...(input.verified === true
        ? { verificationState: 'verified' as const, verifiedAt: new Date() }
        : {}),
    })
    .returning({ id: storefronts.id });
  if (!row) throw new Error('mintStorefront returned no row');
  created.storefronts.push(row.id);
  return row.id;
}

async function mintBrand(label: string): Promise<string> {
  const [row] = await db
    .insert(brands)
    .values({
      name: `MP brand ${label} ${RUN}`,
      normalizedName: `mp brand ${label} ${RUN}`.toLowerCase(),
      slug: `mp-brand-${label}-${RUN}`,
    })
    .returning({ id: brands.id });
  if (!row) throw new Error('mintBrand returned no row');
  created.brands.push(row.id);
  return row.id;
}

/** A canonical product plus one variant — the grain every offer attaches to. */
async function mintCanonicalVariant(
  label: string,
  brandId?: string,
  status: 'active' | 'draft' = 'active',
): Promise<{
  productId: string;
  variantId: string;
}> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `MP canonical ${label} ${RUN}`,
      normalizedName: `mp canonical ${label} ${RUN}`,
      slug: `mp-canonical-${label}-${RUN}`,
      status,
      ...(brandId === undefined ? {} : { brandId }),
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('mintCanonicalVariant produced no product');
  created.products.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('mintCanonicalVariant produced no variant');
  created.variants.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

/**
 * One `catalog_sources` row and one observation, shared by every offer here.
 *
 * `offers_kind_shape_check` makes `source_record_id` and `destination_url` NOT
 * NULL for an external offer, which is #57's provenance rule as a shape: an
 * external offer that cannot say where it came from is unrepresentable. One
 * source for the file is enough — nothing here asserts anything about WHICH
 * source an offer came from.
 */
let sharedSourceRecordId: string | undefined;

async function sourceRecordId(): Promise<string> {
  if (sharedSourceRecordId !== undefined) return sharedSourceRecordId;
  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `mp-source-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('sourceRecordId produced no source');
  created.sources.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `mp-ext-${RUN}`,
      observedAt: new Date(),
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: { price: 119_900 },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('sourceRecordId produced no record');
  created.sourceRecords.push(record.id);
  sharedSourceRecordId = record.id;
  return record.id;
}

/**
 * An EXTERNAL offer, written directly.
 *
 * Directly rather than through `recordExternalOffer`, because that path also
 * writes a price-history observation and a source record, and this file is
 * about which offers a browse selects rather than about how one is ingested.
 * The columns it sets are the ones the scope predicates and the projection
 * read.
 */
async function mintOffer(input: {
  canonicalVariantId: string;
  merchantId: string;
  storefrontId?: string;
  country?: string;
  priceAmount?: number;
  lastSeenAt?: Date;
  staleAt?: Date;
  condition?: 'new' | 'used_good';
}): Promise<string> {
  const seenAt = input.lastSeenAt ?? new Date();
  const [row] = await db
    .insert(offers)
    .values({
      kind: 'external',
      status: 'active',
      canonicalVariantId: input.canonicalVariantId,
      merchantId: input.merchantId,
      storefrontId: input.storefrontId ?? null,
      provider: `mp-${RUN}`,
      sourceRecordId: await sourceRecordId(),
      destinationUrl: 'https://example.test/product',
      externalOfferId: `mp-offer-${uuidv7()}`,
      priceAmount: input.priceAmount ?? 119_900,
      priceCurrency: 'EUR',
      availability: 'in_stock',
      ...declaredOfferCondition(input.condition ?? 'new'),
      country: input.country ?? null,
      observedAt: seenAt,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      lastConfirmedAt: seenAt,
      staleAt: input.staleAt ?? future(),
    })
    .returning({ id: offers.id });
  if (!row) throw new Error('mintOffer returned no row');
  created.offers.push(row.id);
  return row.id;
}

async function mintNativeStoreLink(merchantId: string, handle: string): Promise<string> {
  const [store] = await db
    .insert(stores)
    .values({ handle, name: `MP store ${RUN}`, description: '', brandColor: '#000000' })
    .returning({ id: stores.id });
  if (!store) throw new Error('mintNativeStoreLink produced no store');
  created.stores.push(store.id);

  const [link] = await db
    .insert(nativeStoreLinks)
    .values({
      merchantId,
      storeId: store.id,
      verificationMethod: 'operator',
      verifiedByOxyUserId: OPERATOR,
      verifiedAt: new Date(),
    })
    .returning({ id: nativeStoreLinks.id });
  if (!link) throw new Error('mintNativeStoreLink produced no link');
  // The link id is deliberately NOT accumulated: `deleteTestStores` clears
  // `native_store_links` by STORE, which covers both the links this file mints
  // and any the backfill attaches, so a per-id list would be a second teardown
  // path that can only be less complete than the one that runs.
  return store.id;
}

async function mintVerifiedRelationship(input: {
  kind: 'merchant_official_channel_for_brand' | 'merchant_authorized_reseller_for_brand';
  merchantId: string;
  brandId: string;
}): Promise<void> {
  const now = new Date();
  const [row] = await db
    .insert(commerceRelationships)
    .values({
      kind: input.kind,
      merchantId: input.merchantId,
      brandId: input.brandId,
      territories: [],
      languages: [],
      validFrom: now,
      status: 'verified',
      verificationMethod: 'brand_statement',
      verifiedAt: now,
      verifiedByOxyUserId: OPERATOR,
      assertedByKind: 'catalog_operator',
    })
    .returning({ id: commerceRelationships.id });
  if (!row) throw new Error('mintVerifiedRelationship returned no row');
  created.relationships.push(row.id);
}

// ── Acceptance 5: canonical, deduplicated cards ─────────────────────────────

describe('the catalogue browse deduplicates by canonical product', () => {
  it('collapses one product offered on several channels into ONE card', async () => {
    const merchantId = await mintMerchant('dedupe');
    const channelA = await mintStorefront({ label: 'dedupe-a', operatorMerchantId: merchantId });
    const channelB = await mintStorefront({ label: 'dedupe-b', operatorMerchantId: merchantId });
    const { productId, variantId } = await mintCanonicalVariant('dedupe');

    // `offers_active_commercial_key` is unique over
    // (variant | merchant | storefront | condition), so a seller's two offers on
    // ONE channel differ in condition — which is the real shape anyway: a
    // retailer listing the same phone new and refurbished on one site.
    await mintOffer({
      canonicalVariantId: variantId,
      merchantId,
      storefrontId: channelA,
      priceAmount: 119_900,
    });
    await mintOffer({
      canonicalVariantId: variantId,
      merchantId,
      storefrontId: channelB,
      priceAmount: 99_900,
    });
    await mintOffer({
      canonicalVariantId: variantId,
      merchantId,
      storefrontId: channelB,
      priceAmount: 129_900,
      condition: 'used_good',
    });

    const page = await getMerchantCatalog({
      merchantId,
      scope: { kind: 'merchant' },
      limit: 24,
    });

    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0];
    expect(entry?.canonicalProductId).toBe(productId);
    // Three offers, two channels — the counts a card states, not three cards.
    expect(entry?.currentOfferCount).toBe(3);
    expect(entry?.eligibleChannelCount).toBe(2);
    // The representative is the CHEAPEST current offer, which is what makes the
    // card's price a price somebody could actually pay here today.
    expect(entry?.representativeOffer?.price?.amount).toBe(99_900);
    // The segments the current offers actually cover — a fact, from #90's own
    // key-to-group map rather than a second vocabulary.
    expect([...(entry?.conditionGroups ?? [])].sort()).toEqual(['new', 'used']);
    expect(page.emptyReason).toBeUndefined();
  });

  it('carries no rating field on a card — a merchant rating is not a product rating', async () => {
    const merchantId = await mintMerchant('norating');
    const { variantId } = await mintCanonicalVariant('norating');
    await mintOffer({ canonicalVariantId: variantId, merchantId });

    const page = await getMerchantCatalog({ merchantId, scope: { kind: 'merchant' }, limit: 24 });
    const entry = page.entries[0];
    expect(entry).toBeDefined();
    // A RUNTIME walk, not a type assertion: `MERCHANT_CATALOG_FORBIDDEN_ENTRY_FIELDS`
    // is what a scanned gate reads, and this is what catches a key a spread put
    // there. Both are needed — neither sees what the other does.
    for (const forbidden of ['rating', 'ratingCount', 'reviewCount', 'merchantRating']) {
      expect(Object.keys(entry ?? {})).not.toContain(forbidden);
    }
  });
});

// ── Acceptance 2: a marketplace, without merging seller identities ──────────

describe('a marketplace channel keeps every seller distinct', () => {
  it('separates the operator’s own offers from its third-party sellers’', async () => {
    const platformId = await mintMerchant('platform');
    const sellerId = await mintMerchant('thirdparty');
    const channelId = await mintStorefront({
      label: 'platform-channel',
      operatorMerchantId: platformId,
    });
    const own = await mintCanonicalVariant('platform-own');
    const theirs = await mintCanonicalVariant('platform-theirs');

    await mintOffer({
      canonicalVariantId: own.variantId,
      merchantId: platformId,
      storefrontId: channelId,
    });
    await mintOffer({
      canonicalVariantId: theirs.variantId,
      merchantId: sellerId,
      storefrontId: channelId,
    });

    // The operator's own page, default scope: ONLY what the operator sells.
    const ownCatalogue = await getMerchantCatalog({
      merchantId: platformId,
      scope: { kind: 'merchant' },
      limit: 24,
    });
    expect(ownCatalogue.entries.map((entry) => entry.canonicalProductId)).toEqual([own.productId]);

    // The marketplace lens: everything on the channel, each offer keeping its
    // own seller of record. This is acceptance 2 — two products, two sellers,
    // one channel, and no identity merged into another.
    const channelScope = await resolveCatalogScope({
      merchantId: platformId,
      storefrontId: channelId,
      allSellers: true,
    });
    const channelCatalogue = await getMerchantCatalog({
      merchantId: platformId,
      scope: channelScope,
      limit: 24,
    });
    expect(channelCatalogue.entries.map((entry) => entry.canonicalProductId).sort()).toEqual(
      [own.productId, theirs.productId].sort(),
    );
    const foreign = channelCatalogue.entries.find(
      (entry) => entry.canonicalProductId === theirs.productId,
    );
    expect(foreign?.hasOtherSellers).toBe(true);
    expect(foreign?.representativeOffer?.merchantId).toBe(sellerId);
    // Marketplace-ness is the D8 comparison, made in the projection, never a
    // stored flag — so the third party's offer reads `marketplace` and the
    // operator's own reads `direct` on the SAME channel.
    expect(foreign?.representativeOffer?.sellerRole).toBe('marketplace');
    const first = channelCatalogue.entries.find(
      (entry) => entry.canonicalProductId === own.productId,
    );
    expect(first?.representativeOffer?.sellerRole).toBe('direct');
  });

  it('refuses the marketplace lens on a channel this merchant does not operate', async () => {
    const platformId = await mintMerchant('lens-platform');
    const sellerId = await mintMerchant('lens-seller');
    const channelId = await mintStorefront({
      label: 'lens-channel',
      operatorMerchantId: platformId,
    });

    // A seller may browse ITS OWN offers on somebody else's channel …
    await expect(
      resolveCatalogScope({ merchantId: sellerId, storefrontId: channelId, allSellers: false }),
    ).resolves.toEqual({ kind: 'merchant_on_channel', storefrontId: channelId });

    // … and may not browse the whole channel from its own page.
    await expect(
      resolveCatalogScope({ merchantId: sellerId, storefrontId: channelId, allSellers: true }),
    ).rejects.toThrow(/operates it/);
  });

  it('shows a marketplace seller the channel it sells through, naming the operator', async () => {
    const platformId = await mintMerchant('named-platform');
    const sellerId = await mintMerchant('named-seller');
    const channelId = await mintStorefront({
      label: 'named-channel',
      operatorMerchantId: platformId,
    });
    const { variantId } = await mintCanonicalVariant('named');
    await mintOffer({ canonicalVariantId: variantId, merchantId: sellerId, storefrontId: channelId });

    const page = await getMerchantPage(sellerId);

    // It operates nothing …
    expect(page.operatedChannels).toEqual([]);
    // … and sells through one channel, whose operator is named separately.
    expect(page.sellingChannels).toHaveLength(1);
    const channel = page.sellingChannels[0];
    expect(channel?.storefront.id).toBe(channelId);
    expect(channel?.operatedByThisMerchant).toBe(false);
    expect(channel?.operatorMerchantId).toBe(platformId);
    expect(channel?.operatorName).toContain('named-platform');
    expect(channel?.currentOfferCount).toBe(1);
    // #67 does not exist, so no tracked destination is offered and the refusal
    // carries no URL to mistake for one.
    expect(channel?.outbound).toEqual({
      outcome: 'unavailable',
      reason: 'outbound_redirect_not_built',
    });
  });
});

// ── Acceptance 6: market and channel filters ───────────────────────────────

describe('filters return only eligible current offers', () => {
  it('admits a market-less offer under a market filter and excludes another market', async () => {
    const merchantId = await mintMerchant('markets');
    const spanish = await mintCanonicalVariant('markets-es');
    const german = await mintCanonicalVariant('markets-de');
    const global = await mintCanonicalVariant('markets-global');

    await mintOffer({ canonicalVariantId: spanish.variantId, merchantId, country: 'ES' });
    await mintOffer({ canonicalVariantId: german.variantId, merchantId, country: 'DE' });
    await mintOffer({ canonicalVariantId: global.variantId, merchantId });

    const page = await getMerchantCatalog({
      merchantId,
      scope: { kind: 'merchant' },
      filters: { market: 'ES' },
      limit: 24,
    });
    const ids = page.entries.map((entry) => entry.canonicalProductId).sort();
    // The market-less offer is published for everywhere, so a Spanish filter
    // must ADMIT it — dropping it would empty a country page of every global
    // feed's offers, which is the common case rather than an edge one.
    expect(ids).toEqual([spanish.productId, global.productId].sort());
  });

  it('excludes an offer whose stored deadline has passed, and says so', async () => {
    const merchantId = await mintMerchant('stale');
    const { variantId } = await mintCanonicalVariant('stale');
    await mintOffer({
      canonicalVariantId: variantId,
      merchantId,
      staleAt: new Date(Date.now() - 3_600_000),
    });

    const page = await getMerchantCatalog({ merchantId, scope: { kind: 'merchant' }, limit: 24 });
    expect(page.entries).toEqual([]);
    // The honest empty state: this merchant HAS offers and Mercaria has not
    // heard from their source recently enough to show them. Reporting
    // `no_offers` here would be a statement about the shop rather than about
    // Mercaria's information.
    expect(page.emptyReason).toBe('stale_sources');
  });

  it('distinguishes no offers at all from a filter that excluded them', async () => {
    const emptyMerchantId = await mintMerchant('empty');
    const emptyPage = await getMerchantCatalog({
      merchantId: emptyMerchantId,
      scope: { kind: 'merchant' },
      limit: 24,
    });
    expect(emptyPage.emptyReason).toBe('no_offers');

    const filteredMerchantId = await mintMerchant('filtered');
    const { variantId } = await mintCanonicalVariant('filtered');
    await mintOffer({ canonicalVariantId: variantId, merchantId: filteredMerchantId, country: 'ES' });
    const filteredPage = await getMerchantCatalog({
      merchantId: filteredMerchantId,
      scope: { kind: 'merchant' },
      filters: { market: 'DE' },
      limit: 24,
    });
    expect(filteredPage.entries).toEqual([]);
    expect(filteredPage.emptyReason).toBe('filtered_out');
  });

  it('reports a merchant whose only products are DRAFT as having no offers', async () => {
    // The fixture that exercises the distinction the always-taken
    // canonical-product join exists to make. #60's backfill mints provisional
    // products in `draft` and promoting one is #59's decision, so a merchant
    // whose offers all point at drafts has nothing BROWSABLE — and a count that
    // skipped the join would see the offers, find the page empty and report
    // `filtered_out` when nothing was filtered.
    const merchantId = await mintMerchant('draftonly');
    const { variantId } = await mintCanonicalVariant('draftonly', undefined, 'draft');
    await mintOffer({ canonicalVariantId: variantId, merchantId });

    const page = await getMerchantCatalog({ merchantId, scope: { kind: 'merchant' }, limit: 24 });
    expect(page.entries).toEqual([]);
    expect(page.emptyReason).toBe('no_offers');
  });

  it('scopes a browse to one channel', async () => {
    const merchantId = await mintMerchant('chanfilter');
    const channelA = await mintStorefront({ label: 'chanfilter-a', operatorMerchantId: merchantId });
    const channelB = await mintStorefront({ label: 'chanfilter-b', operatorMerchantId: merchantId });
    const onA = await mintCanonicalVariant('chanfilter-a');
    const onB = await mintCanonicalVariant('chanfilter-b');
    await mintOffer({ canonicalVariantId: onA.variantId, merchantId, storefrontId: channelA });
    await mintOffer({ canonicalVariantId: onB.variantId, merchantId, storefrontId: channelB });

    const page = await getMerchantCatalog({
      merchantId,
      scope: { kind: 'merchant_on_channel', storefrontId: channelA },
      limit: 24,
    });
    expect(page.entries.map((entry) => entry.canonicalProductId)).toEqual([onA.productId]);
  });
});

// ── Catalogue browse rule 5: stable cursor pagination ──────────────────────

describe('cursor pagination', () => {
  it('pages through every product exactly once, in one total order', async () => {
    const merchantId = await mintMerchant('paging');
    // EXPLICIT timestamps, spaced across whole seconds: a uuid v7 id is not
    // monotonic within a millisecond and `last_seen_at` ties are the NORM here
    // (one ingestion page stamps one clock across every offer it writes), so a
    // test relying on insertion order would be testing the generator's luck.
    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { productId, variantId } = await mintCanonicalVariant(`paging-${String(index)}`);
      await mintOffer({
        canonicalVariantId: variantId,
        merchantId,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      });
      expected.push(productId);
    }
    // Newest sighting first.
    expected.reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await getMerchantCatalog({
        merchantId,
        scope: { kind: 'merchant' },
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.entries.map((entry) => entry.canonicalProductId));
      if (result.nextCursor === undefined) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual(expected);
  });

  it('refuses a malformed cursor rather than silently restarting', async () => {
    const merchantId = await mintMerchant('badcursor');
    await expect(
      getMerchantCatalog({ merchantId, scope: { kind: 'merchant' }, limit: 5, cursor: 'nonsense' }),
    ).rejects.toThrow(/cursor/i);
  });
});

// ── Catalogue browse rule 4: the offer-level view ──────────────────────────

describe('the offer-level view', () => {
  it('is NOT deduplicated and keeps every offer’s own seller and channel', async () => {
    const platformId = await mintMerchant('offerview-platform');
    const sellerId = await mintMerchant('offerview-seller');
    const channelId = await mintStorefront({
      label: 'offerview',
      operatorMerchantId: platformId,
    });
    const { variantId } = await mintCanonicalVariant('offerview');

    await mintOffer({ canonicalVariantId: variantId, merchantId: platformId, storefrontId: channelId });
    await mintOffer({ canonicalVariantId: variantId, merchantId: sellerId, storefrontId: channelId });

    const scope = await resolveCatalogScope({
      merchantId: platformId,
      storefrontId: channelId,
      allSellers: true,
    });
    const page = await getMerchantOffers({ merchantId: platformId, scope, limit: 24 });

    // TWO rows for ONE product — the point of this view.
    expect(page.offers).toHaveLength(2);
    expect(new Set(page.offers.map((offer) => offer.merchantId))).toEqual(
      new Set([platformId, sellerId]),
    );
    expect(new Set(page.offers.map((offer) => offer.sellerRole))).toEqual(
      new Set(['direct', 'marketplace']),
    );
  });
});

// ── Acceptance 1, 3, 4 and the page itself ─────────────────────────────────

describe('the merchant page', () => {
  it('shows a verified brand relationship while the brand stays a separate entity', async () => {
    const merchantId = await mintMerchant('brandstanding');
    const officialBrandId = await mintBrand('official');
    const plainBrandId = await mintBrand('plain');
    await mintVerifiedRelationship({
      kind: 'merchant_official_channel_for_brand',
      merchantId,
      brandId: officialBrandId,
    });

    const official = await mintCanonicalVariant('brand-official', officialBrandId);
    const plain = await mintCanonicalVariant('brand-plain', plainBrandId);
    await mintOffer({ canonicalVariantId: official.variantId, merchantId });
    await mintOffer({ canonicalVariantId: plain.variantId, merchantId });

    const page = await getMerchantPage(merchantId);
    const byBrand = new Map(page.brandStandings.map((standing) => [standing.brandId, standing]));

    // Acceptance 1: the badge is on the RELATIONSHIP, and the brand is still a
    // separate entity the page merely references by id, slug and name.
    expect(byBrand.get(officialBrandId)?.standing).toBe('official_store');
    expect(byBrand.get(officialBrandId)?.badge).toBe('official_store');
    expect(byBrand.get(officialBrandId)?.relationship).toBeDefined();

    // Relationship display rule 3: the third state is a first-class answer with
    // its own copy, not the absence of a badge.
    expect(byBrand.get(plainBrandId)?.standing).toBe('no_verified_relationship');
    expect(byBrand.get(plainBrandId)?.badge).toBeNull();
    expect(byBrand.get(plainBrandId)?.relationship).toBeUndefined();
    expect(byBrand.get(plainBrandId)?.currentOfferCount).toBe(1);
  });

  it('links a verified native store, keeping its handle and adding no second identity', async () => {
    const merchantId = await mintMerchant('linked', 'claimed');
    const handle = `mp-linked-${RUN}`;
    const storeId = await mintNativeStoreLink(merchantId, handle);

    const page = await getMerchantPage(merchantId);

    // Acceptance 3: one link, the store's own handle, and a LINK rather than a
    // redirect or an embed.
    expect(page.nativeStore?.storeId).toBe(storeId);
    expect(page.nativeStore?.handle).toBe(handle);
    expect(page.nativeStore?.presentation).toBe('link');
    // Nothing about the follow graph, the members, the policies or the
    // inventory reaches this page — the reference carries five fields.
    expect(Object.keys(page.nativeStore ?? {}).sort()).toEqual(
      ['handle', 'linkedAt', 'name', 'presentation', 'storeId'].sort(),
    );
    // A linked store means the operator manages support inside Mercaria, so the
    // contact hands over the handle and nothing else.
    expect(page.contact).toEqual({ source: 'native_store', nativeStoreHandle: handle });
    // Claimed AND linked is what "can sell on Mercaria" means.
    expect(page.standing.standing).toBe('selling_on_mercaria');
    expect(page.standing.nativeCheckout.eligible).toBe(true);
  });

  it('renders an unclaimed merchant as browsable and claimable, with no native store', async () => {
    const merchantId = await mintMerchant('unclaimed');
    const { variantId } = await mintCanonicalVariant('unclaimed');
    await mintOffer({ canonicalVariantId: variantId, merchantId });

    const page = await getMerchantPage(merchantId);

    // Acceptance 4: browsable, claimable, and emphatically not a native store.
    expect(page.standing.standing).toBe('unclaimed');
    expect(page.standing.claimState).toBe('unclaimed');
    expect(page.standing.eligibility.claimable).toBe(true);
    expect(page.nativeStore).toBeUndefined();
    expect(page.standing.nativeCheckout.eligible).toBe(false);
    expect(page.contact).toEqual({ source: 'none' });

    const catalogue = await getMerchantCatalog({
      merchantId,
      scope: { kind: 'merchant' },
      limit: 24,
    });
    expect(catalogue.entries).toHaveLength(1);
  });

  it('counts the offer mix by kind, seller role, condition and market', async () => {
    const merchantId = await mintMerchant('mix');
    const ownChannel = await mintStorefront({ label: 'mix-own', operatorMerchantId: merchantId });
    const first = await mintCanonicalVariant('mix-1');
    const second = await mintCanonicalVariant('mix-2');

    await mintOffer({
      canonicalVariantId: first.variantId,
      merchantId,
      storefrontId: ownChannel,
      country: 'ES',
      condition: 'new',
    });
    await mintOffer({
      canonicalVariantId: second.variantId,
      merchantId,
      storefrontId: ownChannel,
      condition: 'used_good',
    });
    await mintOffer({
      canonicalVariantId: second.variantId,
      merchantId,
      staleAt: new Date(Date.now() - 60_000),
    });

    const page = await getMerchantPage(merchantId);
    const mix = page.offerMix;

    expect(mix.activeOfferCount).toBe(3);
    expect(mix.currentOfferCount).toBe(2);
    // The difference IS the stale-source signal, derived rather than counted
    // twice.
    expect(mix.staleOfferCount).toBe(1);
    expect(mix.byKind).toEqual([{ key: 'external', count: 2 }]);
    expect(mix.bySellerRole).toEqual([{ key: 'direct', count: 2 }]);
    expect(mix.byCondition.map((bucket) => bucket.key).sort()).toEqual(['new', 'used_good']);
    // A market-less offer is filed under `null`, never under a country it never
    // named.
    expect(mix.byMarket.map((bucket) => bucket.key).sort()).toEqual(['ES', null].sort());
  });

  it('carries no forbidden field, at any depth of a REAL emitted page', async () => {
    // The RUNTIME half of the gate. `merchant-page-isolation.test.ts` scans the
    // SOURCE for the reach that would produce these; this walks a real response
    // for the KEYS. Neither sees what the other does — a static scan cannot see
    // a key a spread put there, and a walk cannot see an import that has not
    // been used yet.
    const merchantId = await mintMerchant('walk', 'claimed');
    await mintNativeStoreLink(merchantId, `mp-walk-${RUN}`);
    const channelId = await mintStorefront({ label: 'walk', operatorMerchantId: merchantId });
    const { variantId } = await mintCanonicalVariant('walk');
    await mintOffer({ canonicalVariantId: variantId, merchantId, storefrontId: channelId });

    const page = await getMerchantPage(merchantId);

    const seen: string[] = [];
    const walk = (value: unknown, depth: number): void => {
      if (depth > 8 || value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        seen.push(key);
        walk(nested, depth + 1);
      }
    };
    walk(page, 0);

    // The vacuity floor: a walk that visited nothing would satisfy the
    // assertion below by finding no key at all.
    expect(seen.length).toBeGreaterThan(40);
    for (const forbidden of MERCHANT_PAGE_FORBIDDEN_FIELDS) {
      expect(seen, `a real merchant page carries \`${forbidden}\``).not.toContain(forbidden);
    }
    // And the walk really reached the nested shapes, not just the top level.
    expect(seen).toContain('operatedByThisMerchant');
    expect(seen).toContain('presentation');
  });

  it('shows a verified channel’s public URL as contact when there is no native store', async () => {
    const merchantId = await mintMerchant('contact');
    await mintStorefront({
      label: 'contact',
      operatorMerchantId: merchantId,
      verified: true,
      publicUrl: 'https://example.test/shop',
    });

    const page = await getMerchantPage(merchantId);
    expect(page.contact).toEqual({
      source: 'verified_channel',
      publicUrl: 'https://example.test/shop',
    });
  });

  it('withholds an UNVERIFIED channel’s public URL', async () => {
    const merchantId = await mintMerchant('unverified-contact');
    await mintStorefront({
      label: 'unverified-contact',
      operatorMerchantId: merchantId,
      publicUrl: 'https://not-verified.test/shop',
    });

    const page = await getMerchantPage(merchantId);
    // Mercaria records no sourced contact for an external merchant, and an
    // unverified channel's URL is a sighting rather than a fact the merchant
    // published. Saying nothing is the honest rendering.
    expect(page.contact).toEqual({ source: 'none' });
  });
});
