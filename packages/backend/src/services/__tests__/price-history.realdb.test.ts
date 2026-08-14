/**
 * #78's acceptance criteria, each against a REAL PostgreSQL server.
 *
 * None of them exists under a mock. Four are CONSTRAINTS — an immutability
 * trigger, a `cardinality` CHECK that the obvious `array_length` spelling would
 * silently invert, a biconditional FX shape and a non-negative money rule — and
 * a mocked `insert` accepts every statement the server refuses. Two more are
 * about a CASCADE and a delete-then-insert rebuild, which have no mocked
 * counterpart at all.
 *
 * The failure mode the file guards against is a chart that looks continuous,
 * confident and cheap while being a mixture of currencies, conditions and
 * prices nobody could pay. So the assertions fail LOUDLY on the safe-looking
 * direction: a point that appeared when it should have been excluded is as much
 * a failure here as one that vanished.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { PRICE_HISTORY_FORBIDDEN_DTO_FIELDS, PRICE_HISTORY_POLICY_VERSION } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { catalogSourceConfigs, catalogSourcePolicies } from '../../db/schema/ingestion.js';
import { offers } from '../../db/schema/offers.js';
import {
  offerPricePoints,
  offerPriceSeries,
  offerPriceSnapshots,
  offerPriceWriteMetrics,
} from '../../db/schema/priceHistory.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import { recordExternalOffer } from '../offers/offer.service.js';
import { retireOffers } from '../../db/offers/offerRepository.js';
import {
  claimPriceSeriesRebuilds,
  findPriceSeries,
  listPricePoints,
  requestPriceSeriesRebuild,
} from '../../db/priceHistory/priceSeriesRepository.js';
import { findPriceWriteMetrics } from '../../db/priceHistory/priceWriteMetricsRepository.js';
import { rebuildPriceSeries } from '../price-history/rebuild.service.js';
import { readPriceHistory } from '../price-history/read.service.js';
import { tracePriceHistoryForOffer } from '../price-history/metrics.service.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `price-history-${RUN}`;
const DAY_MS = 24 * 60 * 60 * 1_000;

const createdSourceIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];

/** The shared advisory-lock key every teardown that toggles a policy trigger takes. */
const POLICY_TEARDOWN_LOCK = 6_820_068;

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/**
 * Assert a write is refused, and report WHY — the whole cause chain.
 *
 * drizzle's own message says "Failed query: …" and the constraint name lives on
 * the `PostgresError` it wraps, so a test matching only the outer message would
 * pass against ANY refusal, including a typo.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db.delete(offerPricePoints).where(
    sql`${offerPricePoints.offerId} in (
      select id from offers where canonical_variant_id = any(${sql.param(safeIds(createdVariantIds))}::text[])
    )`,
  );
  await db.delete(offerPriceSeries).where(
    sql`${offerPriceSeries.canonicalVariantId} = any(${sql.param(safeIds(createdVariantIds))}::text[])
        or ${offerPriceSeries.canonicalProductId} = any(${sql.param(safeIds(createdProductIds))}::text[])`,
  );
  await db.delete(offerPriceSnapshots).where(
    sql`${offerPriceSnapshots.offerId} in (
      select id from offers where canonical_variant_id = any(${sql.param(safeIds(createdVariantIds))}::text[])
    )`,
  );
  await db
    .delete(offerPriceWriteMetrics)
    .where(inArray(offerPriceWriteMetrics.sourceId, safeIds(createdSourceIds)));
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceConfigs)
    .where(inArray(catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
  await db.execute(sql`select pg_advisory_lock(${POLICY_TEARDOWN_LOCK})`);
  try {
    await db.execute(
      sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`,
    );
    await db
      .delete(catalogSourcePolicies)
      .where(inArray(catalogSourcePolicies.sourceId, safeIds(createdSourceIds)));
    await db.execute(
      sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`,
    );
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${POLICY_TEARDOWN_LOCK})`);
  }
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

async function mintCanonicalVariant(label: string): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `PriceHistory ${label} ${RUN}`,
      normalizedName: `pricehistory ${label} ${RUN}`,
      slug: `pricehistory-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      signature: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the canonical variant was not written');
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

async function mintMerchant(label: string): Promise<string> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `PriceHistory ${label} ${RUN}`, slug: `pricehistory-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('the merchant was not written');
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

async function mintSourceRecord(sourceId: string, externalId: string): Promise<string> {
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      externalType: 'offer',
      externalId,
      contentHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      observedAt: new Date(),
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return record.id;
}

/** A source that may display a price, so a case is about history and nothing else. */
async function bringUpSource(label: string): Promise<{ sourceId: string; provider: string; merchantId: string }> {
  const provider = `ph-${label}-${RUN}`.toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 64);
  const merchantId = await mintMerchant(label);
  const resolved = await configureIngestionSource({
    name: `Price history source ${label} ${RUN}`,
    kind: 'feed',
    provider,
    merchantId,
    fetchCadenceSeconds: 3_600,
    freshnessTtlSeconds: 3_600,
    pageSize: 50,
  });
  const sourceId = resolved.source.config.sourceId;
  createdSourceIds.push(sourceId);
  await publishIngestionSourcePolicy({
    sourceId,
    reviewedByOxyUserId: OPERATOR,
    mayDisplay: true,
    mayStore: false,
    mayCache: false,
    mayDisplayPrice: true,
    mayDisplayMedia: true,
    mayLinkOut: true,
    mayAppendAffiliateParams: false,
    mayIndex: true,
    mayRefreshAutomatically: true,
    extractionMode: 'disallowed',
    attributionRequired: true,
  });
  await changeIngestionSourceStatus({
    sourceId,
    status: 'active',
    actorOxyUserId: OPERATOR,
    reason: 'price history acceptance suite',
  });
  return { sourceId, provider, merchantId };
}

/** One observation of one external offer, through the real write path. */
async function observe(input: {
  source: { sourceId: string; provider: string; merchantId: string };
  canonicalVariantId: string;
  externalOfferId: string;
  amount: number;
  currency: string;
  observedAt: Date;
  condition?: string;
  delivery?: { amount: number; currency: string };
}): Promise<string> {
  const sourceRecordId = await mintSourceRecord(input.source.sourceId, `${input.externalOfferId}-${input.observedAt.getTime()}`);
  return recordExternalOffer({
    kind: 'external',
    canonicalVariantId: input.canonicalVariantId,
    merchantId: input.source.merchantId,
    sourceRecordId,
    sourceId: input.source.sourceId,
    provider: input.source.provider,
    externalOfferId: input.externalOfferId,
    price: { amount: input.amount, currency: input.currency },
    ...(input.delivery ? { delivery: { cost: input.delivery } } : {}),
    conditionSourceLabel: input.condition ?? 'New',
    destinationUrl: `https://example.test/${input.externalOfferId}`,
    observedAt: input.observedAt,
    staleAt: new Date(input.observedAt.getTime() + 30 * DAY_MS),
  });
}

/**
 * Seed one observation directly, with an explicit condition and instant.
 *
 * The write PATH is exercised by the dedup, refusal and immutability cases
 * above, which all go through `recordExternalOffer`. The derivation cases need
 * something that path cannot give them: a known SEGMENT. `recordExternalOffer`
 * routes a source label through #90's versioned ruleset, no ruleset is
 * published here, and an unmapped label is `unknown` by design — so every
 * observation would be excluded for a reason that has nothing to do with what
 * is under test. Seeding the row states the fixture instead of arranging for it
 * through a domain #90 already tests, and it still goes through the real table
 * and every one of its CHECKs.
 */
async function seedObservation(input: {
  offerId: string;
  amount: number;
  currency: string;
  observedAt: Date;
  conditionKey: string;
  shipping?: { amount: number; currency: string };
}): Promise<string> {
  const [row] = await db
    .insert(offerPriceSnapshots)
    .values({
      offerId: input.offerId,
      observedAt: input.observedAt,
      itemPriceAmount: input.amount,
      itemPriceCurrency: input.currency,
      ...(input.shipping
        ? { shippingCostAmount: input.shipping.amount, shippingCostCurrency: input.shipping.currency }
        : {}),
      taxInclusion: 'unknown',
      conditionKey: input.conditionKey as 'new',
      availability: 'in_stock',
      freshnessLevel: 'current',
      observationHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      changeReasons: ['price'],
    })
    .returning({ id: offerPriceSnapshots.id });
  if (!row) throw new Error('the seeded observation was not written');
  return row.id;
}

describe('an observation is immutable, and a correction supersedes it', () => {
  it('refuses an UPDATE outright and permits the retention DELETE', async () => {
    const source = await bringUpSource('immutable');
    const { variantId } = await mintCanonicalVariant('immutable');
    const observedAt = new Date(Date.now() - 5 * DAY_MS);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `imm-${RUN}`,
      amount: 10_000,
      currency: 'EUR',
      observedAt,
    });

    const [row] = await db
      .select()
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId));
    expect(row).toBeDefined();
    if (!row) return;

    const message = await rejectionMessage(() =>
      db
        .update(offerPriceSnapshots)
        .set({ itemPriceAmount: 1 })
        .where(eq(offerPriceSnapshots.id, row.id)),
    );
    expect(message).toContain('immutable');

    // A CORRECTION is a new record naming the one it revises. It is the only
    // way to change what history says, and it leaves the original in place.
    const [correction] = await db
      .insert(offerPriceSnapshots)
      .values({
        offerId,
        observedAt: new Date(observedAt.getTime() + 60_000),
        itemPriceAmount: 9_000,
        itemPriceCurrency: 'EUR',
        taxInclusion: 'unknown',
        conditionKey: row.conditionKey,
        availability: row.availability,
        freshnessLevel: 'current',
        observationHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        changeReasons: ['correction'],
        supersedesSnapshotId: row.id,
      })
      .returning({ id: offerPriceSnapshots.id });
    expect(correction).toBeDefined();

    const [original] = await db
      .select({ amount: offerPriceSnapshots.itemPriceAmount })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.id, row.id));
    expect(original?.amount).toBe(10_000);

    // DELETE is deliberately PERMITTED — a source's retention right is honoured
    // by the shared sweep, and a trigger refusing it would make that fail
    // silently. Deleting the correction first: the self-reference has no
    // `onDelete` action, so removing a corrected row while its correction
    // survives is refused, which is the point.
    if (correction) {
      await db.delete(offerPriceSnapshots).where(eq(offerPriceSnapshots.id, correction.id));
    }
    await db.delete(offerPriceSnapshots).where(eq(offerPriceSnapshots.id, row.id));
    const remaining = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.id, row.id));
    expect(remaining).toHaveLength(0);
  });
});

describe('the constraints a mocked insert would accept', () => {
  it('refuses an EMPTY change-reason array — the `array_length` trap', async () => {
    const source = await bringUpSource('cardinality');
    const { variantId } = await mintCanonicalVariant('cardinality');
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `card-${RUN}`,
      amount: 5_000,
      currency: 'EUR',
      observedAt: new Date(Date.now() - 4 * DAY_MS),
    });

    // The DISCRIMINATING fixture: `array_length('{}', 1)` is NULL and a CHECK
    // rejects only FALSE, so the obvious spelling ADMITS exactly this row.
    // `cardinality('{}')` is 0 and refuses it.
    const message = await rejectionMessage(() =>
      db.insert(offerPriceSnapshots).values({
        offerId,
        observedAt: new Date(),
        itemPriceAmount: 1_000,
        itemPriceCurrency: 'EUR',
        taxInclusion: 'unknown',
        conditionKey: 'new',
        availability: 'in_stock',
        freshnessLevel: 'current',
        observationHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        changeReasons: [],
      }),
    );
    expect(message).toContain('offer_price_snapshots_change_reasons_present_check');
  });

  it('refuses a negative price', async () => {
    const source = await bringUpSource('negative');
    const { variantId } = await mintCanonicalVariant('negative');
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `neg-${RUN}`,
      amount: 5_000,
      currency: 'EUR',
      observedAt: new Date(Date.now() - 4 * DAY_MS),
    });

    const message = await rejectionMessage(() =>
      db.insert(offerPriceSnapshots).values({
        offerId,
        observedAt: new Date(),
        itemPriceAmount: -1,
        itemPriceCurrency: 'EUR',
        taxInclusion: 'unknown',
        conditionKey: 'new',
        availability: 'in_stock',
        freshnessLevel: 'current',
        observationHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        changeReasons: ['initial'],
      }),
    );
    expect(message).toContain('offer_price_snapshots_non_negative_money_check');
  });

  it('refuses a converted point with no identifiable quote — currency rule 4', async () => {
    const source = await bringUpSource('fxshape');
    const { variantId, productId } = await mintCanonicalVariant('fxshape');
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `fx-${RUN}`,
      amount: 5_000,
      currency: 'EUR',
      observedAt: new Date(Date.now() - 4 * DAY_MS),
    });
    const [snapshot] = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId));
    expect(snapshot).toBeDefined();
    if (!snapshot) return;

    const [series] = await db
      .insert(offerPriceSeries)
      .values({
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        displayCurrency: 'USD',
        granularity: 'day',
        policyVersion: PRICE_HISTORY_POLICY_VERSION,
        availableAt: new Date(),
      })
      .returning({ id: offerPriceSeries.id });
    expect(series).toBeDefined();
    if (!series) return;

    const base = {
      seriesId: series.id,
      bucketStart: new Date('2026-03-02T00:00:00.000Z'),
      measure: 'lowest_item_price' as const,
      segment: 'new' as const,
      offerId,
      snapshotId: snapshot.id,
      observedAt: new Date('2026-03-02T10:00:00.000Z'),
      admittedFreshness: 'current' as const,
      contributingObservationCount: 1,
      nativeAmount: 5_000,
      nativeCurrency: 'EUR' as const,
    };

    // A display amount that differs from the native one with NO rate: the exact
    // shape currency rule 4 forbids, and the one a service bug produces.
    const noQuote = await rejectionMessage(() =>
      db.insert(offerPricePoints).values({ ...base, displayAmount: 5_500 }),
    );
    expect(noQuote).toContain('offer_price_points_fx_shape_check');

    // A quote naming a currency the point is not denominated in.
    const wrongFrom = await rejectionMessage(() =>
      db.insert(offerPricePoints).values({
        ...base,
        displayAmount: 5_500,
        fxRate: 1.1,
        fxFrom: 'GBP',
        fxTo: 'USD',
        fxProvider: 'static',
        fxAsOf: new Date(),
      }),
    );
    expect(wrongFrom).toContain('offer_price_points_fx_shape_check');

    // The well-formed one is accepted, which is what makes the two refusals
    // above evidence about the CHECK rather than about the fixture.
    await db.insert(offerPricePoints).values({
      ...base,
      displayAmount: 5_500,
      fxRate: 1.1,
      fxFrom: 'EUR',
      fxTo: 'USD',
      fxProvider: 'static',
      fxAsOf: new Date(),
    });
    const written = await db
      .select({ id: offerPricePoints.id })
      .from(offerPricePoints)
      .where(eq(offerPricePoints.seriesId, series.id));
    expect(written).toHaveLength(1);

    // ACCEPTANCE 6, as a CASCADE: deleting the observation takes the point with
    // it, so there is never a point asserting a price with nothing behind it.
    await db.delete(offerPriceSnapshots).where(eq(offerPriceSnapshots.id, snapshot.id));
    const orphaned = await db
      .select({ id: offerPricePoints.id })
      .from(offerPricePoints)
      .where(eq(offerPricePoints.seriesId, series.id));
    expect(orphaned).toHaveLength(0);
  });
});

describe('deduplication, anchors and the counters that make them visible', () => {
  it('suppresses an identical re-read and COUNTS the suppression', async () => {
    const source = await bringUpSource('dedup');
    const { variantId } = await mintCanonicalVariant('dedup');
    // Pinned to NOON UTC, deliberately, rather than a bare `Date.now() - 3 *
    // DAY_MS` — this test writes three observations 60s and 120s apart and
    // then reads the write-metrics counters back by the CALENDAR DAY of the
    // first one. A bare wall-clock offset carries whatever time-of-day the
    // suite happens to run at, and within the last two minutes of a UTC day
    // the 120-second offset below crosses into the NEXT day's bucket,
    // splitting the count `findPriceWriteMetrics` reads back — the ingestion
    // contract suite's "safely later" literal, one layer over: here the
    // hazard is the CLOCK'S OWN position, not a fixed date drifting into the
    // past. Noon is twelve hours from either boundary, so the offsets below
    // can never cross one.
    const now = new Date();
    const first = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 12, 0, 0),
    );

    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `dedup-${RUN}`,
      amount: 7_500,
      currency: 'EUR',
      observedAt: first,
    });
    // A second reading of IDENTICAL terms, minutes later.
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `dedup-${RUN}`,
      amount: 7_500,
      currency: 'EUR',
      observedAt: new Date(first.getTime() + 60_000),
    });
    // And a third, with a price that MOVED.
    await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `dedup-${RUN}`,
      amount: 6_500,
      currency: 'EUR',
      observedAt: new Date(first.getTime() + 120_000),
    });

    const rows = await db
      .select({ amount: offerPriceSnapshots.itemPriceAmount, reasons: offerPriceSnapshots.changeReasons })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amount).sort()).toEqual([6_500, 7_500]);

    // The suppression left NO row, which is exactly why it needs a counter: a
    // domain whose dedup interval was accidentally zero would write three rows
    // and report perfectly healthy volume.
    const day = first.toISOString().slice(0, 10);
    const metrics = await findPriceWriteMetrics(day, source.sourceId);
    expect(metrics?.written).toBe(2);
    expect(metrics?.deduplicated).toBe(1);
  });

  it('records NOTHING and counts a refusal for an offer with no price', async () => {
    const source = await bringUpSource('nopriceX');
    const { variantId } = await mintCanonicalVariant('nopriceX');
    const observedAt = new Date(Date.now() - 2 * DAY_MS);
    const sourceRecordId = await mintSourceRecord(source.sourceId, `noprice-${RUN}`);

    const offerId = await recordExternalOffer({
      kind: 'informational',
      canonicalVariantId: variantId,
      merchantId: source.merchantId,
      sourceRecordId,
      sourceId: source.sourceId,
      provider: source.provider,
      externalOfferId: `noprice-${RUN}`,
      observedAt,
      staleAt: new Date(observedAt.getTime() + 30 * DAY_MS),
    });

    const rows = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId));
    expect(rows).toHaveLength(0);

    const metrics = await findPriceWriteMetrics(observedAt.toISOString().slice(0, 10), source.sourceId);
    expect(metrics?.refused).toBe(1);
    expect(metrics?.written).toBe(0);
  });
});

describe('the derived series', () => {
  it('rebuilds to BYTE-IDENTICAL output on the same data — acceptance 5', async () => {
    // TWO sources, because #57's `offers_active_commercial_key` allows ONE
    // active offer per (variant, merchant, storefront, condition) — two sellers
    // of one variant is the case, and one seller listing it twice is the case
    // that unique exists to refuse.
    const cheapSource = await bringUpSource('rebuild-a');
    const dearSource = await bringUpSource('rebuild-b');
    const { variantId, productId } = await mintCanonicalVariant('rebuild');
    const base = new Date(Date.now() - 6 * DAY_MS);

    const cheapOfferId = await observe({
      source: cheapSource,
      canonicalVariantId: variantId,
      externalOfferId: `rb-cheap-${RUN}`,
      amount: 4_000,
      currency: 'EUR',
      observedAt: base,
    });
    const dearOfferId = await observe({
      source: dearSource,
      canonicalVariantId: variantId,
      externalOfferId: `rb-dear-${RUN}`,
      amount: 9_000,
      currency: 'EUR',
      observedAt: base,
    });
    // The used one is the CHEAPEST thing on the product, and it must not become
    // the `new` series' answer — acceptance 2, over the real derivation.
    await seedObservation({
      offerId: cheapOfferId,
      amount: 4_000,
      currency: 'EUR',
      observedAt: base,
      conditionKey: 'used_good',
    });
    await seedObservation({
      offerId: dearOfferId,
      amount: 9_000,
      currency: 'EUR',
      observedAt: base,
      conditionKey: 'new',
    });

    await requestPriceSeriesRebuild(
      {
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        displayCurrency: 'EUR',
        granularity: 'day',
      },
      PRICE_HISTORY_POLICY_VERSION,
    );
    const series = await findPriceSeries({
      scopeKind: 'canonical_product',
      canonicalProductId: productId,
      displayCurrency: 'EUR',
      granularity: 'day',
    });
    expect(series).toBeDefined();
    if (!series) return;

    const rebuildOnce = async (): Promise<Record<string, unknown>[]> => {
      // Claiming is a QUEUE drain, not a lookup: `claimPriceSeriesRebuilds`
      // takes the due rows of the WHOLE table ordered by `available_at`, and
      // `UPDATE … RETURNING` returns them in no defined order. Other cases in
      // this file leave series pending — the variant case below says so in its
      // own comment — so neither "ours is index 0" nor "ours is in the first
      // batch" holds. Asserting position made this case fail roughly one run in
      // three, and it failed on whichever pull request happened to be unlucky
      // rather than on the one that changed anything.
      //
      // So: drain until this series has been claimed, rebuild every sibling the
      // drain took (leaving a stranded lease behind would break the next case
      // instead of this one), and assert on identity rather than on order.
      let claimed: Awaited<ReturnType<typeof claimPriceSeriesRebuilds>>[number] | undefined;
      for (let attempt = 0; attempt < 5 && !claimed; attempt += 1) {
        const batch = await claimPriceSeriesRebuilds({
          leaseOwner: `owner-${RUN}`,
          batchSize: 50,
          // A due row only. Both rebuilds claim the same series because the
          // completion re-arms it — the point of the exercise is that the
          // SECOND run writes the same rows, not that it is skipped.
          now: new Date(),
        });
        if (batch.length === 0) break;
        claimed = batch.find((row) => row.id === series.id);
        for (const row of batch) {
          if (row.id !== series.id) await rebuildPriceSeries(row, `owner-${RUN}`);
        }
      }
      expect(claimed?.id).toBe(series.id);
      if (!claimed) return [];
      const owned = await rebuildPriceSeries(claimed, `owner-${RUN}`);
      expect(owned).toBe(true);
      const rows = await db
        .select()
        .from(offerPricePoints)
        .where(eq(offerPricePoints.seriesId, series.id))
        .orderBy(offerPricePoints.bucketStart, offerPricePoints.measure, offerPricePoints.segment);
      // The row ID and its creation time change on every rebuild by
      // construction — a rebuild is a delete-then-insert — so the comparison is
      // over what the point SAYS, which is what acceptance 5 is about.
      return rows.map((row) => ({
        bucketStart: row.bucketStart.toISOString(),
        measure: row.measure,
        segment: row.segment,
        offerId: row.offerId,
        snapshotId: row.snapshotId,
        observedAt: row.observedAt.toISOString(),
        admittedFreshness: row.admittedFreshness,
        contributingObservationCount: row.contributingObservationCount,
        nativeAmount: row.nativeAmount,
        nativeCurrency: row.nativeCurrency,
        displayAmount: row.displayAmount,
        fxRate: row.fxRate,
      }));
    };

    const first = await rebuildOnce();
    expect(first.length).toBeGreaterThan(0);

    await requestPriceSeriesRebuild(
      {
        scopeKind: 'canonical_product',
        canonicalProductId: productId,
        displayCurrency: 'EUR',
        granularity: 'day',
      },
      PRICE_HISTORY_POLICY_VERSION,
    );
    const second = await rebuildOnce();
    expect(second).toEqual(first);

    // ACCEPTANCE 2, over the real path: the used offer is the cheapest thing on
    // the product and must NOT become the `new` series' answer.
    const bySegment = new Map(
      first
        .filter((point) => point['measure'] === 'lowest_item_price')
        .map((point) => [point['segment'], point['nativeAmount']]),
    );
    expect(bySegment.get('used')).toBe(4_000);
    expect(bySegment.get('new')).toBe(9_000);
  }, 60_000);

  it('keeps a stale offer out of the CURRENT price without losing its observations — acceptance 4', async () => {
    const source = await bringUpSource('stale');
    const { variantId, productId } = await mintCanonicalVariant('stale');
    const observedAt = new Date(Date.now() - 5 * DAY_MS);

    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `stale-${RUN}`,
      amount: 3_000,
      currency: 'EUR',
      observedAt,
    });

    const before = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId));
    expect(before).toHaveLength(1);

    await retireOffers(db, [offerId], 'source_disappeared');

    const after = await db
      .select({ id: offerPriceSnapshots.id })
      .from(offerPriceSnapshots)
      .where(eq(offerPriceSnapshots.offerId, offerId));
    // The observation survives the retirement, unchanged. Retirement writes no
    // observation of its own either — a point at the last known price on a day
    // nobody could buy the thing is the most misleading shape a chart has.
    expect(after).toEqual(before);

    const response = await readPriceHistory({
      scope: {
        kind: 'canonical_product',
        canonicalProductId: productId,
        displayCurrency: 'EUR',
        granularity: 'day',
      },
      measure: 'lowest_item_price',
      segment: 'new',
      from: new Date(observedAt.getTime() - DAY_MS).toISOString(),
      to: new Date().toISOString(),
    });
    // Nothing has been built for this product, so the whole range reads as
    // UNCOVERED and not as a gap — the distinction the coverage window exists
    // to make, and the one a renderer must not draw a line through.
    expect(response.points).toHaveLength(0);
    expect(response.gaps).toHaveLength(0);
    expect(response.uncovered.length).toBeGreaterThan(0);
    expect(response.currentOffer).toBeUndefined();
  }, 60_000);

  it('never shows one variant\'s low as another\'s — acceptance 3', async () => {
    const source = await bringUpSource('variants');
    const cheap = await mintCanonicalVariant('variant-cheap');
    const dear = await mintCanonicalVariant('variant-dear');
    const base = new Date(Date.now() - 4 * DAY_MS);

    const cheapOffer = await observe({
      source,
      canonicalVariantId: cheap.variantId,
      externalOfferId: `vc-${RUN}`,
      amount: 1_000,
      currency: 'EUR',
      observedAt: base,
    });
    const dearOffer = await observe({
      source,
      canonicalVariantId: dear.variantId,
      externalOfferId: `vd-${RUN}`,
      amount: 8_000,
      currency: 'EUR',
      observedAt: base,
    });
    await seedObservation({
      offerId: cheapOffer,
      amount: 1_000,
      currency: 'EUR',
      observedAt: base,
      conditionKey: 'new',
    });
    await seedObservation({
      offerId: dearOffer,
      amount: 8_000,
      currency: 'EUR',
      observedAt: base,
      conditionKey: 'new',
    });

    for (const variantId of [cheap.variantId, dear.variantId]) {
      await requestPriceSeriesRebuild(
        { scopeKind: 'canonical_variant', canonicalVariantId: variantId, displayCurrency: 'EUR', granularity: 'day' },
        PRICE_HISTORY_POLICY_VERSION,
      );
    }
    let claimed = await claimPriceSeriesRebuilds({ leaseOwner: `owner-v-${RUN}`, batchSize: 10 });
    for (const series of claimed) await rebuildPriceSeries(series, `owner-v-${RUN}`);
    // A second drain, because other cases in this file leave series pending and
    // one batch may not have reached both of these.
    claimed = await claimPriceSeriesRebuilds({ leaseOwner: `owner-v-${RUN}`, batchSize: 20 });
    for (const series of claimed) await rebuildPriceSeries(series, `owner-v-${RUN}`);

    const dearSeries = await findPriceSeries({
      scopeKind: 'canonical_variant',
      canonicalVariantId: dear.variantId,
      displayCurrency: 'EUR',
      granularity: 'day',
    });
    expect(dearSeries).toBeDefined();
    if (!dearSeries) return;

    const points = await listPricePoints({
      seriesId: dearSeries.id,
      measure: 'lowest_item_price',
      segment: 'new',
      from: new Date(base.getTime() - DAY_MS),
      to: new Date(),
    });
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.nativeAmount).toBe(8_000);
      expect(point.offerId).toBe(dearOffer);
    }
  }, 60_000);
});

describe('what the DTOs may never carry — acceptance 10', () => {
  it('a real emitted response contains no referral field anywhere in it', async () => {
    const source = await bringUpSource('dto');
    const { variantId, productId } = await mintCanonicalVariant('dto');
    const observedAt = new Date(Date.now() - 2 * DAY_MS);
    const offerId = await observe({
      source,
      canonicalVariantId: variantId,
      externalOfferId: `dto-${RUN}`,
      amount: 2_500,
      currency: 'EUR',
      observedAt,
    });
    await seedObservation({
      offerId,
      amount: 2_500,
      currency: 'EUR',
      observedAt,
      conditionKey: 'new',
    });

    const response = await readPriceHistory({
      scope: {
        kind: 'canonical_product',
        canonicalProductId: productId,
        displayCurrency: 'EUR',
        granularity: 'day',
      },
      measure: 'lowest_item_price',
      segment: 'new',
      from: new Date(observedAt.getTime() - DAY_MS).toISOString(),
      to: new Date().toISOString(),
    });

    // A RUNTIME walk of a real response, not a scan of the type: the static
    // gate catches a declared field and this catches one a serializer spread
    // in. Both are needed — #92's two-gate device.
    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          seen.add(key);
          walk(child);
        }
      }
    };
    walk(response);

    // The vacuity floor: a walk that found nothing would pass every assertion
    // below while proving the response was empty.
    expect(seen.size).toBeGreaterThan(10);
    for (const forbidden of PRICE_HISTORY_FORBIDDEN_DTO_FIELDS) {
      expect(seen.has(forbidden), `the response carries \`${forbidden}\``).toBe(false);
    }

    // And the standing statement that a converted figure is not a way to pay.
    expect(response.notice.conversionIsDisplayOnly).toBe(true);
    expect(response.notice.supportedCheckoutRail).toBeNull();

    // The operator trace opens from an OFFER and returns observations, not
    // people: there is no buyer, session or merchant-account handle in it.
    const trace = await tracePriceHistoryForOffer(offerId);
    expect(trace.observations.length).toBeGreaterThan(0);
    const traceKeys = new Set<string>();
    walk2(trace, traceKeys);
    for (const forbidden of PRICE_HISTORY_FORBIDDEN_DTO_FIELDS) {
      expect(traceKeys.has(forbidden)).toBe(false);
    }
  }, 60_000);
});

/** The same walk, as a named function so both cases read the same. */
function walk2(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walk2(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      walk2(child, into);
    }
  }
}

describe('the write metrics are per SOURCE and per DAY', () => {
  it('keys on the generated bucket key so a native row cannot duplicate', async () => {
    const source = await bringUpSource('metricsX');
    const day = new Date().toISOString().slice(0, 10);

    // The NULL-source row is what a plain `UNIQUE(bucket_day, source_id)` would
    // admit twice, because Postgres treats NULLs as distinct. The generated
    // `metric_key` collapses them, and this is the fixture that tells the two
    // spellings apart.
    await db
      .insert(offerPriceWriteMetrics)
      .values({ bucketDay: day, sourceId: null, written: 1 })
      .onConflictDoUpdate({
        target: offerPriceWriteMetrics.metricKey,
        set: { written: sql`${offerPriceWriteMetrics.written} + excluded.written` },
      });
    await db
      .insert(offerPriceWriteMetrics)
      .values({ bucketDay: day, sourceId: null, written: 1 })
      .onConflictDoUpdate({
        target: offerPriceWriteMetrics.metricKey,
        set: { written: sql`${offerPriceWriteMetrics.written} + excluded.written` },
      });

    const rows = await db
      .select({ written: offerPriceWriteMetrics.written })
      .from(offerPriceWriteMetrics)
      .where(
        and(
          eq(offerPriceWriteMetrics.bucketDay, day),
          sql`${offerPriceWriteMetrics.sourceId} is null`,
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.written).toBeGreaterThanOrEqual(2);
    await db
      .delete(offerPriceWriteMetrics)
      .where(
        and(
          eq(offerPriceWriteMetrics.bucketDay, day),
          sql`${offerPriceWriteMetrics.sourceId} is null`,
        ),
      );
    expect(source.sourceId).toBeTruthy();
  });
});
