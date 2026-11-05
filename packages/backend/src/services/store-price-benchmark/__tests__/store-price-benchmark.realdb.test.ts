/**
 * The store price-analytics tool against a REAL PostgreSQL server: its
 * computation over fixture offers and price history, through the real offer
 * projection, #74's admission and #78's derivation.
 *
 * What it pins, each against the real reads:
 *
 *  1. Every position band, from a store with four listings on one product.
 *  2. The market is the OTHER sellers: the store's own other listings and the
 *     canonical merchant it is verifiably linked to are never counted.
 *  3. A retired (withdrawn) and a stale offer never enter the market, however
 *     cheap they are.
 *  4. Another currency is converted for display only, with its basis stated; the
 *     store's own price is never converted.
 *  5. A thin market is `unmeasured` with the floor it missed, not a median of two.
 *  6. With no policy nothing is measured.
 *  7. No other seller's id, name or offer appears anywhere in a real response —
 *     as a key OR as a value.
 *  8. The trend: one admitted price per seller per bucket, the floors per
 *     bucket, and the same exclusions as now.
 *  9. All four of #82's floors, time coverage included: a market of offers first
 *     seen today is `insufficient_time_coverage`, now and in the trend, while
 *     the established market above clears it on the offers' own records.
 *
 * Every row this file writes is scoped by a per-run suffix and torn down by id —
 * the database is shared across parallel files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import {
  STORE_PRICE_ANALYTICS_FORBIDDEN_FIELDS,
  type PriceSignalPolicy,
  type StorePriceAnalyticsResponse,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { declaredOfferCondition } from '../../condition/condition-mapping.service.js';
import { listings, productVariants } from '../../../db/schema/catalog.js';
import { stores } from '../../../db/schema/stores.js';
import { merchants, nativeStoreLinks } from '../../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import { offerPriceSnapshots } from '../../../db/schema/priceHistory.js';
import type { InsertOfferInput } from '../../../db/offers/offerRepository.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { readStorePriceAnalytics, readStorePriceTrend } from '../benchmark.service.js';
import { toStorePriceAnalyticsCsv } from '../csv.js';

let db: Database;

const RUN = uuidv7().slice(-12);
const DAY = 24 * 60 * 60 * 1_000;

const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdSourceIds: string[] = [];
const createdSourceRecordIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

/** Every competitor identity the fixtures mint — none may appear in a response. */
const competitorStrings: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/** A policy fixture, passed directly: the ACTIVE version is one global row. */
const POLICY: PriceSignalPolicy = {
  policyKey: `store-price-analytics-${RUN}`,
  version: `test-${RUN}`,
  minObservations: 3,
  minDistinctSellers: 3,
  minDistinctOffers: 3,
  minCoverageDays: 7,
  recentWindowDays: 30,
  outlierModifiedZThreshold: 3.5,
  outlierMinDeviationBps: 7_500,
  materialDropBps: 500,
  typicalBandBps: 300,
  goodPriceBelowMedianBps: 800,
  strongSampleMultiplier: 2,
  objectiveMetricKeys: [],
  guardrailMetricKeys: ['zero_result_rate'],
};

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db.execute(sql`
    delete from offer_price_snapshots where offer_id in (
      select id from offers where canonical_variant_id = any(${sql.param(safeIds(createdVariantIds))}::text[])
    )`);
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(listings).where(inArray(listings.id, safeIds(createdListingIds)));
  await deleteTestStores(db, safeIds(createdStoreIds));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.id, safeIds(createdSourceRecordIds)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await closePostgres();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      oxyAccountId: 'oxy-account-fixture',
      handle: `spa-${label}-${RUN}`,
      name: `Price analytics ${label} ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  if (!row) throw new Error('mintStore returned no row');
  createdStoreIds.push(row.id);
  return row.id;
}

async function mintCanonicalVariant(
  label: string,
): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Analytics product ${label} ${RUN}`,
      normalizedName: `analytics product ${label} ${RUN}`,
      slug: `analytics-product-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('no canonical product');
  createdProductIds.push(product.id);
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('no canonical variant');
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

/** One of the store's listings with one variant and its ACTIVE native offer. */
async function mintStoreListing(input: {
  storeId: string;
  canonicalVariantId: string;
  priceAmount: number;
  title: string;
}): Promise<{ listingId: string; productVariantId: string; offerId: string }> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'store',
      storeId: input.storeId,
      title: input.title,
      description: 'a listing under test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('no listing');
  createdListingIds.push(listing.id);
  const [variant] = await db
    .insert(productVariants)
    .values({
      listingId: listing.id,
      title: 'Default Title',
      priceAmount: input.priceAmount,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
    })
    .returning({ id: productVariants.id });
  if (!variant) throw new Error('no variant');
  const now = new Date();
  const [offer] = await db
    .insert(offers)
    .values({
      kind: 'native',
      status: 'active',
      ...declaredOfferCondition('new'),
      canonicalVariantId: input.canonicalVariantId,
      productVariantId: variant.id,
      listingId: listing.id,
      priceAmount: input.priceAmount,
      priceCurrency: 'EUR',
      availability: 'in_stock',
      availableQuantity: 5,
      qualitySignals: ['unknown_delivery'],
      observedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      lastConfirmedAt: now,
      staleAt: new Date(now.getTime() + 7 * DAY),
    } satisfies InsertOfferInput)
    .returning({ id: offers.id });
  if (!offer) throw new Error('no native offer');
  return { listingId: listing.id, productVariantId: variant.id, offerId: offer.id };
}

async function mintMerchant(label: string): Promise<string> {
  const name = `Rival ${label} ${RUN}`;
  const [row] = await db
    .insert(merchants)
    .values({ name, slug: `rival-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!row) throw new Error('no merchant');
  createdMerchantIds.push(row.id);
  competitorStrings.push(row.id, name);
  return row.id;
}

async function mintSourceRecord(label: string): Promise<string> {
  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `spa-source-${label}-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning({ id: catalogSources.id });
  if (!source) throw new Error('no source');
  createdSourceIds.push(source.id);
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId: source.id,
      externalType: 'offer',
      externalId: `spa-ext-${label}-${RUN}`,
      observedAt: new Date(),
      contentHash: uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      payload: { fixture: true },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('no source record');
  createdSourceRecordIds.push(record.id);
  return record.id;
}

/** Another seller's external offer on the variant. */
async function mintRivalOffer(input: {
  canonicalVariantId: string;
  merchantId: string;
  priceAmount: number;
  currency?: string;
  retired?: boolean;
  stale?: boolean;
  /**
   * How long ago the offer was first seen. Twenty days by default — an
   * ESTABLISHED seller, whose record clears the fixture policy's seven-day
   * coverage floor; `0` mints a seller who appeared today.
   */
  firstSeenDaysAgo?: number;
}): Promise<string> {
  const sourceRecordId = await mintSourceRecord(`${input.merchantId}-${input.priceAmount}`);
  const now = new Date();
  const seen = input.stale ? new Date(now.getTime() - 30 * DAY) : now;
  const firstSeen = new Date(
    Math.min(seen.getTime(), now.getTime() - (input.firstSeenDaysAgo ?? 20) * DAY),
  );
  const [row] = await db
    .insert(offers)
    .values({
      kind: 'external',
      status: input.retired ? 'retired' : 'active',
      ...(input.retired ? { retirementReason: 'source_disappeared', retiredAt: now } : {}),
      ...declaredOfferCondition('new'),
      canonicalVariantId: input.canonicalVariantId,
      merchantId: input.merchantId,
      sourceRecordId,
      destinationUrl: `https://rival.example.test/${input.merchantId}`,
      provider: 'test-feed',
      externalOfferId: `spa-${uuidv7()}`,
      priceAmount: input.priceAmount,
      priceCurrency: input.currency ?? 'EUR',
      availability: 'in_stock',
      observedAt: seen,
      firstSeenAt: firstSeen,
      lastSeenAt: seen,
      lastConfirmedAt: seen,
      staleAt: input.stale ? new Date(now.getTime() - DAY) : new Date(now.getTime() + DAY),
    } satisfies InsertOfferInput)
    .returning({ id: offers.id });
  if (!row) throw new Error('no rival offer');
  competitorStrings.push(row.id, `https://rival.example.test/${input.merchantId}`);
  return row.id;
}

async function seedObservation(
  offerId: string,
  amount: number,
  observedAt: Date,
  currency = 'EUR',
) {
  await db.insert(offerPriceSnapshots).values({
    offerId,
    observedAt,
    itemPriceAmount: amount,
    itemPriceCurrency: currency,
    taxInclusion: 'unknown',
    conditionKey: 'new',
    availability: 'in_stock',
    freshnessLevel: 'current',
    observationHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    changeReasons: ['price'],
  });
}

/** Every key and every string value anywhere in a JSON-shaped value. */
function walk(value: unknown, keys: Set<string>, strings: Set<string>): void {
  if (typeof value === 'string') {
    strings.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, strings);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    walk(child, keys, strings);
  }
}

// ── The scenario ────────────────────────────────────────────────────────────

interface Scenario {
  storeId: string;
  canonicalVariantId: string;
  rows: Record<
    'mid' | 'cheapest' | 'near' | 'dear',
    { listingId: string; productVariantId: string; offerId: string }
  >;
  thin: { productVariantId: string };
  rivalOfferIds: string[];
  linkedOfferId: string;
}

let scenario: Scenario;

beforeAll(async () => {
  const storeId = await mintStore('subject');
  const { variantId } = await mintCanonicalVariant('main');

  // Four of the store's own listings on ONE product. Each is a row, and none of
  // them is ever part of another's market.
  const mid = await mintStoreListing({
    storeId,
    canonicalVariantId: variantId,
    priceAmount: 10_000,
    title: `Mid ${RUN}`,
  });
  const cheapest = await mintStoreListing({
    storeId,
    canonicalVariantId: variantId,
    priceAmount: 9_000,
    title: `Cheapest ${RUN}`,
  });
  const near = await mintStoreListing({
    storeId,
    canonicalVariantId: variantId,
    priceAmount: 9_900,
    title: `Near ${RUN}`,
  });
  const dear = await mintStoreListing({
    storeId,
    canonicalVariantId: variantId,
    priceAmount: 12_000,
    title: `Dear ${RUN}`,
  });

  // The market: four sellers, one of them in USD (converted for display).
  const rivalOfferIds = [
    await mintRivalOffer({
      canonicalVariantId: variantId,
      merchantId: await mintMerchant('a'),
      priceAmount: 9_500,
    }),
    await mintRivalOffer({
      canonicalVariantId: variantId,
      merchantId: await mintMerchant('b'),
      priceAmount: 10_500,
    }),
    await mintRivalOffer({
      canonicalVariantId: variantId,
      merchantId: await mintMerchant('c'),
      priceAmount: 11_000,
    }),
    // 13_000 USD is ~11_900 EUR at the static test rates — above the median, so
    // it moves the count and not the median.
    await mintRivalOffer({
      canonicalVariantId: variantId,
      merchantId: await mintMerchant('d'),
      priceAmount: 13_000,
      currency: 'USD',
    }),
  ];

  // Cheaper than everything, and never in the market: a WITHDRAWN offer, a
  // STALE one and the store's own linked canonical merchant.
  await mintRivalOffer({
    canonicalVariantId: variantId,
    merchantId: await mintMerchant('withdrawn'),
    priceAmount: 100,
    retired: true,
  });
  await mintRivalOffer({
    canonicalVariantId: variantId,
    merchantId: await mintMerchant('stale'),
    priceAmount: 200,
    stale: true,
  });
  const linkedMerchantId = await mintMerchant('linked');
  await db.insert(nativeStoreLinks).values({
    merchantId: linkedMerchantId,
    storeId,
    verificationMethod: 'operator',
    verifiedByOxyUserId: `operator-${RUN}`,
    verifiedAt: new Date(),
  });
  const linkedOfferId = await mintRivalOffer({
    canonicalVariantId: variantId,
    merchantId: linkedMerchantId,
    priceAmount: 50,
  });

  // A second product with only two other sellers — a thin market.
  const thinVariant = await mintCanonicalVariant('thin');
  const thin = await mintStoreListing({
    storeId,
    canonicalVariantId: thinVariant.variantId,
    priceAmount: 5_000,
    title: `Thin ${RUN}`,
  });
  await mintRivalOffer({
    canonicalVariantId: thinVariant.variantId,
    merchantId: await mintMerchant('thin-a'),
    priceAmount: 4_000,
  });
  await mintRivalOffer({
    canonicalVariantId: thinVariant.variantId,
    merchantId: await mintMerchant('thin-b'),
    priceAmount: 6_000,
  });

  scenario = {
    storeId,
    canonicalVariantId: variantId,
    rows: { mid, cheapest, near, dear },
    thin,
    rivalOfferIds,
    linkedOfferId,
  };
}, 120_000);

describe('the overview, now', () => {
  let response: StorePriceAnalyticsResponse;

  beforeAll(async () => {
    response = await readStorePriceAnalytics({ storeId: scenario.storeId, policy: POLICY });
  }, 120_000);

  it('analyses every live matched listing variant and says how many there are', () => {
    expect(response.coverage).toEqual({ listingsTotal: 5, listingsAnalysed: 5, truncated: false });
    expect(response.rows).toHaveLength(5);
    expect(response.semantics?.policyVersion).toBe(POLICY.version);
    expect(response.semantics?.minCoverageDays).toBe(POLICY.minCoverageDays);
  });

  it('compares against the OTHER sellers only — four, lowest 9 500, median 10 500', () => {
    const mid = response.rows.find(
      (row) => row.productVariantId === scenario.rows.mid.productVariantId,
    );
    expect(mid?.state).toBe('measured');
    // The withdrawn (100), the stale (200), the linked merchant (50) and the
    // store's own three other listings (9 000, 9 900, 12 000) are all absent:
    // the lowest is the cheapest REAL rival.
    expect(mid?.market).toMatchObject({
      otherSellers: 4,
      lowestAmount: 9_500,
      medianAmount: 10_500,
    });
    // The store's own price, in its own currency, unconverted.
    expect(mid?.ownAmount).toBe(10_000);
    expect(mid?.currency).toBe('EUR');
  });

  it('places each listing in its band', () => {
    const band = (key: keyof Scenario['rows']) =>
      response.rows.find((row) => row.productVariantId === scenario.rows[key].productVariantId)
        ?.position?.band;
    expect(band('cheapest')).toBe('lowest');
    expect(band('near')).toBe('near_lowest');
    expect(band('mid')).toBe('at_or_below_median');
    expect(band('dear')).toBe('above_median');
    expect(response.summary.byBand).toEqual({
      lowest: 1,
      near_lowest: 1,
      at_or_below_median: 1,
      above_median: 1,
    });
    expect(response.summary).toMatchObject({ listingsAnalysed: 5, measured: 4, unmeasured: 1 });
  });

  it('states the conversion when another currency was converted for display', () => {
    const mid = response.rows.find(
      (row) => row.productVariantId === scenario.rows.mid.productVariantId,
    );
    expect(mid?.conversion?.provider).toBeTruthy();
    expect(Number.isNaN(Date.parse(mid?.conversion?.asOf ?? ''))).toBe(false);
  });

  it('answers a thin market with the floor it missed, and no figure', () => {
    const thin = response.rows.find(
      (row) => row.productVariantId === scenario.thin.productVariantId,
    );
    expect(thin).toMatchObject({ state: 'unmeasured', reason: 'insufficient_observations' });
    expect(thin?.market).toBeUndefined();
    expect(thin?.position).toBeUndefined();
  });

  it('carries no other seller anywhere — not as a key, not as a value', () => {
    const keys = new Set<string>();
    const strings = new Set<string>();
    walk(response, keys, strings);
    // Vacuity floor: the walk saw the fields the response DOES carry.
    expect(keys.has('market')).toBe(true);
    expect(keys.has('listingId')).toBe(true);
    for (const forbidden of STORE_PRICE_ANALYTICS_FORBIDDEN_FIELDS) {
      expect(keys.has(forbidden), `the response carries \`${forbidden}\``).toBe(false);
    }
    expect(competitorStrings.length).toBeGreaterThanOrEqual(10);
    for (const value of competitorStrings) {
      expect(strings.has(value), `the response names a competitor (${value})`).toBe(false);
    }
    const csv = toStorePriceAnalyticsCsv(response);
    for (const value of competitorStrings) expect(csv.includes(value)).toBe(false);
    expect(csv.split('\n')).toHaveLength(6);
  });

  it('measures nothing without a policy, and says why', async () => {
    const empty = await readStorePriceAnalytics({ storeId: scenario.storeId, policy: null });
    expect(empty.semantics).toBeUndefined();
    expect(empty.rows.length).toBe(5);
    for (const row of empty.rows) {
      expect(row).toMatchObject({ state: 'unmeasured', reason: 'no_active_policy' });
    }
    expect(empty.summary.measured).toBe(0);
  });

  it('a market of sellers first seen TODAY is not a market yet — now and in the trend', async () => {
    // The floor the old "now" stamp made unanswerable, and that this tool used
    // to skip: three sellers, every other floor cleared, observed for no time.
    const storeId = await mintStore('minted');
    const { variantId } = await mintCanonicalVariant('minted');
    const own = await mintStoreListing({
      storeId,
      canonicalVariantId: variantId,
      priceAmount: 10_000,
      title: `Minted ${RUN}`,
    });
    const rivals: string[] = [];
    for (const [label, priceAmount] of [
      ['minted-a', 9_500],
      ['minted-b', 10_500],
      ['minted-c', 11_000],
    ] as const) {
      rivals.push(
        await mintRivalOffer({
          canonicalVariantId: variantId,
          merchantId: await mintMerchant(label),
          priceAmount,
          firstSeenDaysAgo: 0,
        }),
      );
    }

    const overview = await readStorePriceAnalytics({ storeId, policy: POLICY });
    expect(overview.rows).toHaveLength(1);
    expect(overview.rows[0]).toMatchObject({
      state: 'unmeasured',
      reason: 'insufficient_time_coverage',
    });
    expect(overview.rows[0]?.market).toBeUndefined();

    // The same floor, from the same span rule, in the trend: an observation an
    // hour old from an offer first seen just now spans nothing.
    const now = new Date();
    const anHourAgo = new Date(now.getTime() - 60 * 60 * 1_000);
    for (const [index, offerId] of rivals.entries()) {
      await seedObservation(offerId, 9_500 + index * 500, anHourAgo);
    }
    const trend = await readStorePriceTrend({
      storeId,
      productVariantId: own.productVariantId,
      windowDays: 30,
      granularity: 'day',
      policy: POLICY,
      now,
    });
    const bucket = trend.points.find(
      (point) => point.bucketStart.slice(0, 10) === anHourAgo.toISOString().slice(0, 10),
    );
    expect(bucket).toMatchObject({ market: null, marketReason: 'insufficient_time_coverage' });
  });

  it('a store with nothing matched answers an empty, honest overview', async () => {
    const storeId = await mintStore('empty');
    const empty = await readStorePriceAnalytics({ storeId, policy: POLICY });
    expect(empty.rows).toEqual([]);
    expect(empty.coverage).toEqual({ listingsTotal: 0, listingsAnalysed: 0, truncated: false });
  });
});

describe('the trend', () => {
  it('compares the listing with one price per other seller per day, floors per bucket', async () => {
    const now = new Date();
    const today = new Date(now.getTime() - 60_000);
    const yesterday = new Date(now.getTime() - DAY);
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY);
    const [a, b, c] = scenario.rivalOfferIds as [string, string, string];

    // The listing's own history.
    await seedObservation(scenario.rows.mid.offerId, 10_400, twoDaysAgo);
    await seedObservation(scenario.rows.mid.offerId, 10_000, yesterday);
    // Two days ago: two rivals only — below the floor.
    await seedObservation(a, 9_600, twoDaysAgo);
    await seedObservation(b, 10_600, twoDaysAgo);
    // Yesterday: three rivals, one of them observed twice (its cheaper price counts once).
    await seedObservation(a, 9_500, yesterday);
    await seedObservation(a, 9_400, new Date(yesterday.getTime() + 60_000));
    await seedObservation(b, 10_500, yesterday);
    await seedObservation(c, 11_000, yesterday);
    // Never the market: the linked merchant and the store's own other listing.
    await seedObservation(scenario.linkedOfferId, 50, yesterday);
    await seedObservation(scenario.rows.cheapest.offerId, 9_000, yesterday);
    await seedObservation(scenario.rows.dear.offerId, 1, today);

    const trend = await readStorePriceTrend({
      storeId: scenario.storeId,
      productVariantId: scenario.rows.mid.productVariantId,
      windowDays: 30,
      granularity: 'day',
      policy: POLICY,
      now,
    });
    expect(trend.reason).toBeUndefined();
    expect(trend.points.length).toBeGreaterThanOrEqual(30);

    const dayOf = (instant: Date) => instant.toISOString().slice(0, 10);
    const at = (instant: Date) =>
      trend.points.find((point) => point.bucketStart.slice(0, 10) === dayOf(instant));

    expect(at(yesterday)).toMatchObject({
      ownAmount: 10_000,
      market: { otherSellers: 3, lowestAmount: 9_400, medianAmount: 10_500 },
    });
    expect(at(twoDaysAgo)).toMatchObject({
      ownAmount: 10_400,
      market: null,
      marketReason: 'insufficient_observations',
    });
    // The store's other listing seeded today is NOT this listing's own price.
    expect(at(today)?.ownAmount ?? null).toBeNull();

    const keys = new Set<string>();
    const strings = new Set<string>();
    walk(trend, keys, strings);
    expect(keys.has('points')).toBe(true);
    for (const forbidden of STORE_PRICE_ANALYTICS_FORBIDDEN_FIELDS) {
      expect(keys.has(forbidden), `the trend carries \`${forbidden}\``).toBe(false);
    }
    for (const value of competitorStrings) expect(strings.has(value)).toBe(false);
  });

  it('weekly buckets fold the days into one point', async () => {
    const trend = await readStorePriceTrend({
      storeId: scenario.storeId,
      productVariantId: scenario.rows.mid.productVariantId,
      windowDays: 30,
      granularity: 'week',
      policy: POLICY,
    });
    expect(trend.points.length).toBeGreaterThanOrEqual(5);
    expect(trend.points.length).toBeLessThanOrEqual(6);
  });

  it("answers 404 for a variant that is not one of the store's comparable listings", async () => {
    const otherStore = await mintStore('other');
    await expect(
      readStorePriceTrend({
        storeId: otherStore,
        productVariantId: scenario.rows.mid.productVariantId,
        windowDays: 30,
        granularity: 'day',
        policy: POLICY,
      }),
    ).rejects.toThrow('Listing not found');
  });
});
