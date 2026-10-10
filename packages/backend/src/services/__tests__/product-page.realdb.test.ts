/**
 * The canonical product page (#71), against a REAL PostgreSQL server.
 *
 * Everything here is a property of the COMPOSITION, and none of it exists under
 * a mock: a merge tombstone resolving to its winner is a merge-chain walk over
 * real rows, a variant-scoped comparison is a different SQL predicate, an
 * offer's seller identity is a join across three tables in two domains, and the
 * partition is taken over conditions a CHECK constrains.
 *
 * The failure this file guards against is the one the whole issue is about: a
 * page that renders and is wrong. A ranked offer whose row is missing, a used
 * copy under "New", a merged product served silently under somebody's old link,
 * a withheld comparison reading as a product nobody sells — every one of them
 * looks like a working page.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { bundleComponents, canonicalImages, canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import { storefronts } from '../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { nativeListingLinks, offers } from '../../db/schema/offers.js';
import { listings, productVariants } from '../../db/schema/catalog.js';
import { readListingBundleContents } from '../catalog-bundle-contents.service.js';
import { readListingBundleRecommendations } from '../catalog-bundle-recommendations.service.js';
import { listingConditionDetails } from '../../db/schema/condition.js';
import { revokeNativeListingLink } from '../../db/offers/nativeListingLinkRepository.js';
import { stores } from '../../db/schema/stores.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertOffer } from '../../db/offers/offerRepository.js';
import { readCanonicalProductPage } from '../product-page/product-page.service.js';
import { resolveOfferSellers } from '../product-page/sellers.js';
import { countActiveNativeListingsForCanonicalVariants } from '../../db/productPage/productPageRepository.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdStorefrontIds: string[] = [];
const createdSourceIds: string[] = [];
const createdListingIds: string[] = [];
const createdStoreIds: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

function digest(): string {
  return uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db.delete(bundleComponents).where(inArray(bundleComponents.bundleVariantId, safeIds(createdVariantIds)));
  await db.delete(canonicalImages).where(inArray(canonicalImages.productId, safeIds(createdProductIds)));
  await db.delete(canonicalImages).where(inArray(canonicalImages.variantId, safeIds(createdVariantIds)));
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(offers).where(inArray(offers.listingId, safeIds(createdListingIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));
  await deleteTestStores(db, safeIds(createdStoreIds));
  await db.delete(storefronts).where(inArray(storefronts.id, safeIds(createdStorefrontIds)));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
}, 60_000);

/** One canonical product with `variantCount` configurations. */
async function mintProduct(
  label: string,
  variantCount = 1,
): Promise<{ productId: string; slug: string; variantIds: string[] }> {
  const slug = `page-${label}-${RUN}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Page ${label} ${RUN}`,
      normalizedName: `page ${label} ${RUN}`,
      slug,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);

  const variantIds: string[] = [];
  for (let index = 0; index < variantCount; index += 1) {
    const [variant] = await db
      .insert(canonicalVariants)
      .values({
        productId: product.id,
        name: `Configuration ${index + 1}`,
        signature: digest(),
      })
      .returning({ id: canonicalVariants.id });
    if (!variant) throw new Error('the canonical variant was not written');
    createdVariantIds.push(variant.id);
    variantIds.push(variant.id);
  }
  return { productId: product.id, slug, variantIds };
}

/** A merchant and the channel it operates. */
async function mintMerchant(label: string): Promise<{ merchantId: string; storefrontId: string }> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Merchant ${label} ${RUN}`, slug: `merchant-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('the merchant was not written');
  createdMerchantIds.push(merchant.id);

  const [storefront] = await db
    .insert(storefronts)
    .values({
      merchantId: merchant.id,
      name: `Channel ${label} ${RUN}`,
      slug: `channel-${label}-${RUN}`,
      channelKind: 'web',
      domain: `${label}-${RUN}.example.test`.toLowerCase(),
    })
    .returning({ id: storefronts.id });
  if (!storefront) throw new Error('the storefront was not written');
  createdStorefrontIds.push(storefront.id);
  return { merchantId: merchant.id, storefrontId: storefront.id };
}

/** A catalog source and one observation on it. */
async function mintObservation(label: string): Promise<{ sourceId: string; recordId: string }> {
  const [source] = await db
    .insert(catalogSources)
    .values({
      name: `Source ${label} ${RUN}`,
      kind: 'feed',
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('the catalog source was not written');
  createdSourceIds.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-${label}-${RUN}`,
      contentHash: digest(),
      observedAt: new Date(),
      payload: { price: 1_999 },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return { sourceId: source.id, recordId: record.id };
}

/**
 * One external offer, written DIRECTLY so the case can pin a condition.
 *
 * `recordExternalOffer` derives the condition from a published #90 ruleset,
 * which is the right path for ingestion and the wrong one for a test about
 * GROUPING: it would make every fixture `unknown` unless this file also
 * published a ruleset, and the partition would then be measured over one value.
 * The row still goes through every CHECK the server holds, which is the point of
 * running against a real one.
 */
async function seedExternalOffer(input: {
  label: string;
  variantId: string;
  merchantId: string;
  storefrontId: string;
  condition: 'new' | 'used_good' | 'refurbished_seller' | 'unknown';
  priceMinor: number;
  deliveryMinor?: number;
}): Promise<string> {
  const { recordId } = await mintObservation(input.label);
  const now = new Date();
  const row = await insertOffer(db, {
    kind: 'external',
    status: 'active',
    canonicalVariantId: input.variantId,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    sourceRecordId: recordId,
    provider: `page-${input.label}-${RUN}`.toLowerCase().slice(0, 64),
    externalOfferId: `ext-${input.label}-${RUN}`,
    destinationUrl: `https://${input.label}-${RUN}.example.test/item`.toLowerCase(),
    priceAmount: input.priceMinor,
    priceCurrency: 'EUR',
    ...(input.deliveryMinor === undefined
      ? {}
      : { deliveryCostAmount: input.deliveryMinor, deliveryCostCurrency: 'EUR' }),
    availability: 'in_stock',
    condition: input.condition,
    // `declared` means the SELLER stated a taxonomy key directly, and
    // `offers_condition_declared_shape_check` requires no source wording beside
    // it — a label belongs to `mapped`, which additionally needs a ruleset and a
    // confidence at the floor. The real server refused the first version of
    // this fixture, which is the reason this file exists.
    conditionMappingState: input.condition === 'unknown' ? 'unmapped' : 'declared',
    customerEligibility: 'anyone',
    country: 'ES',
    observedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    lastConfirmedAt: now,
    staleAt: new Date(now.getTime() + 3_600_000),
  });
  return row.id;
}

/** The request every case starts from, with the offers half permitted. */
function pageRequest(handle: string, overrides: Record<string, unknown> = {}) {
  return {
    handle,
    comparisonCurrency: 'EUR' as const,
    limit: 20,
    offerComparisonPermitted: true,
    ...overrides,
  };
}

async function mintNativeBundleListing(label: string, canonicalVariantIds: readonly string[]) {
  const [listing] = await db.insert(listings).values({
    ownerType: 'user', oxyUserId: `bundle-owner-${RUN}`, title: label,
    description: 'Bundle fixture', condition: 'new', conditionAssertion: 'seller_declared', status: 'active',
  }).returning({ id: listings.id });
  createdListingIds.push(listing.id);
  const variants = await db.insert(productVariants).values(canonicalVariantIds.map((_, position) => ({
    listingId: listing.id, title: `Pack ${position}`, position, priceAmount: 1200, priceCurrency: 'EUR' as const,
  }))).returning({ id: productVariants.id, position: productVariants.position });
  variants.sort((a, b) => a.position - b.position);
  const links = await db.insert(nativeListingLinks).values(variants.map((variant, index) => ({
    listingId: listing.id, productVariantId: variant.id, canonicalVariantId: canonicalVariantIds[index],
    method: 'operator' as const, matchRule: 'bundle-fixture', decidedByOxyUserId: `operator-${RUN}`,
  }))).returning({ id: nativeListingLinks.id });
  return { listingId: listing.id, variantIds: variants.map(variant => variant.id), linkIds: links.map(link => link.id) };
}

describe('listing bundle contents', () => {
  it('recommends available same-seller packs for the exact component, with their own prices and action', async () => {
    const component = await mintProduct('recommend-component', 2);
    const singlePack = await mintProduct('recommend-single');
    const configurablePack = await mintProduct('recommend-configurable', 2);
    await db.insert(bundleComponents).values([
      { bundleVariantId: singlePack.variantIds[0], componentVariantId: component.variantIds[0], quantity: 2 },
      ...configurablePack.variantIds.map((id, index) => ({ bundleVariantId: id, componentVariantId: component.variantIds[index], quantity: 1 })),
    ]);
    const source = await mintNativeBundleListing('Recommendation source', component.variantIds);
    const single = await mintNativeBundleListing('Single pack', singlePack.variantIds);
    const configurable = await mintNativeBundleListing('Configurable pack', configurablePack.variantIds);
    const foreign = await mintNativeBundleListing('Other seller pack', singlePack.variantIds);
    await db.update(listings).set({ oxyUserId: `other-bundle-owner-${RUN}` }).where(eq(listings.id, foreign.listingId));
    await db.update(productVariants).set({ inventoryAvailable: 5 }).where(inArray(productVariants.id, [...single.variantIds, ...configurable.variantIds, ...foreign.variantIds]));
    await db.update(productVariants).set({ priceAmount: 900, compareAtPriceAmount: 1500, compareAtPriceCurrency: 'EUR' }).where(eq(productVariants.id, single.variantIds[0]));
    const read = () => readListingBundleRecommendations({ id: source.listingId, variants: source.variantIds.map(id => ({ id })) });
    const result = await read();
    expect(result[source.variantIds[0]]).toHaveLength(2);
    expect(result[source.variantIds[1]]).toHaveLength(1);
    expect(result[source.variantIds[0]]).toContainEqual(expect.objectContaining({
      listingId: single.listingId, variantId: single.variantIds[0], action: 'add_to_cart',
      price: { amount: 900, currency: 'EUR' }, compareAtPrice: { amount: 1500, currency: 'EUR' },
    }));
    expect(result[source.variantIds[1]][0]).toMatchObject({ listingId: configurable.listingId, variantId: configurable.variantIds[1], action: 'view_bundle' });
    expect(Object.values(result).flat().some(row => row.listingId === foreign.listingId)).toBe(false);
    await db.update(nativeListingLinks).set({ status: 'superseded' }).where(eq(nativeListingLinks.id, source.linkIds[0]));
    expect(Object.keys(await read())).toEqual([source.variantIds[1]]);
    await db.update(nativeListingLinks).set({ status: 'active' }).where(eq(nativeListingLinks.id, source.linkIds[0]));

    await db.update(productVariants).set({ inventoryAvailable: 0 }).where(eq(productVariants.id, single.variantIds[0]));
    expect((await read())[source.variantIds[0]]).toHaveLength(1);
    await db.update(productVariants).set({ inventoryAvailable: 5 }).where(eq(productVariants.id, single.variantIds[0]));
    await db.insert(listingConditionDetails).values({ listingId: single.listingId, kind: 'missing_accessory', note: 'One component missing' });
    expect((await read())[source.variantIds[0]]).toHaveLength(1);
    await db.update(canonicalVariants).set({ status: 'suppressed' }).where(eq(canonicalVariants.id, component.variantIds[0]));
    expect(Object.keys(await read())).toEqual([source.variantIds[1]]);
    await db.update(listings).set({ status: 'draft' }).where(eq(listings.id, configurable.listingId));
    expect(await read()).toEqual({});
  });

  it('maps exact configurations and drops revoked, superseded and foreign native attachments', async () => {
    const pack = await mintProduct('native-bundle', 2);
    const child = await mintProduct('native-bundle-child');
    await db.insert(bundleComponents).values(pack.variantIds.map((variantId, index) => ({
      bundleVariantId: variantId, componentVariantId: child.variantIds[0], quantity: index + 1,
    })));
    const native = await mintNativeBundleListing('Native bundle', pack.variantIds);
    const foreign = await mintNativeBundleListing('Foreign bundle', [pack.variantIds[0]]);
    // A denormalized listing id alone does not prove the native variant belongs to it.
    await db.update(nativeListingLinks).set({ listingId: native.listingId }).where(eq(nativeListingLinks.id, foreign.linkIds[0]));
    const read = () => readListingBundleContents(native.listingId, native.variantIds, []);
    const contents = await read();
    expect(Object.keys(contents)).toHaveLength(2);
    expect(contents[native.variantIds[0]]).toMatchObject({ variantId: pack.variantIds[0], components: [{ quantity: 1 }] });
    expect(contents[native.variantIds[1]]).toMatchObject({ variantId: pack.variantIds[1], components: [{ quantity: 2 }] });
    expect(contents[foreign.variantIds[0]]).toBeUndefined();
    expect(await readListingBundleContents(native.listingId, native.variantIds, [{ kind: 'missing_accessory' }]))
      .toEqual(Object.fromEntries(native.variantIds.map((id, index) => [id, { status: 'withheld', variantId: pack.variantIds[index] }])));
    await revokeNativeListingLink(db, { id: native.linkIds[0], revokedByOxyUserId: `operator-${RUN}`, reason: 'fixture' });
    expect(Object.keys(await read())).toEqual([native.variantIds[1]]);
    await db.update(nativeListingLinks).set({ status: 'superseded' }).where(eq(nativeListingLinks.id, native.linkIds[1]));
    expect(await read()).toEqual({});
  });

  it('hides unpublished parents and withholds the pack when a component is hidden', async () => {
    const pack = await mintProduct('native-hidden-pack');
    const child = await mintProduct('native-hidden-child');
    await db.insert(bundleComponents).values({ bundleVariantId: pack.variantIds[0], componentVariantId: child.variantIds[0], quantity: 1 });
    const native = await mintNativeBundleListing('Hidden pack', pack.variantIds);
    const read = () => readListingBundleContents(native.listingId, native.variantIds, []);
    expect(Object.keys(await read())).toHaveLength(1);
    await db.update(canonicalVariants).set({ status: 'draft' }).where(eq(canonicalVariants.id, pack.variantIds[0]));
    expect(await read()).toEqual({});
    await db.update(canonicalVariants).set({ status: 'active' }).where(eq(canonicalVariants.id, pack.variantIds[0]));
    await db.update(canonicalProducts).set({ status: 'suppressed' }).where(eq(canonicalProducts.id, pack.productId));
    expect(await read()).toEqual({});
    await db.update(canonicalProducts).set({ status: 'active' }).where(eq(canonicalProducts.id, pack.productId));
    await db.update(canonicalVariants).set({ status: 'suppressed' }).where(eq(canonicalVariants.id, child.variantIds[0]));
    expect(await read()).toEqual({ [native.variantIds[0]]: { status: 'withheld', variantId: pack.variantIds[0] } });
  });
});

describe('public bundle contents', () => {
  it('uses the exact configuration, quantities and catalog order without exposing another pack', async () => {
    const pack = await mintProduct('bundle-configurations', 2);
    const first = await mintProduct('bundle-first');
    const second = await mintProduct('bundle-second');
    await db.insert(bundleComponents).values([
      { bundleVariantId: pack.variantIds[0], componentVariantId: first.variantIds[0], quantity: 2, position: 1 },
      { bundleVariantId: pack.variantIds[0], componentVariantId: second.variantIds[0], quantity: 1, position: 0 },
      { bundleVariantId: pack.variantIds[1], componentVariantId: second.variantIds[0], quantity: 3, position: 0 },
    ]);
    const request = (canonicalVariantId?: string) => readCanonicalProductPage(pageRequest(pack.slug, { canonicalVariantId, offerComparisonPermitted: false }));
    expect((await request())?.page.bundleContents).toBeUndefined();
    expect((await request(pack.variantIds[0]))?.page.bundleContents).toMatchObject({
      status: 'available', variantId: pack.variantIds[0], components: [
        { productId: second.productId, productSlug: second.slug, variantId: second.variantIds[0], quantity: 1 },
        { productId: first.productId, productSlug: first.slug, variantId: first.variantIds[0], quantity: 2 },
      ],
    });
    expect((await request(pack.variantIds[1]))?.page.bundleContents).toMatchObject({
      status: 'available', components: [{ variantId: second.variantIds[0], quantity: 3 }],
    });
  });

  it('withholds the entire composition for hidden children, and restores it immediately on lifting', async () => {
    const pack = await mintProduct('bundle-visibility');
    const child = await mintProduct('bundle-hidden');
    await db.insert(bundleComponents).values({ bundleVariantId: pack.variantIds[0], componentVariantId: child.variantIds[0], quantity: 1 });
    const read = async () => (await readCanonicalProductPage(pageRequest(pack.slug, { offerComparisonPermitted: false })))?.page.bundleContents;
    for (const status of ['draft', 'suppressed'] as const) {
      await db.update(canonicalVariants).set({ status }).where(eq(canonicalVariants.id, child.variantIds[0]));
      expect(await read()).toEqual({ status: 'withheld', variantId: pack.variantIds[0] });
    }
    await db.update(canonicalVariants).set({ status: 'discontinued' }).where(eq(canonicalVariants.id, child.variantIds[0]));
    expect(await read()).toMatchObject({ status: 'available' });
    await db.update(canonicalProducts).set({ status: 'suppressed' }).where(eq(canonicalProducts.id, child.productId));
    expect(await read()).toEqual({ status: 'withheld', variantId: pack.variantIds[0] });
    await db.update(canonicalProducts).set({ status: 'active' }).where(eq(canonicalProducts.id, child.productId));
    expect(await read()).toMatchObject({ status: 'available' });
  });

  it('prefers the active variant image and falls back to an active product image', async () => {
    const pack = await mintProduct('bundle-images');
    const child = await mintProduct('bundle-image-child');
    const source = await mintObservation('bundle-image-source');
    await db.insert(bundleComponents).values({ bundleVariantId: pack.variantIds[0], componentVariantId: child.variantIds[0], quantity: 1 });
    await db.insert(canonicalImages).values([
      { productId: child.productId, sourceRecordId: source.recordId, sourceUrl: 'https://example.com/product.png', position: 0 },
      { variantId: child.variantIds[0], sourceRecordId: source.recordId, sourceUrl: 'https://example.com/variant.png', position: 2 },
    ]);
    const read = async () => (await readCanonicalProductPage(pageRequest(pack.slug, { offerComparisonPermitted: false })))?.page.bundleContents;
    expect(await read()).toMatchObject({ status: 'available', components: [{ image: { sourceUrl: 'https://example.com/variant.png' } }] });
    await db.delete(canonicalImages).where(eq(canonicalImages.variantId, child.variantIds[0]));
    expect(await read()).toMatchObject({ status: 'available', components: [{ image: { sourceUrl: 'https://example.com/product.png' } }] });
  });

  it('adds no bundle section to an ordinary single item', async () => {
    const product = await mintProduct('not-a-bundle');
    const result = await readCanonicalProductPage(pageRequest(product.slug, { offerComparisonPermitted: false }));
    expect(result?.page.bundleContents).toBeUndefined();
  });
});

describe('the composed read (#71 route rules 3 and 5)', () => {
  it('serves identity, configurations, ranked rows, sellers and a partition in ONE read', async () => {
    const product = await mintProduct('compose', 2);
    const first = await mintMerchant('compose-a');
    const second = await mintMerchant('compose-b');

    const newOfferId = await seedExternalOffer({
      label: 'compose-new',
      variantId: product.variantIds[0] ?? '',
      merchantId: first.merchantId,
      storefrontId: first.storefrontId,
      condition: 'new',
      priceMinor: 129_900,
      deliveryMinor: 0,
    });
    const usedOfferId = await seedExternalOffer({
      label: 'compose-used',
      variantId: product.variantIds[1] ?? '',
      merchantId: second.merchantId,
      storefrontId: second.storefrontId,
      condition: 'used_good',
      priceMinor: 79_900,
    });
    const unknownOfferId = await seedExternalOffer({
      label: 'compose-unknown',
      variantId: product.variantIds[0] ?? '',
      merchantId: second.merchantId,
      storefrontId: second.storefrontId,
      condition: 'unknown',
      priceMinor: 99_900,
    });

    const result = await readCanonicalProductPage(pageRequest(product.slug));
    expect(result, 'the page did not resolve').toBeDefined();
    const page = result?.page;
    if (page === undefined) throw new Error('unreachable — asserted above');

    expect(page.product.id).toBe(product.productId);
    expect(page.redirect).toBeUndefined();
    expect(page.variants).toHaveLength(2);
    expect(page.offers.available).toBe(true);
    if (page.offers.available !== true) throw new Error('unreachable — asserted above');

    // Every ranked entry has a ROW. This is the property the composition exists
    // for: a client joining two endpoints would drop whichever ranked offer fell
    // outside the other's window, and the symptom is a hole nobody reports.
    const servedIds = page.offers.rows.map((row) => row.offer.id);
    expect(servedIds).toContain(newOfferId);
    expect(servedIds).toContain(usedOfferId);
    expect(servedIds).toContain(unknownOfferId);
    for (const row of page.offers.rows) {
      expect(row.ranked.offerId).toBe(row.offer.id);
      expect(row.seller.kind).toBe('merchant');
      if (row.seller.kind !== 'merchant') throw new Error('unreachable');
      expect(row.seller.name).toContain(RUN);
      expect(row.seller.storefront?.name).toContain(RUN);
      // Every external row's action is refused, and no branch carries a URL.
      expect(row.outbound.kind).toBe('unavailable');
      expect(JSON.stringify(row.outbound)).not.toContain('https://');
    }

    // The partition: three offers, three groups, nobody twice.
    const placements = page.offers.groups.flatMap((group) => group.offerIds);
    expect(placements.slice().sort()).toEqual([newOfferId, usedOfferId, unknownOfferId].sort());
    expect(new Set(placements).size).toBe(3);
    const groupOf = (offerId: string) =>
      page.offers.available === true
        ? page.offers.groups.find((group) => group.offerIds.includes(offerId))?.key
        : undefined;
    expect(groupOf(newOfferId)).toBe('new_retail');
    expect(groupOf(usedOfferId)).toBe('used');
    // The one that matters: an unstated condition is its OWN group and is never
    // folded into the new one.
    expect(groupOf(unknownOfferId)).toBe('condition_unknown');

    // A product-scoped page names each row's configuration (#71 acceptance 4).
    for (const row of page.offers.rows) {
      expect(row.variantName, 'a product-scoped row must name its configuration').toBeDefined();
    }

    // The highlights point at rows that are present, and carry #74's awards.
    for (const highlight of page.offers.highlights) {
      expect(servedIds).toContain(highlight.offerId);
      expect(highlight.award.reason).toBeDefined();
    }
  });

  it('scopes the comparison to ONE configuration, and refuses another product\'s', async () => {
    const product = await mintProduct('scope', 2);
    const other = await mintProduct('scope-other', 1);
    const merchant = await mintMerchant('scope');

    const firstVariantOffer = await seedExternalOffer({
      label: 'scope-first',
      variantId: product.variantIds[0] ?? '',
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
      condition: 'new',
      priceMinor: 50_000,
    });
    await seedExternalOffer({
      label: 'scope-second',
      variantId: product.variantIds[1] ?? '',
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
      condition: 'new',
      priceMinor: 60_000,
    });

    const scoped = await readCanonicalProductPage(
      pageRequest(product.slug, { canonicalVariantId: product.variantIds[0] }),
    );
    const offers = scoped?.page.offers;
    if (offers === undefined || offers.available !== true) {
      throw new Error('the scoped page did not serve offers');
    }
    // Acceptance 4, structurally: the comparison was SCOPED, so another
    // configuration's offer is not filtered out — it was never fetched.
    expect(offers.rows.map((row) => row.offer.id)).toEqual([firstVariantOffer]);
    expect(scoped?.page.selectedVariantId).toBe(product.variantIds[0]);
    for (const row of offers.rows) {
      expect(row.variantName, 'a variant-scoped row repeats no configuration').toBeUndefined();
    }

    // A configuration belonging to a DIFFERENT product is refused rather than
    // ignored: ignoring it would silently widen the page to every offer.
    await expect(
      readCanonicalProductPage(
        pageRequest(product.slug, { canonicalVariantId: other.variantIds[0] }),
      ),
    ).rejects.toThrow(/configuration does not belong/iu);
  });

  it('serves an honest page for a product with no eligible offer', async () => {
    const product = await mintProduct('empty');
    const result = await readCanonicalProductPage(pageRequest(product.slug));
    const offers = result?.page.offers;
    if (offers === undefined || offers.available !== true) {
      throw new Error('the page did not serve the offers half');
    }
    expect(offers.rows).toEqual([]);
    expect(offers.groups).toEqual([]);
    // Zero excluded is what makes "nobody sells this" different from "we know of
    // offers and none is eligible" — the client says different things.
    expect(offers.excludedCount).toBe(0);
    expect(result?.page.product.name).toContain(RUN);
  });

  it('withholds the offers half without pretending the product has none', async () => {
    const product = await mintProduct('withheld');
    const merchant = await mintMerchant('withheld');
    await seedExternalOffer({
      label: 'withheld',
      variantId: product.variantIds[0] ?? '',
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
      condition: 'new',
      priceMinor: 10_000,
    });

    const result = await readCanonicalProductPage(
      pageRequest(product.slug, { offerComparisonPermitted: false }),
    );
    expect(result?.page.product.id).toBe(product.productId);
    expect(result?.page.offers.available).toBe(false);
    if (result?.page.offers.available !== false) throw new Error('unreachable');
    expect(result.page.offers.reason).toBe('comparison_withheld');
    // The withheld branch has no rows to read at all — the shape is what stops
    // a renderer saying "no offers" about a lever somebody turned off.
    expect('rows' in result.page.offers).toBe(false);
    // And the same rule one level down: a count of ZERO beside every
    // configuration would answer the offers question this page is refusing to
    // answer, so there is no count at all.
    for (const variant of result.page.variants) {
      expect(variant.offerCount).toBeUndefined();
    }
  });
});

describe('merge tombstones resolve, and the page SAYS so (#71 route rule 2)', () => {
  it('answers an old handle with the winner and states the canonical one', async () => {
    const winner = await mintProduct('merge-winner');
    const loser = await mintProduct('merge-loser');
    await db
      .update(canonicalProducts)
      .set({ status: 'merged', mergedIntoId: winner.productId })
      .where(eq(canonicalProducts.id, loser.productId));

    const result = await readCanonicalProductPage(pageRequest(loser.slug));
    expect(result?.page.product.id).toBe(winner.productId);
    expect(result?.page.redirect).toEqual({
      requestedHandle: loser.slug,
      canonicalHandle: winner.slug,
      canonicalProductId: winner.productId,
    });

    // The winner's OWN handle carries no redirect — a page that always reported
    // one would make the client replace the URL on every read.
    const direct = await readCanonicalProductPage(pageRequest(winner.slug));
    expect(direct?.page.redirect).toBeUndefined();
  });

  it('answers an unknown handle with nothing, so the caller can 404', async () => {
    expect(await readCanonicalProductPage(pageRequest(`missing-${RUN}`))).toBeUndefined();
  });
});

describe('seller identity spans two identity systems', () => {
  it('resolves a native listing to its STORE, and a P2P listing to its person', async () => {
    const [store] = await db
      .insert(stores)
      .values({
        oxyAccountId: 'oxy-account-fixture',
        handle: `store-${RUN}`,
        name: `Store ${RUN}`,
        description: 'A fixture store',
        brandColor: '#101010',
      })
      .returning({ id: stores.id });
    if (!store) throw new Error('the store was not written');
    createdStoreIds.push(store.id);

    const [storeListing] = await db
      .insert(listings)
      .values({
        ownerType: 'store',
        storeId: store.id,
        title: `Store listing ${RUN}`,
        description: 'A fixture listing',
        condition: 'new',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning({ id: listings.id });
    if (!storeListing) throw new Error('the store listing was not written');
    createdListingIds.push(storeListing.id);

    const [personListing] = await db
      .insert(listings)
      .values({
        ownerType: 'user',
        oxyUserId: `person-${RUN}`,
        title: `Person listing ${RUN}`,
        description: 'A fixture listing',
        condition: 'used_good',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning({ id: listings.id });
    if (!personListing) throw new Error('the person listing was not written');
    createdListingIds.push(personListing.id);

    // Hand-built offers rather than seeded rows: the unit under test is the
    // seller RESOLUTION, and a native offer only survives eligibility with a
    // payment-ready seller, which is a different domain's fixture stack.
    const sellers = await resolveOfferSellers(
      [
        {
          id: 'offer-store',
          kind: 'native',
          status: 'active',
          canonicalVariantId: 'variant',
          listingId: storeListing.id,
          sellerRole: 'unknown',
          availability: 'in_stock',
          condition: { key: 'new', group: 'new', mappingState: 'declared' },
          customerEligibility: 'unknown',
          delivery: { known: false, pickup: 'unknown' },
          provenance: {},
          freshness: {
            level: 'unknown',
            observedAt: new Date().toISOString(),
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            ageSeconds: 0,
            checkedAgeSeconds: 0,
            reason: 'source_missing',
          },
          qualitySignals: [],
          checkout: { eligible: false, reasons: ['seller_not_payment_ready'] },
        },
        {
          id: 'offer-person',
          kind: 'native',
          status: 'active',
          canonicalVariantId: 'variant',
          listingId: personListing.id,
          sellerRole: 'unknown',
          availability: 'in_stock',
          condition: { key: 'used_good', group: 'used', mappingState: 'declared' },
          customerEligibility: 'unknown',
          delivery: { known: false, pickup: 'unknown' },
          provenance: {},
          freshness: {
            level: 'unknown',
            observedAt: new Date().toISOString(),
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            ageSeconds: 0,
            checkedAgeSeconds: 0,
            reason: 'source_missing',
          },
          qualitySignals: [],
          checkout: { eligible: false, reasons: ['seller_not_payment_ready'] },
        },
      ],
      db,
    );

    const storeSeller = sellers.get('offer-store');
    expect(storeSeller?.kind).toBe('native_store');
    if (storeSeller?.kind !== 'native_store') throw new Error('unreachable');
    expect(storeSeller.handle).toBe(`store-${RUN}`);

    const personSeller = sellers.get('offer-person');
    // The Oxy profile does not resolve in a test environment, and the fallback
    // is the account id rather than a missing row: a seller with an unreachable
    // profile still has a page, and a row that rendered nothing would drop a
    // real offer from the comparison.
    expect(personSeller?.kind).toBe('native_person');
    if (personSeller?.kind !== 'native_person') throw new Error('unreachable');
    expect(personSeller.oxyUserId).toBe(`person-${RUN}`);
    expect(personSeller.displayName.length).toBeGreaterThan(0);
  });

  it('counts ACTIVE native listings for the shadow comparison, and zero for none', async () => {
    const product = await mintProduct('shadow');
    // The listing-first half reads ATTACHMENTS, not offers — a product with no
    // attachment counts zero however many external offers it carries, which is
    // what makes the two halves of the comparison independent.
    expect(
      await countActiveNativeListingsForCanonicalVariants(db, product.variantIds),
    ).toBe(0);
    expect(await countActiveNativeListingsForCanonicalVariants(db, [])).toBe(0);
  });
});
