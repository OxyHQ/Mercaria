/**
 * #68 acceptance 1 — a transient source outage does not remove every prior
 * offer — against a real PostgreSQL server, on a database this file OWNS.
 *
 * ## Why this describe does not live with the rest of #68's suite
 *
 * `sweepExpiredOffers` is GLOBAL by design: it reads every lapsed external
 * offer in the database, resolves each one's source contract and retires what
 * that contract says is past retirement. There is no scoping predicate and none
 * may be added — a freshness rule with two spellings is the disagreement the
 * whole domain exists to prevent.
 *
 * The grace case then has to advance the clock past the outage window, so it
 * sweeps with a clock THREE HOURS in the future. Run against the one throwaway
 * database a suite run shares, that retires other files' offers: measured on
 * `origin/main` as `ebay-ingestion.realdb.test.ts` failing 1 run in 3 with
 * `expected 'source_unavailable' to be … Received: "source_expired"`, because
 * this sweep is the only non-test writer of `source_expired`. Which file it
 * lands on is decided by vitest's file order, which is by SIZE — so adding any
 * test anywhere reshuffles the victim, and the failure always names a file that
 * did nothing wrong.
 *
 * So the sweep gets its own database. Nothing else in #68's suite does, and
 * nothing else needs to: every other case reads and writes rows it identifies.
 *
 * ## It deliberately does NOT connect the singleton
 *
 * There is no `connectPostgres()` here. Every call below is handed this file's
 * own handle, and anything that reached for `getDb()` instead would throw
 * `PostgreSQL is not connected` rather than quietly reading the SHARED
 * database. That matters more than it looks: a fixture that half-migrated to a
 * private database is strictly worse than the bug it was fixing, because the
 * sweep then examines an empty database, finds nothing, retires nothing, and
 * every assertion about what survived passes having measured nothing. Making
 * that mistake LOUD is the point of leaving the singleton unopened.
 *
 * `expect(result.examined).toBeGreaterThanOrEqual(1)` is the same guard one
 * level down, for the case where the handle is right and the FIXTURE stopped
 * producing a candidate: "swept 0 of 0" and "swept 0 of 5" must not both be
 * green.
 *
 * ## Teardown is dropping the database
 *
 * No delete cascade, and in particular no `alter table … disable trigger`
 * window — that statement is database-wide, so on the shared database it has to
 * be taken under an advisory lock against every other file doing the same. Here
 * the policy rows are frozen by their triggers, nobody deletes them, and the
 * whole database goes at the end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, uuidv7 } from '@oxyhq/db';
import type postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import type { Database } from '../../db/postgres.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../../db/testDatabase.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import { publishFreshnessPolicy } from '../../db/offerFreshness/freshnessPolicyRepository.js';
import { recordSourceHealth } from '../../db/ingestion/catalogSourceConfigRepository.js';
import { listOffers, recordExternalOffer } from '../offers/offer.service.js';
import { findOfferById } from '../../db/offers/offerRepository.js';
import { sweepExpiredOffers } from '../offer-freshness/expiry-sweep.js';

/** Server to create the throwaway on — the same variable `globalSetup` reads. */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

const OPERATOR = 'freshness-sweep-operator';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

/** One canonical product plus its one variant — what an offer must point at. */
async function mintCanonicalVariant(label: string): Promise<{ variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Freshness ${label}`,
      normalizedName: `freshness ${label}`,
      slug: `freshness-${label}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      // A sha-256-shaped digest; `canonical_variants_signature_shape_check`
      // refuses anything else and the value only has to be unique per product.
      signature: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the canonical variant was not written');
  return { variantId: variant.id };
}

async function mintMerchant(label: string): Promise<string> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Freshness ${label}`, slug: `freshness-${label}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('the merchant was not written');
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
      payload: { price: 1_999 },
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return record.id;
}

/** Rights granting everything, so a case is about freshness and nothing else. */
const FULL_RIGHTS = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 86_400,
  mayDisplayPrice: true,
  mayDisplayMedia: true,
  mayLinkOut: true,
  mayAppendAffiliateParams: true,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'disallowed' as const,
  attributionRequired: true,
};

/**
 * Configure, permit and activate a source the way an operator would.
 *
 * Every one of these three takes this file's handle explicitly. They are the
 * reason the trailing `db` parameter was added to `source.service.ts`: without
 * it they write to the singleton, the source lands in the SHARED database, and
 * `publishFreshnessPolicy` below fails its foreign key against a source that
 * does not exist here — loudly, which is the good case.
 */
async function bringUpSource(
  label: string,
): Promise<{ sourceId: string; provider: string; merchantId: string }> {
  const provider = `freshness-sweep-${label}`;
  const merchantId = await mintMerchant(label);
  const resolved = await configureIngestionSource(
    {
      name: `Freshness sweep source ${label}`,
      kind: 'feed',
      provider,
      merchantId,
      fetchCadenceSeconds: 3_600,
      freshnessTtlSeconds: 3_600,
      pageSize: 50,
    },
    db,
  );
  const sourceId = resolved.source.config.sourceId;
  await publishIngestionSourcePolicy(
    { sourceId, reviewedByOxyUserId: OPERATOR, ...FULL_RIGHTS },
    new Date(),
    db,
  );
  await changeIngestionSourceStatus(
    {
      sourceId,
      status: 'active',
      actorOxyUserId: OPERATOR,
      reason: 'offer freshness acceptance suite',
    },
    new Date(),
    db,
  );
  return { sourceId, provider, merchantId };
}

/** Publish a freshness contract with distinct thresholds, so none is ambiguous. */
async function publishFreshness(sourceId: string): Promise<void> {
  await publishFreshnessPolicy(db, {
    sourceId,
    expectedRefreshIntervalSeconds: 3_600,
    warningAfterSeconds: 1_800,
    expiryAfterSeconds: 3_600,
    outageGraceSeconds: 7_200,
    retireOnSourceUnavailable: true,
    permittedRefreshModes: [],
    anomalyMinimumSampleSize: 4,
    anomalyZeroPriceShareBps: 5_000,
    anomalyPriceScaleFactor: 10,
    anomalyDisappearanceShareBps: 5_000,
    reviewNote: null,
    reviewedByOxyUserId: OPERATOR,
    now: new Date(),
  });
}

/**
 * One external offer for a variant, observed `agoSeconds` ago.
 *
 * Do NOT add a condition here without giving `mapSourceCondition` a handle:
 * `recordExternalOffer` reaches it only when the observation carries a
 * `conditionMappingProvider`, and it takes no database parameter, so it would
 * read its rulesets off the unopened singleton. Everything else this function
 * touches is threaded with the handle below.
 */
async function seedOffer(input: {
  sourceId: string;
  merchantId: string;
  variantId: string;
  externalOfferId: string;
  provider: string;
  agoSeconds: number;
}): Promise<string> {
  const sourceRecordId = await mintSourceRecord(input.sourceId, input.externalOfferId);
  const observedAt = new Date(Date.now() - input.agoSeconds * 1_000);
  return recordExternalOffer(
    {
      kind: 'external',
      canonicalVariantId: input.variantId,
      merchantId: input.merchantId,
      sourceRecordId,
      provider: input.provider,
      externalOfferId: input.externalOfferId,
      destinationUrl: `https://example.test/${input.externalOfferId}`,
      price: { amount: 1_999, currency: 'EUR' },
      availability: 'in_stock',
      observedAt,
      // The stored deadline is the PRE-FILTER; the live policy is the
      // authority. Both are stamped from the same contract here.
      staleAt: new Date(observedAt.getTime() + 3_600_000),
    },
    observedAt,
    db,
  );
}

describe('acceptance 1 — a transient source outage does not remove every prior offer', () => {
  it('withholds retirement during the grace, and retires once it passes', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('outage');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('outage');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: 'outage',
      // Two hours: past the one-hour expiry, inside the two-hour grace.
      agoSeconds: 7_200,
    });

    /**
     * The positive control for the emptiness assertion further down.
     *
     * `expect(page.offers).toHaveLength(0)` is exactly as true of an offer the
     * freshness derivation refused as it is of a database this reader cannot
     * see — so a CURRENT offer, on its own variant, read through the same call,
     * is what tells those two apart. Its own variant because
     * `offers_active_commercial_key` permits one active offer per (variant,
     * seller, channel, condition).
     */
    const control = await mintCanonicalVariant('outage-control');
    await seedOffer({
      sourceId,
      merchantId,
      variantId: control.variantId,
      provider,
      externalOfferId: 'outage-control',
      agoSeconds: 60,
    });

    // The source is DOWN, not broken: a fetch failure, which is the only class
    // that earns grace.
    await recordSourceHealth(db, {
      sourceId,
      healthState: 'source_outage',
      status: 'failed',
      succeeded: false,
      fetchDurationMs: 0,
      rateLimitHits: 0,
      error: 'connection reset',
      nextRunAt: new Date(),
      now: new Date(),
    });

    const duringOutage = await sweepExpiredOffers(new Date(), db);
    // The floor: a pass that examined nothing withholds nothing for the same
    // reason it retires nothing, and both read as success.
    expect(duringOutage.examined).toBeGreaterThanOrEqual(1);
    expect(duringOutage.withheld).toBeGreaterThanOrEqual(1);
    const survived = await findOfferById(db, offerId);
    expect(survived?.status).toBe('active');

    const controlPage = await listOffers({ canonicalVariantId: control.variantId, limit: 10 }, db);
    expect(controlPage.offers).toHaveLength(1);

    // …and the offer under test is ALREADY invisible, which is what makes the
    // grace safe: the catalogue is kept, and nothing old is presented as fresh.
    const page = await listOffers({ canonicalVariantId: variantId, limit: 10 }, db);
    expect(page.offers).toHaveLength(0);

    // Past the grace, the same sweep retires it.
    const later = new Date(Date.now() + 3 * 3_600_000);
    const afterGrace = await sweepExpiredOffers(later, db);
    expect(afterGrace.examined).toBeGreaterThanOrEqual(1);
    expect(afterGrace.retired).toBeGreaterThanOrEqual(1);
    const retired = await findOfferById(db, offerId);
    expect(retired?.status).toBe('retired');
    expect(retired?.retirementReason).toBe('source_expired');
  });

  it('a RIGHTS SUSPENSION earns no grace — the exclusion that matters', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('suspended');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('suspended');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: 'suspended',
      agoSeconds: 7_200,
    });
    await recordSourceHealth(db, {
      sourceId,
      healthState: 'rights_suspended',
      status: 'active',
      succeeded: false,
      fetchDurationMs: 0,
      rateLimitHits: 0,
      error: null,
      nextRunAt: new Date(),
      now: new Date(),
    });

    // A withdrawn right is a decision to STOP showing the data, so extending
    // its life is precisely what the grace must never do.
    const result = await sweepExpiredOffers(new Date(), db);
    expect(result.examined).toBeGreaterThanOrEqual(1);
    expect(result.retired).toBeGreaterThanOrEqual(1);
    expect((await findOfferById(db, offerId))?.status).toBe('retired');
  });
});
