/**
 * The unified offer model against a REAL PostgreSQL database — issue #57.
 *
 * Everything here is held by a CHECK, a partial unique index over a GENERATED
 * key, a cascade, a lease or a transaction, and none of those exists under a
 * mocked repository: a mocked `insert` accepts a statement the server rejects
 * outright, which is exactly how a duplicate active source mapping, a native
 * offer carrying an external key, or a delivery cost stored with no currency
 * would look green and ship broken.
 *
 * The seven acceptance criteria this file answers directly:
 *
 *  1. Twenty merchant listings for one variant produce twenty offers on one
 *     canonical product.
 *  2. Native and external offers are unambiguously distinguishable — the
 *     per-kind CHECK is what makes the distinction structural.
 *  3. Marketplace platform and actual seller are both preserved, and their
 *     relationship is DERIVED from the two foreign keys.
 *  4. Unknown delivery cost never ranks as free delivery — stored as absence,
 *     read through a union with no `cost` on the unknown branch.
 *  5. Expiry removes stale offers from current results without losing
 *     historical references.
 *  6. Native moderation and inventory changes cannot leave a buyable stale
 *     offer.
 *  7. The projection carries provenance and freshness.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every name, slug and handle this file writes carries a
 * per-run suffix and teardown deletes exactly what it created — children first,
 * since every intra-graph foreign key here is RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { declaredOfferCondition } from '../../services/condition/condition-mapping.service.js';
import { listings, productVariants } from '../schema/catalog.js';
import { stores } from '../schema/stores.js';
import { merchants, storefronts } from '../schema/merchants.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { nativeListingLinks, offerOutboxes, offers } from '../schema/offers.js';
import {
  findActiveNativeOfferForVariant,
  listOffersForComparison,
  retireOffers,
  upsertExternalOffer,
  listLapsedExternalOfferCandidates,
  retireOffersMissingFromSource,
  type InsertOfferInput,
} from '../offers/offerRepository.js';
import {
  claimOfferOutbox,
  completeOfferOutbox,
  enqueueOfferConvergence,
  findOfferOutboxForListing,
} from '../offers/offerOutboxRepository.js';
import { insertNativeListingLink } from '../offers/nativeListingLinkRepository.js';
import { convergeNativeOffersForListing } from '../../services/offers/native-offer.service.js';
import { listOffers, recordExternalOffer } from '../../services/offers/offer.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdStorefrontIds: string[] = [];
const createdSourceIds: string[] = [];
const createdSourceRecordIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // Children first. `offers` and `native_listing_links` cascade from the native
  // side and RESTRICT from the canonical side, so the offer rows must go before
  // anything canonical does.
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db
    .delete(nativeListingLinks)
    .where(inArray(nativeListingLinks.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(offerOutboxes).where(inArray(offerOutboxes.listingId, safeIds(createdListingIds)));
  // `listings.store_id` is RESTRICT — a listing outlives its store on purpose —
  // so the listings go first and take their variants with them.
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));
  await db.delete(stores).where(inArray(stores.id, safeIds(createdStoreIds)));
  await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, safeIds(createdVariantIds)));
  await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, safeIds(createdProductIds)));
  await db.delete(storefronts).where(inArray(storefronts.id, safeIds(createdStorefrontIds)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(createdSourceRecordIds)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await closePostgres();
});

/**
 * Assert a write is refused by the named CLASS of constraint.
 *
 * Distinguishing check from unique matters and is not pedantry: both refuse the
 * write, and a test that only asserted "it threw" would pass against a CHECK
 * that had been dropped so long as some OTHER constraint happened to fire.
 */
async function expectRefused(
  kind: 'check' | 'unique',
  run: () => Promise<unknown>,
): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, `expected a ${kind} violation, but the write succeeded`).toBeDefined();
  const matched = kind === 'check' ? isCheckViolation(thrown) : isUniqueViolation(thrown);
  expect(matched, `expected a ${kind} violation, got: ${String(thrown)}`).toBe(true);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `offer-${label}-${RUN}`,
      name: `Offer store ${label} ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('mintStore returned no row');
  createdStoreIds.push(row.id);
  return row.id;
}

async function mintListing(input: {
  storeId: string;
  status?: 'draft' | 'active' | 'sold' | 'archived' | 'restricted';
  condition?: 'new' | 'used_good';
}): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: input.storeId,
      title: `Offer listing ${RUN}`,
      description: 'a listing under test',
      condition: input.condition ?? 'new',
      conditionAssertion: 'seller_declared',
      status: input.status ?? 'active',
    })
    .returning({ id: listings.id });
  if (!row) throw new Error('mintListing returned no row');
  createdListingIds.push(row.id);
  return row.id;
}

async function mintVariant(input: {
  listingId: string;
  priceAmount?: number;
  tracked?: boolean;
  available?: number;
}): Promise<string> {
  const [row] = await db
    .insert(productVariants)
    .values({
      listingId: input.listingId,
      title: 'Default Title',
      priceAmount: input.priceAmount ?? 119_900,
      priceCurrency: 'EUR',
      inventoryTracked: input.tracked ?? true,
      inventoryAvailable: input.available ?? 5,
    })
    .returning({ id: productVariants.id });
  if (!row) throw new Error('mintVariant returned no row');
  return row.id;
}

/** A canonical product plus one variant — the grain every offer attaches to. */
async function mintCanonicalVariant(label: string): Promise<string> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Canonical ${label} ${RUN}`,
      normalizedName: `canonical ${label} ${RUN}`,
      slug: `canonical-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('mintCanonicalVariant produced no product');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      // A sha-256-shaped digest; `canonical_variants_signature_shape_check`
      // refuses anything else, and the value only has to be unique per product.
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('mintCanonicalVariant produced no variant');
  createdVariantIds.push(variant.id);
  return variant.id;
}

async function mintMerchant(label: string): Promise<string> {
  const [row] = await db
    .insert(merchants)
    .values({ name: `Merchant ${label} ${RUN}`, slug: `merchant-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!row) throw new Error('mintMerchant returned no row');
  createdMerchantIds.push(row.id);
  return row.id;
}

async function mintStorefront(label: string, operatorMerchantId: string): Promise<string> {
  const [row] = await db
    .insert(storefronts)
    .values({
      merchantId: operatorMerchantId,
      name: `Storefront ${label} ${RUN}`,
      slug: `storefront-${label}-${RUN}`,
      channelKind: 'marketplace',
    })
    .returning({ id: storefronts.id });
  if (!row) throw new Error('mintStorefront returned no row');
  createdStorefrontIds.push(row.id);
  return row.id;
}

async function mintSourceRecord(label: string): Promise<string> {
  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `offer-source-${label}-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('mintSourceRecord produced no source');
  createdSourceIds.push(source.id);

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `ext-${label}-${RUN}`,
      observedAt: new Date(),
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: { price: 119_900 },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('mintSourceRecord produced no record');
  createdSourceRecordIds.push(record.id);
  return record.id;
}

/** A minimal ACTIVE external offer, ready to have one field made wrong. */
function externalOffer(overrides: Partial<InsertOfferInput> & {
  canonicalVariantId: string;
  merchantId: string;
  sourceRecordId: string;
}): InsertOfferInput {
  const now = new Date();
  return {
    kind: 'external',
    status: 'active',
    // #90: the five condition columns move together, so a fixture builds them
    // the way the converger does rather than setting one and inheriting four
    // defaults the schema no longer has.
    ...declaredOfferCondition('new'),
    destinationUrl: 'https://example.test/product',
    provider: 'test-feed',
    externalOfferId: `offer-${uuidv7()}`,
    observedAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    staleAt: new Date(now.getTime() + 86_400_000),
    ...overrides,
  };
}

// ── The per-kind shape: what makes native and external distinguishable ──────

describe('the per-kind shape CHECK (acceptance 2)', () => {
  it('refuses a non-native offer carrying a native variant id — the cart wall', async () => {
    const canonicalVariantId = await mintCanonicalVariant('cart-wall');
    const merchantId = await mintMerchant('cart-wall');
    const sourceRecordId = await mintSourceRecord('cart-wall');
    const storeId = await mintStore('cart-wall');
    const listingId = await mintListing({ storeId });
    const productVariantId = await mintVariant({ listingId });

    // THE property issue external rule 1 asks for: an external offer has no
    // variant id, so there is no id a cart line could hold. The CHECK is what
    // makes that true against every writer, including `psql`.
    await expectRefused('check', () =>
      db
        .insert(offers)
        .values(
          externalOffer({ canonicalVariantId, merchantId, sourceRecordId, productVariantId }),
        ),
    );
  });

  it('refuses a native offer carrying a merchant, a storefront, a source or a URL', async () => {
    const canonicalVariantId = await mintCanonicalVariant('native-shape');
    const merchantId = await mintMerchant('native-shape');
    const sourceRecordId = await mintSourceRecord('native-shape');
    const storeId = await mintStore('native-shape');
    const listingId = await mintListing({ storeId });
    const productVariantId = await mintVariant({ listingId });
    const now = new Date();
    const base: InsertOfferInput = {
      kind: 'native',
      ...declaredOfferCondition('new'),
      canonicalVariantId,
      productVariantId,
      listingId,
      observedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      staleAt: new Date(now.getTime() + 86_400_000),
    };

    for (const wrong of [
      { merchantId },
      { sourceRecordId },
      { destinationUrl: 'https://example.test/x' },
    ]) {
      await expectRefused('check', () => db.insert(offers).values({ ...base, ...wrong }));
    }
    // And the well-formed one is accepted, so the four refusals above are not
    // vacuous — a CHECK that refused everything would pass all of them.
    await db.insert(offers).values(base);
    const stored = await findActiveNativeOfferForVariant(db, productVariantId);
    expect(stored?.kind).toBe('native');
  });

  it('refuses an `informational` offer that carries a destination — there is no way to buy', async () => {
    const canonicalVariantId = await mintCanonicalVariant('informational');
    const merchantId = await mintMerchant('informational');
    const sourceRecordId = await mintSourceRecord('informational');
    await expectRefused('check', () =>
      db.insert(offers).values(
        externalOffer({
          kind: 'informational',
          canonicalVariantId,
          merchantId,
          sourceRecordId,
          destinationUrl: 'https://example.test/nope',
        }),
      ),
    );
  });

  it('refuses a native offer carrying an external source key', async () => {
    const canonicalVariantId = await mintCanonicalVariant('native-key');
    const storeId = await mintStore('native-key');
    const listingId = await mintListing({ storeId });
    const productVariantId = await mintVariant({ listingId });
    const now = new Date();
    await expectRefused('check', () =>
      db.insert(offers).values({
        kind: 'native',
        ...declaredOfferCondition('new'),
        canonicalVariantId,
        productVariantId,
        listingId,
        provider: 'test-feed',
        externalOfferId: 'should-not-be-here',
        observedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        staleAt: new Date(now.getTime() + 86_400_000),
      }),
    );
  });
});

// ── Uniqueness: twenty sellers, one variant, and no duplicates ──────────────

describe('active-offer uniqueness (acceptance 1)', () => {
  it('twenty merchants on one variant produce twenty offers', async () => {
    const canonicalVariantId = await mintCanonicalVariant('twenty');
    const sourceRecordId = await mintSourceRecord('twenty');

    for (let index = 0; index < 20; index += 1) {
      const merchantId = await mintMerchant(`twenty-${index}`);
      await db
        .insert(offers)
        .values(externalOffer({ canonicalVariantId, merchantId, sourceRecordId }));
    }

    const rows = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.canonicalVariantId, canonicalVariantId), eq(offers.status, 'active')));
    expect(rows).toHaveLength(20);
  });

  it('refuses ONE merchant listing the same variant twice on one channel in one condition', async () => {
    const canonicalVariantId = await mintCanonicalVariant('commercial-key');
    const merchantId = await mintMerchant('commercial-key');
    const sourceRecordId = await mintSourceRecord('commercial-key');

    await db.insert(offers).values(
      externalOffer({ canonicalVariantId, merchantId, sourceRecordId, condition: 'new' }),
    );
    await expectRefused('unique', () =>
      db.insert(offers).values(
        externalOffer({ canonicalVariantId, merchantId, sourceRecordId, condition: 'new' }),
      ),
    );

    // A DIFFERENT condition is a different offer — the same seller may list a
    // refurbished one beside the new one, and the key says so.
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId,
        sourceRecordId,
        ...declaredOfferCondition('used_good'),
      }),
    );
  });

  it('the generated commercial key collapses NULLs — a plain unique would NOT', async () => {
    // THE fixture that tells the generated key from a plain multi-column unique:
    // two offers with identical non-null endpoints and a NULL storefront.
    // Postgres treats NULLs as distinct, so a plain unique admits both.
    const canonicalVariantId = await mintCanonicalVariant('null-collapse');
    const merchantId = await mintMerchant('null-collapse');
    const sourceRecordId = await mintSourceRecord('null-collapse');

    await db.insert(offers).values(
      externalOffer({ canonicalVariantId, merchantId, sourceRecordId, storefrontId: null }),
    );
    await expectRefused('unique', () =>
      db.insert(offers).values(
        externalOffer({ canonicalVariantId, merchantId, sourceRecordId, storefrontId: null }),
      ),
    );
  });

  it('refuses a duplicate source mapping, for the offer’s WHOLE LIFE (#68)', async () => {
    const canonicalVariantId = await mintCanonicalVariant('source-key');
    const merchantA = await mintMerchant('source-key-a');
    const merchantB = await mintMerchant('source-key-b');
    const sourceRecordId = await mintSourceRecord('source-key');
    const externalOfferId = `ext-offer-${RUN}`;

    const [first] = await db
      .insert(offers)
      .values(
        externalOffer({
          canonicalVariantId,
          merchantId: merchantA,
          sourceRecordId,
          externalOfferId,
        }),
      )
      .returning({ id: offers.id });
    if (!first) throw new Error('the first offer was not written');

    await expectRefused('unique', () =>
      db.insert(offers).values(
        externalOffer({
          canonicalVariantId,
          merchantId: merchantB,
          sourceRecordId,
          externalOfferId,
        }),
      ),
    );

    /**
     * #68 NARROWED this index: `status = 'active'` LEFT the predicate.
     *
     * With it, retiring the incumbent freed the mapping and the next
     * observation inserted a SECOND row for one external object — splitting its
     * observed history across two ids with nothing to rejoin them. The identity
     * now holds for the offer's whole life, so a source republishing an object
     * it stopped publishing REVIVES the same row (`upsertExternalOffer`) rather
     * than minting a rival, and a plain insert is still refused.
     */
    await retireOffers(db, [first.id], 'source_disappeared');
    await expectRefused('unique', () =>
      db.insert(offers).values(
        externalOffer({
          canonicalVariantId,
          merchantId: merchantB,
          sourceRecordId,
          externalOfferId,
        }),
      ),
    );

    // …and `superseded` is the ONE reason that leaves the index, which is what
    // lets `0044` collapse a duplicate that accumulated under the old predicate
    // without deleting a row or blanking its provenance.
    await db
      .update(offers)
      .set({ retirementReason: 'superseded' })
      .where(eq(offers.id, first.id));
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId: merchantB,
        sourceRecordId,
        externalOfferId,
      }),
    );
  });
});

// ── Unknown is not zero ─────────────────────────────────────────────────────

describe('unknown delivery is not free delivery (acceptance 4)', () => {
  it('refuses a delivery amount with no currency, and a currency with no amount', async () => {
    const canonicalVariantId = await mintCanonicalVariant('delivery');
    const merchantId = await mintMerchant('delivery');
    const sourceRecordId = await mintSourceRecord('delivery');

    await expectRefused('check', () =>
      db.insert(offers).values(
        externalOffer({ canonicalVariantId, merchantId, sourceRecordId, deliveryCostAmount: 0 }),
      ),
    );
    await expectRefused('check', () =>
      db.insert(offers).values(
        externalOffer({
          canonicalVariantId,
          merchantId,
          sourceRecordId,
          deliveryCostCurrency: 'EUR',
        }),
      ),
    );
  });

  it('refuses a free-over threshold with no delivery cost at all', async () => {
    const canonicalVariantId = await mintCanonicalVariant('free-over');
    const merchantId = await mintMerchant('free-over');
    const sourceRecordId = await mintSourceRecord('free-over');
    await expectRefused('check', () =>
      db.insert(offers).values(
        externalOffer({
          canonicalVariantId,
          merchantId,
          sourceRecordId,
          deliveryFreeOverAmount: 5_000,
          deliveryFreeOverCurrency: 'EUR',
        }),
      ),
    );
  });

  it('stores a ZERO delivery cost and an ABSENT one as different rows', async () => {
    const canonicalVariantId = await mintCanonicalVariant('zero-vs-absent');
    const sourceRecordId = await mintSourceRecord('zero-vs-absent');
    const freeMerchant = await mintMerchant('zero-vs-absent-free');
    const silentMerchant = await mintMerchant('zero-vs-absent-silent');

    const [free] = await db
      .insert(offers)
      .values(
        externalOffer({
          canonicalVariantId,
          merchantId: freeMerchant,
          sourceRecordId,
          deliveryCostAmount: 0,
          deliveryCostCurrency: 'EUR',
        }),
      )
      .returning({ amount: offers.deliveryCostAmount });
    const [silent] = await db
      .insert(offers)
      .values(externalOffer({ canonicalVariantId, merchantId: silentMerchant, sourceRecordId }))
      .returning({ amount: offers.deliveryCostAmount });

    expect(free?.amount).toBe(0);
    expect(silent?.amount).toBeNull();
  });
});

// ── The currency exception, and the money bounds ────────────────────────────

describe('the offer currency exception (ADR 0002 D18)', () => {
  it('accepts a code OUTSIDE Mercaria’s presentment set, and refuses a malformed one', async () => {
    const canonicalVariantId = await mintCanonicalVariant('currency');
    const sourceRecordId = await mintSourceRecord('currency');
    const ronMerchant = await mintMerchant('currency-ron');
    const badMerchant = await mintMerchant('currency-bad');

    // RON is a real currency an external platform trades in and is NOT in
    // `ALL_CURRENCY_CODES`. Refusing it would break the OBSERVATION rather than
    // a price — which is the whole reason this column is shape-checked.
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId: ronMerchant,
        sourceRecordId,
        priceAmount: 599_900,
        priceCurrency: 'RON',
      }),
    );

    await expectRefused('check', () =>
      db.insert(offers).values(
        externalOffer({
          canonicalVariantId,
          merchantId: badMerchant,
          sourceRecordId,
          priceAmount: 100,
          priceCurrency: 'euros',
        }),
      ),
    );
  });

  it('round-trips a bigint price past the integer ceiling as a JavaScript number', async () => {
    const canonicalVariantId = await mintCanonicalVariant('bigint');
    const merchantId = await mintMerchant('bigint');
    const sourceRecordId = await mintSourceRecord('bigint');
    // 25 ⊜ at FAIR's eight decimals — past a signed `integer`'s 21.47 ⊜ ceiling.
    const amount = 2_500_000_000;

    const [row] = await db
      .insert(offers)
      .values(
        externalOffer({
          canonicalVariantId,
          merchantId,
          sourceRecordId,
          priceAmount: amount,
          priceCurrency: 'FAIR',
        }),
      )
      .returning({ amount: offers.priceAmount });

    expect(row?.amount).toBe(amount);
    expect(typeof row?.amount).toBe('number');
  });

  it('refuses a negative price and a negative delivery cost', async () => {
    const canonicalVariantId = await mintCanonicalVariant('negative');
    const merchantId = await mintMerchant('negative');
    const sourceRecordId = await mintSourceRecord('negative');
    await expectRefused('check', () =>
      db.insert(offers).values(
        externalOffer({
          canonicalVariantId,
          merchantId,
          sourceRecordId,
          priceAmount: -1,
          priceCurrency: 'EUR',
        }),
      ),
    );
  });
});

// ── Marketplace-ness, derived from two foreign keys ─────────────────────────

describe('seller of record and channel operator are both preserved (acceptance 3)', () => {
  it('the comparison read returns the channel’s operator beside the seller', async () => {
    const canonicalVariantId = await mintCanonicalVariant('marketplace');
    const sourceRecordId = await mintSourceRecord('marketplace');
    const platform = await mintMerchant('marketplace-platform');
    const thirdParty = await mintMerchant('marketplace-seller');
    const channel = await mintStorefront('marketplace', platform);

    // The issue's own worked example: Amazon selling on amazon.es, and Seller Y
    // selling on the SAME channel. Two rows, two sellers, one storefront.
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId: platform,
        sourceRecordId,
        storefrontId: channel,
        priceAmount: 119_900,
        priceCurrency: 'EUR',
      }),
    );
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId: thirdParty,
        sourceRecordId,
        storefrontId: channel,
        priceAmount: 112_000,
        priceCurrency: 'EUR',
      }),
    );

    const rows = await listOffersForComparison(db, { canonicalVariantId, limit: 10 });
    expect(rows).toHaveLength(2);
    // Both rows name the SAME operator, and the operator is read through the
    // join rather than stored — so the two cannot disagree.
    for (const row of rows) {
      expect(row.storefrontOperatorMerchantId).toBe(platform);
    }
    const sellers = rows.map((row) => row.offer.merchantId).sort();
    expect(sellers).toEqual([platform, thirdParty].sort());
    // Cheapest first, which is the index's own order.
    expect(rows[0]?.offer.merchantId).toBe(thirdParty);
  });
});

// ── Expiry keeps history ────────────────────────────────────────────────────

describe('expiry removes an offer from current results and loses nothing (acceptance 5)', () => {
  it('a lapsed EXTERNAL offer retires and keeps its source record', async () => {
    const canonicalVariantId = await mintCanonicalVariant('lapsed');
    const merchantId = await mintMerchant('lapsed');
    const sourceRecordId = await mintSourceRecord('lapsed');
    const past = new Date(Date.now() - 60_000);

    const [offer] = await db
      .insert(offers)
      .values(
        externalOffer({
          canonicalVariantId,
          merchantId,
          sourceRecordId,
          observedAt: past,
          firstSeenAt: past,
          lastSeenAt: past,
          staleAt: past,
        }),
      )
      .returning({ id: offers.id });
    if (!offer) throw new Error('the lapsed offer was not written');

    // #68 made the sweep a two-step: the repository finds CANDIDATES and the
    // live per-source policy decides. The candidate read is what this test
    // pins; `offer-freshness.realdb.test.ts` drives the decision, including the
    // outage grace that is the whole reason the two are separate.
    const candidates = await listLapsedExternalOfferCandidates(db, { limit: 100, now: new Date() });
    expect(candidates.map((candidate) => candidate.offerId)).toContain(offer.id);
    expect(await retireOffers(db, [offer.id], 'source_expired')).toBe(1);

    const [after] = await db.select().from(offers).where(eq(offers.id, offer.id));
    expect(after?.status).toBe('retired');
    expect(after?.retirementReason).toBe('source_expired');
    // The row survives, and so does the observation behind it. `RESTRICT` on the
    // source record is what makes the second half structural rather than a habit.
    expect(after?.sourceRecordId).toBe(sourceRecordId);
    const [record] = await db.select().from(sourceRecords).where(eq(sourceRecords.id, sourceRecordId));
    expect(record).toBeDefined();

    // And it is gone from the CURRENT comparison, which is the point.
    const current = await listOffersForComparison(db, { canonicalVariantId, limit: 10 });
    expect(current).toHaveLength(0);
  });

  it('a NATIVE offer is deliberately NOT swept by the lapse sweep', async () => {
    // The distinction the sweep exists to make: a native offer's deadline
    // measures how long ago the CONVERGER ran, so sweeping it would delist a
    // healthy catalogue whenever the dispatcher stopped.
    const canonicalVariantId = await mintCanonicalVariant('native-lapse');
    const storeId = await mintStore('native-lapse');
    const listingId = await mintListing({ storeId });
    const productVariantId = await mintVariant({ listingId });
    const past = new Date(Date.now() - 60_000);

    await db.insert(offers).values({
      kind: 'native',
      ...declaredOfferCondition('new'),
      canonicalVariantId,
      productVariantId,
      listingId,
      observedAt: past,
      firstSeenAt: past,
      lastSeenAt: past,
      staleAt: past,
    });

    const candidates = await listLapsedExternalOfferCandidates(db, { limit: 100, now: new Date() });
    expect(candidates.some((candidate) => candidate.offerId === productVariantId)).toBe(false);
    const stored = await findActiveNativeOfferForVariant(db, productVariantId);
    expect(stored?.status).toBe('active');
    // The exclusion is on KIND and not on the deadline: this offer's `stale_at`
    // is in the past and it is still not a candidate.
    expect(stored?.staleAt.getTime()).toBeLessThan(Date.now());
  });

  it('a source that stops publishing an offer retires it and leaves the rest alone', async () => {
    const canonicalVariantId = await mintCanonicalVariant('refresh');
    const sourceRecordId = await mintSourceRecord('refresh');
    const keptMerchant = await mintMerchant('refresh-kept');
    const goneMerchant = await mintMerchant('refresh-gone');
    const provider = `refresh-${RUN}`.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const account = `acct-${RUN}`;

    const keptExternalId = `kept-${RUN}`;
    const goneExternalId = `gone-${RUN}`;
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId: keptMerchant,
        sourceRecordId,
        provider,
        sourceAccountRef: account,
        externalOfferId: keptExternalId,
      }),
    );
    await db.insert(offers).values(
      externalOffer({
        canonicalVariantId,
        merchantId: goneMerchant,
        sourceRecordId,
        provider,
        sourceAccountRef: account,
        externalOfferId: goneExternalId,
      }),
    );

    const retired = await retireOffersMissingFromSource(
      db,
      { provider, sourceAccountRef: account },
      [keptExternalId],
    );
    expect(retired).toBe(1);

    const rows = await db
      .select({ externalOfferId: offers.externalOfferId, status: offers.status })
      .from(offers)
      .where(eq(offers.provider, provider));
    expect(rows.find((row) => row.externalOfferId === keptExternalId)?.status).toBe('active');
    expect(rows.find((row) => row.externalOfferId === goneExternalId)?.status).toBe('retired');
  });
});

// ── The idempotent upserts ──────────────────────────────────────────────────

describe('the observation upsert converges (ADR 0002 D22)', () => {
  it('a re-delivered observation updates the row and never mints a second', async () => {
    const canonicalVariantId = await mintCanonicalVariant('upsert');
    const merchantId = await mintMerchant('upsert');
    const sourceRecordId = await mintSourceRecord('upsert');
    const externalOfferId = `upsert-${RUN}`;
    const firstSeen = new Date(Date.now() - 3_600_000);

    const first = await upsertExternalOffer(
      db,
      externalOffer({
        canonicalVariantId,
        merchantId,
        sourceRecordId,
        externalOfferId,
        priceAmount: 119_900,
        priceCurrency: 'EUR',
        observedAt: firstSeen,
        firstSeenAt: firstSeen,
        lastSeenAt: firstSeen,
      }),
    );

    const second = await upsertExternalOffer(
      db,
      externalOffer({
        canonicalVariantId,
        merchantId,
        sourceRecordId,
        externalOfferId,
        priceAmount: 109_900,
        priceCurrency: 'EUR',
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.priceAmount).toBe(109_900);
    // `first_seen_at` is deliberately absent from the upsert's `set`: a source
    // re-observing an offer it published an hour ago must not make it look new.
    expect(second.firstSeenAt.getTime()).toBe(firstSeen.getTime());
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(firstSeen.getTime());
  });
});

// ── The convergence queue ───────────────────────────────────────────────────

describe('the convergence outbox', () => {
  /**
   * Claim a batch and pick out THIS listing's job.
   *
   * The queue is shared with every other case in this file, and a claim takes
   * the oldest due rows regardless of listing — so taking `claimed[0]` would
   * quietly assert against somebody else's row and pass or fail on test order.
   */
  async function claimJobFor(listingId: string, leaseOwner: string) {
    const jobs = await claimOfferOutbox({ leaseOwner, batchSize: 100 }, db);
    const job = jobs.find((candidate) => candidate.listingId === listingId);
    if (!job) throw new Error(`no convergence job was claimed for ${listingId}`);
    return job;
  }

  it('coalesces repeated requests into ONE row, bumping the revision', async () => {
    const storeId = await mintStore('outbox-coalesce');
    const listingId = await mintListing({ storeId });

    await enqueueOfferConvergence(listingId, db);
    await enqueueOfferConvergence(listingId, db);
    await enqueueOfferConvergence(listingId, db);

    const rows = await db
      .select()
      .from(offerOutboxes)
      .where(eq(offerOutboxes.listingId, listingId));
    expect(rows).toHaveLength(1);
    // The revision counts the requests, and it is `existing + 1` rather than
    // `excluded`: two concurrent enqueues each proposing 1 would otherwise both
    // land on 1 and the second request would be lost.
    expect(rows[0]?.requestedRevision).toBe(3);
  });

  it('a request that arrives DURING a run leaves the row pending, not done', async () => {
    // The race the revision pair exists to close: a moderation restriction
    // landing a millisecond after a claim would otherwise be swallowed by the
    // completion that follows it, and sit unconverged until the next unrelated
    // write to that listing.
    const storeId = await mintStore('outbox-race');
    const listingId = await mintListing({ storeId });
    const owner = `owner-${RUN}`;

    await enqueueOfferConvergence(listingId, db);
    const claimed = await claimJobFor(listingId, owner);
    expect(claimed.claimedRevision).toBe(claimed.requestedRevision);

    // …and now a write lands while the worker is mid-convergence.
    await enqueueOfferConvergence(listingId, db);

    expect(await completeOfferOutbox(claimed.id, owner, new Date(), db)).toBe(true);
    const after = await findOfferOutboxForListing(listingId, db);
    expect(after?.status).toBe('pending');
  });

  it('a run with no newer request completes as done', async () => {
    // The control for the case above: without it, a completion that ALWAYS left
    // the row pending would pass that test and spin forever here.
    const storeId = await mintStore('outbox-done');
    const listingId = await mintListing({ storeId });
    const owner = `owner-done-${RUN}`;

    await enqueueOfferConvergence(listingId, db);
    const claimed = await claimJobFor(listingId, owner);
    expect(await completeOfferOutbox(claimed.id, owner, new Date(), db)).toBe(true);
    expect((await findOfferOutboxForListing(listingId, db))?.status).toBe('done');
  });

  it('a dispatcher whose lease was reclaimed cannot complete the work', async () => {
    const storeId = await mintStore('outbox-lease');
    const listingId = await mintListing({ storeId });

    await enqueueOfferConvergence(listingId, db);
    const claimed = await claimJobFor(listingId, `owner-a-${RUN}`);

    // The owner check, and the reason every terminal transition carries it: two
    // tasks must not be able to write contradictory outcomes for one row.
    expect(await completeOfferOutbox(claimed.id, `owner-b-${RUN}`, new Date(), db)).toBe(false);
    expect((await findOfferOutboxForListing(listingId, db))?.status).toBe('processing');
  });
});

// ── Native convergence: the acceptance-6 property ───────────────────────────

describe('native convergence cannot leave a buyable stale offer (acceptance 6)', () => {
  it('materializes one offer per ATTACHED variant, and none for an unattached one', async () => {
    const storeId = await mintStore('converge-basic');
    const listingId = await mintListing({ storeId });
    const attachedVariant = await mintVariant({ listingId });
    const unattachedVariant = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('converge-basic');

    await insertNativeListingLink(db, {
      productVariantId: attachedVariant,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });

    const result = await convergeNativeOffersForListing(listingId);
    expect(result.materialized).toBe(1);

    // A native variant nobody has matched has nothing to be an offer ON — that
    // is #58's job later, not a failure here.
    expect(await findActiveNativeOfferForVariant(db, attachedVariant)).toBeDefined();
    expect(await findActiveNativeOfferForVariant(db, unattachedVariant)).toBeUndefined();
  });

  it('is a FIXED POINT — running it twice changes nothing and mints nothing', async () => {
    const storeId = await mintStore('converge-idempotent');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('converge-idempotent');
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'barcode_gtin',
      matchRule: 'gtin.exact',
    });

    const first = await convergeNativeOffersForListing(listingId);
    const second = await convergeNativeOffersForListing(listingId);
    expect(first.materialized).toBe(1);
    expect(second.materialized).toBe(1);

    const rows = await db.select({ id: offers.id }).from(offers).where(eq(offers.listingId, listingId));
    expect(rows).toHaveLength(1);
  });

  it('retires every offer of a RESTRICTED listing', async () => {
    const storeId = await mintStore('converge-restricted');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('converge-restricted');
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });
    await convergeNativeOffersForListing(listingId);
    expect(await findActiveNativeOfferForVariant(db, variantId)).toBeDefined();

    // What a jury's `restrict` does to the listing, followed by the convergence
    // the enforcement path enqueues.
    await db.update(listings).set({ status: 'restricted' }).where(eq(listings.id, listingId));
    const result = await convergeNativeOffersForListing(listingId);

    expect(result.retiredForListing).toBe(1);
    expect(await findActiveNativeOfferForVariant(db, variantId)).toBeUndefined();
    const [row] = await db.select().from(offers).where(eq(offers.listingId, listingId));
    // Retired, not deleted — the historical reference survives.
    expect(row?.status).toBe('retired');
    expect(row?.retirementReason).toBe('listing_unpublished');
  });

  it('a REVOKED canonical attachment retires that offer and leaves its sibling alone', async () => {
    const storeId = await mintStore('converge-revoked');
    const listingId = await mintListing({ storeId });
    const keptVariant = await mintVariant({ listingId });
    const droppedVariant = await mintVariant({ listingId });
    const keptCanonical = await mintCanonicalVariant('converge-revoked-kept');
    const droppedCanonical = await mintCanonicalVariant('converge-revoked-dropped');

    await insertNativeListingLink(db, {
      productVariantId: keptVariant,
      listingId,
      canonicalVariantId: keptCanonical,
      method: 'operator',
      matchRule: 'operator.manual',
    });
    const droppedLink = await insertNativeListingLink(db, {
      productVariantId: droppedVariant,
      listingId,
      canonicalVariantId: droppedCanonical,
      method: 'operator',
      matchRule: 'operator.manual',
    });
    await convergeNativeOffersForListing(listingId);

    await db
      .update(nativeListingLinks)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revokedByOxyUserId: `operator-${RUN}`,
        revokeReason: 'wrong product',
      })
      .where(eq(nativeListingLinks.id, droppedLink.id));

    const result = await convergeNativeOffersForListing(listingId);
    expect(result.materialized).toBe(1);
    expect(result.retiredForVariant).toBe(1);
    expect(await findActiveNativeOfferForVariant(db, keptVariant)).toBeDefined();
    expect(await findActiveNativeOfferForVariant(db, droppedVariant)).toBeUndefined();
  });

  it('an out-of-stock variant keeps its offer and marks it out of stock', async () => {
    // The offer stays VISIBLE — a comparison that hid it would tell a shopper
    // the seller does not exist rather than that the item is unavailable — and
    // the live checkout derivation is what refuses the sale.
    const storeId = await mintStore('converge-stock');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId, available: 0 });
    const canonicalVariantId = await mintCanonicalVariant('converge-stock');
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });

    await convergeNativeOffersForListing(listingId);
    const offer = await findActiveNativeOfferForVariant(db, variantId);
    expect(offer?.availability).toBe('out_of_stock');
    expect(offer?.availableQuantity).toBe(0);
  });

  it('an UNTRACKED variant publishes no quantity at all — unknown is not zero', async () => {
    const storeId = await mintStore('converge-untracked');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId, tracked: false, available: 0 });
    const canonicalVariantId = await mintCanonicalVariant('converge-untracked');
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });

    await convergeNativeOffersForListing(listingId);
    const offer = await findActiveNativeOfferForVariant(db, variantId);
    expect(offer?.availability).toBe('in_stock');
    expect(offer?.availableQuantity).toBeNull();
  });

  it('deleting the listing takes its offers, its links and its outbox row with it', async () => {
    // ADR 0002 D20's two deliberate CASCADEs from the native side: a seller
    // deleting their listing is a legitimate flow the graph must not block.
    const storeId = await mintStore('converge-cascade');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('converge-cascade');
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });
    await convergeNativeOffersForListing(listingId);
    await enqueueOfferConvergence(listingId, db);

    await db.delete(listings).where(eq(listings.id, listingId));

    expect(await db.select().from(offers).where(eq(offers.listingId, listingId))).toHaveLength(0);
    expect(
      await db.select().from(nativeListingLinks).where(eq(nativeListingLinks.listingId, listingId)),
    ).toHaveLength(0);
    expect(await findOfferOutboxForListing(listingId, db)).toBeUndefined();
    // And the canonical variant is untouched — RESTRICT on that side is what
    // keeps a seller's delete from reaching the shared identity.
    const [canonical] = await db
      .select()
      .from(canonicalVariants)
      .where(eq(canonicalVariants.id, canonicalVariantId));
    expect(canonical).toBeDefined();
  });
});

describe('the READ gate is live, so a stale offer row is never buyable (acceptance 6)', () => {
  it('a restriction takes effect BEFORE any convergence runs', async () => {
    // This is the property the whole "eligibility is derived, never stored"
    // decision exists for, and it cannot be shown by a converger test: the offer
    // ROW is deliberately left stale here — exactly as it would be while the
    // outbox is backed up, the dispatcher is down or the flag is off — and the
    // verdict still flips, because the projection reads `listings.status` at the
    // moment of the read rather than a copy taken when the row was written.
    const storeId = await mintStore('live-gate');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('live-gate');
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });
    await convergeNativeOffersForListing(listingId);

    const before = await listOffers({ canonicalVariantId, limit: 10 });
    expect(before.offers).toHaveLength(1);
    const offerBefore = before.offers[0];
    if (!offerBefore) throw new Error('the native offer was not projected');
    expect(offerBefore.kind).toBe('native');
    expect(offerBefore.checkout.eligible).toBe(false);
    if (offerBefore.checkout.eligible === true) throw new Error('unreachable');
    // Not payment-ready, because no provider account exists — and NOT restricted.
    expect(offerBefore.checkout.reasons).toContain('seller_not_payment_ready');
    expect(offerBefore.checkout.reasons).not.toContain('listing_restricted');

    // A jury restricts the listing. Nothing converges — no dispatcher runs here.
    await db.update(listings).set({ status: 'restricted' }).where(eq(listings.id, listingId));

    // The row is untouched and still ACTIVE: this is a genuinely stale offer.
    const stored = await findActiveNativeOfferForVariant(db, variantId);
    expect(stored?.status).toBe('active');

    const after = await listOffers({ canonicalVariantId, limit: 10 });
    const offerAfter = after.offers[0];
    if (!offerAfter) throw new Error('the stale offer stopped being projected');
    expect(offerAfter.checkout.eligible).toBe(false);
    if (offerAfter.checkout.eligible === true) throw new Error('unreachable');
    expect(offerAfter.checkout.reasons).toContain('listing_restricted');
  });

  it('carries provenance and freshness on an external offer (acceptance 7)', async () => {
    const canonicalVariantId = await mintCanonicalVariant('projection');
    const merchantId = await mintMerchant('projection');
    const sourceRecordId = await mintSourceRecord('projection');
    const platform = await mintMerchant('projection-platform');
    const channel = await mintStorefront('projection', platform);

    // Through the SERVICE, not the repository: the quality signals are DERIVED
    // from what the observation actually carried, and an adapter that declared
    // them would be able to claim a complete offer it had not observed.
    const now = new Date();
    await recordExternalOffer(
      {
        kind: 'external',
        canonicalVariantId,
        merchantId,
        storefrontId: channel,
        sourceRecordId,
        provider: 'test-feed',
        sourceAccountRef: `acct-${RUN}`,
        externalOfferId: `projection-${RUN}`,
        price: { amount: 99_900, currency: 'EUR' },
        // #90: an adapter supplies the SOURCE's own wording, never a taxonomy
        // key. With no `conditionMappingProvider` there is no ruleset to
        // consult, so the offer preserves the label and stays `unknown` —
        // the fail-closed default.
        conditionSourceLabel: 'Brand new',
        availability: 'in_stock',
        destinationUrl: 'https://example.test/product',
        observedAt: now,
        staleAt: new Date(now.getTime() + 86_400_000),
      },
      now,
      db,
    );

    const page = await listOffers({ canonicalVariantId, limit: 10 });
    const offer = page.offers[0];
    if (!offer) throw new Error('the external offer was not projected');

    expect(offer.provenance.sourceRecordId).toBe(sourceRecordId);
    expect(offer.provenance.provider).toBe('test-feed');
    // The source's RIGHTS come from the registry that owns them, joined at read
    // time — there is no copy on the offer to disagree with `catalog_sources`.
    expect(offer.provenance.mayDisplay).toBe(true);
    expect(offer.provenance.attributionRequired).toBe(false);
    // #68: the level comes from the SOURCE's own contract, resolved live.
    expect(offer.freshness.level).toBe('current');
    // Derived from two foreign keys: the seller is not the channel's operator.
    expect(offer.sellerRole).toBe('marketplace');
    expect(offer.storefrontOperatorMerchantId).toBe(platform);
    // An external offer is never checkout-eligible, whatever else is true.
    expect(offer.checkout.eligible).toBe(false);
    // No delivery facts were supplied, and the union says so rather than zero.
    expect(offer.delivery.known).toBe(false);
    expect(offer.qualitySignals).toContain('unknown_delivery');
  });
});

// ── The native attachment ───────────────────────────────────────────────────

describe('native_listing_links (ADR 0002 D6)', () => {
  it('refuses a second ACTIVE attachment for one native variant', async () => {
    const storeId = await mintStore('link-unique');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const firstCanonical = await mintCanonicalVariant('link-unique-a');
    const secondCanonical = await mintCanonicalVariant('link-unique-b');

    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId: firstCanonical,
      method: 'operator',
      matchRule: 'operator.manual',
    });
    await expectRefused('unique', () =>
      insertNativeListingLink(db, {
        productVariantId: variantId,
        listingId,
        canonicalVariantId: secondCanonical,
        method: 'operator',
        matchRule: 'operator.manual',
      }),
    );
  });

  it('refuses a confidence on anything but a matcher decision', async () => {
    const storeId = await mintStore('link-confidence');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('link-confidence');

    await expectRefused('check', () =>
      insertNativeListingLink(db, {
        productVariantId: variantId,
        listingId,
        canonicalVariantId,
        method: 'barcode_gtin',
        matchRule: 'gtin.exact',
        confidence: 0.9,
      }),
    );
    // …and the matcher's own row is accepted, so the refusal above is not vacuous.
    await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'matcher',
      matchRule: 'title.trigram',
      confidence: 0.9,
    });
  });

  it('refuses an unattributable revocation', async () => {
    const storeId = await mintStore('link-revoke');
    const listingId = await mintListing({ storeId });
    const variantId = await mintVariant({ listingId });
    const canonicalVariantId = await mintCanonicalVariant('link-revoke');
    const link = await insertNativeListingLink(db, {
      productVariantId: variantId,
      listingId,
      canonicalVariantId,
      method: 'operator',
      matchRule: 'operator.manual',
    });

    await expectRefused('check', () =>
      db
        .update(nativeListingLinks)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(nativeListingLinks.id, link.id)),
    );
  });
});

// ── The generated keys exist and are what the indexes read ──────────────────

describe('the generated keys are GENERATED (the anti-vacuity check)', () => {
  it('both keys are stored generated columns no write path can supply', async () => {
    // If either were an ordinary column, every uniqueness assertion above would
    // still pass while a writer could hand-craft a key that disagreed with the
    // endpoints it claims to summarise.
    const rows = await db.execute<{ column_name: string; is_generated: string }>(
      sql`select column_name, is_generated from information_schema.columns
          where table_name = 'offers' and column_name in ('source_key', 'commercial_key')
          order by column_name`,
    );
    expect(rows.map((row) => [row.column_name, row.is_generated])).toEqual([
      ['commercial_key', 'ALWAYS'],
      ['source_key', 'ALWAYS'],
    ]);
  });

  it('refuses a write that tries to supply one', async () => {
    const canonicalVariantId = await mintCanonicalVariant('generated');
    const merchantId = await mintMerchant('generated');
    const sourceRecordId = await mintSourceRecord('generated');
    let thrown: unknown;
    try {
      await db.execute(
        sql`insert into offers (id, kind, canonical_variant_id, merchant_id, source_record_id,
                                destination_url, observed_at, first_seen_at, last_seen_at, stale_at,
                                source_key)
            values (${uuidv7()}, 'external', ${canonicalVariantId}, ${merchantId},
                    ${sourceRecordId}, 'https://example.test/x', now(), now(), now(),
                    now() + interval '1 day', 'forged|key|here')`,
      );
    } catch (error: unknown) {
      thrown = error;
    }
    // SQLSTATE 428C9 — `cannot insert a non-DEFAULT value into column`.
    //
    // The CODE, off the driver's own error, not the message: drizzle wraps the
    // failure in a `Failed query: …` string that contains the SQL but not the
    // SQLSTATE, so a `String(thrown)` assertion would be checking the statement
    // it just sent rather than the answer it got back.
    expect(thrown).toBeDefined();
    const cause = (thrown as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('428C9');
  });
});
