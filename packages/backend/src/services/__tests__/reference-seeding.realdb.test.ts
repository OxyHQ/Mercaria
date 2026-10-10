/**
 * ADR 0014 end to end, on a real Postgres server: a reference catalogue seeds
 * a product, a price feed's offer attaches to it, and the product goes live.
 *
 * The shape is the production one, with fixture adapters in place of the
 * network:
 *
 * 1. A REFERENCE source (Open Food Facts' shape: a `product` record with a
 *    GTIN, no merchant) granted `seed_catalog`, and a PRICE source (Open
 *    Prices' shape: an `offer` record carrying only the GTIN, bound to a
 *    retailer, no outbound link) without it, are both ingested. The matcher
 *    finds nothing for the GTIN and records `create_new` for both.
 * 2. `reference_products` in DRY RUN reports the mint and writes nothing.
 * 3. `reference_products` APPLIED mints one draft product holding the GTIN —
 *    from the reference object only; the price object is never examined.
 * 4. `source_readvance` re-asks the matcher: both objects attach, and the
 *    price object materializes an `informational` offer with its price.
 * 5. `reference_promotion` makes the product `active`.
 *
 * Every assertion is scoped to rows this file created: the database is shared
 * with every other realdb file.
 */

import './fixtures/enable-canonical-writes.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { CatalogBackfillMode, CatalogBackfillStage } from '@mercaria/shared-types';
import { fixtureGtin } from '../../__tests__/fixture-gtin.js';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';
import { openSourceRun } from '../../db/ingestion/catalogSourceRunRepository.js';
import { listGtinDemand } from '../../db/ingestion/catalogSourceObjectRepository.js';
import { insertMatchPolicyVersion } from '../../db/matching/matchPolicyRepository.js';
import { catalogBackfillRecords, catalogBackfillRuns } from '../../db/schema/backfill.js';
import {
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariants,
  canonicalVariantSourceLinks,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
import {
  catalogSourceConfigs,
  catalogSourceObjects,
  catalogSourcePolicies,
  catalogSourceRejections,
  catalogSourceRuns,
} from '../../db/schema/ingestion.js';
import { matchDecisions, matchPolicyVersions } from '../../db/schema/matching.js';
import { merchants } from '../../db/schema/merchants.js';
import { offers } from '../../db/schema/offers.js';
import { catalogSourceDistributions, catalogSourceRunQuarantines } from '../../db/schema/offerFreshness.js';
import { offerPriceSnapshots } from '../../db/schema/priceHistory.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { openCatalogBackfillRun, runCatalogBackfillPage } from '../backfill/backfill.service.js';
import { ALL_COHORT } from '../backfill/cohort.js';
import { createFixtureAdapter } from '../ingestion/adapters/fixture.js';
import type { AdapterRecord } from '../ingestion/adapter.js';
import { runIngestionPage } from '../ingestion/ingest.service.js';
import { resolveOfferSources } from '../product-page/sources.js';
import type { Offer } from '@mercaria/shared-types';
import { registerCatalogSourceAdapter, unregisterCatalogSourceAdapter } from '../ingestion/registry.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import { acquireActivePolicySlot, type ActivePolicySlot } from '../ingestion/__tests__/active-policy-slot.js';

/** The active-policy slot can wait behind a sibling file; see `active-policy-slot.ts`. */
const POLICY_CASE_TIMEOUT_MS = 90_000;

const RUN = uuidv7().slice(-12);
const OPERATOR = `operator-seed-${RUN}`;
const GTIN = fixtureGtin(`reference-seeding-${RUN}`, 1);
const NAME = `Tomate triturado ${RUN}`;

let db: Database;
let policySlot: ActivePolicySlot | undefined;
const createdSourceIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdPolicyIds: string[] = [];
const createdBackfillRunIds: string[] = [];
const registeredProviders: string[] = [];

const FULL_RIGHTS = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 3_600,
  mayDisplayPrice: true,
  mayDisplayMedia: true,
  mayLinkOut: true,
  mayAppendAffiliateParams: false,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'disallowed' as const,
  attributionRequired: true,
};

const OBSERVED = new Date('2026-09-01T10:00:00.000Z');

const referenceRecord: AdapterRecord = {
  externalType: 'product',
  externalId: GTIN,
  observedAt: OBSERVED,
  raw: { code: GTIN },
  normalized: {
    title: NAME,
    description: 'Tomate triturado en lata',
    brandHint: 'Hacendado',
    identifiers: [{ scheme: 'gtin', value: GTIN }],
    options: [],
    media: [],
    facts: [{ key: 'openfacts.nutriscore_grade', value: 'b' }],
  },
};

/** The day somebody saw the price on the shelf — the source's own timestamp. */
const SIGHTED = new Date('2026-08-28T00:00:00.000Z');

const priceRecord: AdapterRecord = {
  externalType: 'offer',
  externalId: GTIN,
  observedAt: OBSERVED,
  sourceUpdatedAt: SIGHTED,
  raw: { priceId: 1 },
  normalized: {
    // Open Prices' shape: more than half its prices carry no name.
    title: GTIN,
    identifiers: [{ scheme: 'gtin', value: GTIN }],
    options: [],
    media: [],
    merchantHint: 'Mercadona',
    price: { amount: 89, currency: 'EUR' },
    conditionLabel: 'new',
    country: 'ES',
    sourceUrl: `https://prices.openfoodfacts.org/products/${GTIN}`,
    facts: [{ key: 'open_prices.sightings', value: 2 }],
  },
};

let referenceSourceId = '';
let priceSourceId = '';
let priceMerchantId = '';

async function bringUpSource(input: {
  label: string;
  kind: 'feed' | 'marketplace_api';
  record: AdapterRecord;
  merchantId?: string;
  rights: Partial<typeof FULL_RIGHTS> & { maySeedCatalog?: boolean };
}): Promise<string> {
  const provider = `seed_${input.label}_${RUN}`.toLowerCase();
  registerCatalogSourceAdapter(createFixtureAdapter({ provider, kind: input.kind, pages: [[input.record]] }));
  registeredProviders.push(provider);
  const resolved = await configureIngestionSource({
    name: `Reference seeding ${input.label} ${RUN}`,
    kind: input.kind,
    provider,
    ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
    freshnessTtlSeconds: 30 * 24 * 3_600,
    pageSize: 50,
  });
  const sourceId = resolved.source.config.sourceId;
  createdSourceIds.push(sourceId);
  await publishIngestionSourcePolicy({ sourceId, reviewedByOxyUserId: OPERATOR, ...FULL_RIGHTS, ...input.rights });
  await changeIngestionSourceStatus({ sourceId, status: 'active', actorOxyUserId: OPERATOR, reason: 'reference seeding test' });
  return sourceId;
}

/** Drive one full pass, claiming each page the way the dispatcher does. */
async function ingest(sourceId: string): Promise<void> {
  const run = await openSourceRun(db, {
    sourceId,
    kind: 'manual',
    refreshMode: 'full_snapshot',
    since: null,
    requestedByOxyUserId: OPERATOR,
    now: OBSERVED,
  });
  const leaseOwner = `seed-${RUN}`;
  for (let page = 0; page < 5; page += 1) {
    await db
      .update(catalogSourceRuns)
      .set({
        status: 'running',
        leaseOwner,
        leaseUntil: new Date(Date.now() + 120_000),
        startedAt: sql`coalesce(${catalogSourceRuns.startedAt}, now())`,
      })
      .where(and(eq(catalogSourceRuns.id, run.id), inArray(catalogSourceRuns.status, ['pending', 'running'])));
    const result = await runIngestionPage({ runId: run.id, leaseOwner });
    if (result.outcome !== null || result.skipped !== null) break;
  }
}

/** Open a backfill run and page it to completion. */
async function backfill(stage: CatalogBackfillStage, mode: CatalogBackfillMode): Promise<string> {
  const { run } = await openCatalogBackfillRun({ stage, mode, cohort: ALL_COHORT, requestedByOxyUserId: OPERATOR });
  createdBackfillRunIds.push(run.id);
  for (let page = 0; page < 200; page += 1) {
    const result = await runCatalogBackfillPage(run.id, { limit: 200 });
    if (result === undefined || result.nextCursor === null) break;
  }
  return run.id;
}

async function objectOf(sourceId: string) {
  const [object] = await db.select().from(catalogSourceObjects).where(eq(catalogSourceObjects.sourceId, sourceId));
  return object;
}

async function recordFor(runId: string, sourceObjectId: string) {
  const [record] = await db
    .select()
    .from(catalogBackfillRecords)
    .where(and(eq(catalogBackfillRecords.runId, runId), eq(catalogBackfillRecords.subjectKey, `source_object:${sourceObjectId}`)));
  return record;
}

async function seededProducts() {
  return db.select().from(canonicalProducts).where(like(canonicalProducts.slug, `%-${GTIN}`));
}

beforeAll(async () => {
  db = await connectPostgres();
  policySlot = await acquireActivePolicySlot(db);
  const policy = await insertMatchPolicyVersion(db, {
    versionKey: `reference-seeding-${RUN}`,
    status: 'active',
    description: 'reference seeding fixture',
    autoMinConfidence: 0.5,
    reviewMinConfidence: 0.2,
    minCandidateSeparation: 0.01,
    maxCandidates: 25,
    minTitleSimilarity: 0.1,
    weightIdentifier: 6,
    weightBrand: 3,
    weightModel: 2,
    weightAttribute: 4,
    weightTitle: 1,
    weightCategory: 2,
    weightSemantic: 0,
    semanticEnabled: false,
    minBenchmarkPrecision: 0.98,
    minBenchmarkSamples: 20,
    createdByOxyUserId: OPERATOR,
    activatedAt: new Date(),
  });
  createdPolicyIds.push(policy.id);

  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Mercadona ${RUN}`, slug: `mercadona-seed-${RUN}` })
    .returning({ id: merchants.id });
  if (merchant === undefined) throw new Error('merchant insert returned no row');
  priceMerchantId = merchant.id;
  createdMerchantIds.push(merchant.id);

  referenceSourceId = await bringUpSource({
    label: 'reference',
    kind: 'marketplace_api',
    record: referenceRecord,
    rights: { maySeedCatalog: true },
  });
  priceSourceId = await bringUpSource({
    label: 'prices',
    kind: 'feed',
    record: priceRecord,
    merchantId: priceMerchantId,
    // No retailer page to send anyone to: the offer is informational.
    rights: { mayLinkOut: false },
  });
  await ingest(referenceSourceId);
  await ingest(priceSourceId);
}, POLICY_CASE_TIMEOUT_MS);

afterAll(async () => {
  try {
    for (const provider of registeredProviders) unregisterCatalogSourceAdapter(provider);
    const products = await seededProducts();
    const productIds = products.map((product) => product.id);
    const variantIds = productIds.length === 0
      ? []
      : (await db.select({ id: canonicalVariants.id }).from(canonicalVariants).where(inArray(canonicalVariants.productId, productIds))).map((row) => row.id);
    const safe = (ids: readonly string[]) => (ids.length === 0 ? ['00000000-0000-0000-0000-000000000000'] : [...ids]);

    await db.delete(catalogBackfillRecords).where(inArray(catalogBackfillRecords.runId, safe(createdBackfillRunIds)));
    await db.delete(catalogBackfillRuns).where(inArray(catalogBackfillRuns.id, safe(createdBackfillRunIds)));
    await db.delete(catalogSourceObjects).where(inArray(catalogSourceObjects.sourceId, safe(createdSourceIds)));
    const ownOffers = (await db.select({ id: offers.id }).from(offers).where(inArray(offers.merchantId, safe(createdMerchantIds)))).map((row) => row.id);
    await db.delete(offerPriceSnapshots).where(inArray(offerPriceSnapshots.offerId, safe(ownOffers)));
    await db.delete(offers).where(inArray(offers.id, safe(ownOffers)));
    await db.delete(catalogSourceRejections).where(inArray(catalogSourceRejections.sourceId, safe(createdSourceIds)));
    await db.delete(catalogSourceRunQuarantines).where(inArray(catalogSourceRunQuarantines.sourceId, safe(createdSourceIds)));
    await db.delete(catalogSourceDistributions).where(inArray(catalogSourceDistributions.sourceId, safe(createdSourceIds)));
    await db.delete(catalogSourceRuns).where(inArray(catalogSourceRuns.sourceId, safe(createdSourceIds)));
    await db.delete(canonicalVariantSourceLinks).where(inArray(canonicalVariantSourceLinks.variantId, safe(variantIds)));
    await db.delete(canonicalProductSourceLinks).where(inArray(canonicalProductSourceLinks.productId, safe(productIds)));
    await db.delete(productIdentifiers).where(inArray(productIdentifiers.variantId, safe(variantIds)));
    const ownRecordIds = (await db.select({ id: sourceRecords.id }).from(sourceRecords).where(inArray(sourceRecords.sourceId, safe(createdSourceIds)))).map((row) => row.id);
    await db.delete(matchDecisions).where(inArray(matchDecisions.sourceRecordId, safe(ownRecordIds)));
    await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safe(createdSourceIds)));
    await db.delete(catalogSourceConfigs).where(inArray(catalogSourceConfigs.sourceId, safe(createdSourceIds)));
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`);
      await tx.delete(catalogSourcePolicies).where(inArray(catalogSourcePolicies.sourceId, safe(createdSourceIds)));
      await tx.execute(sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`);
    });
    await db.delete(catalogSources).where(inArray(catalogSources.id, safe(createdSourceIds)));
    await deleteTestCanonicalRows(db, { productIds, variantIds });
    await db.delete(merchants).where(inArray(merchants.id, safe(createdMerchantIds)));
    const stillCited = (await db.select({ id: matchDecisions.id }).from(matchDecisions).where(inArray(matchDecisions.policyVersionId, safe(createdPolicyIds))).limit(1)).length;
    if (stillCited === 0) {
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(sql`alter table match_policy_versions disable trigger match_policy_versions_immutable`);
        await tx.delete(matchPolicyVersions).where(inArray(matchPolicyVersions.id, safe(createdPolicyIds)));
        await tx.execute(sql`alter table match_policy_versions enable trigger match_policy_versions_immutable`);
      });
    }
  } finally {
    try {
      await policySlot?.release();
    } finally {
      await closePostgres();
    }
  }
}, POLICY_CASE_TIMEOUT_MS);

describe('ADR 0014: a reference catalogue seeds the product a price attaches to', () => {
  it('leaves both objects unmatched with the matcher recommending create_new', async () => {
    for (const sourceId of [referenceSourceId, priceSourceId]) {
      const object = await objectOf(sourceId);
      expect(object?.state, `source ${sourceId}`).toBe('unmatched');
      const [decision] = await db.select().from(matchDecisions).where(eq(matchDecisions.id, object?.lastMatchDecisionId ?? ''));
      expect(decision?.outcome).toBe('create_new');
    }
    // The structured facts survived into the stored payload.
    const reference = await objectOf(referenceSourceId);
    const [observation] = await db.select().from(sourceRecords).where(eq(sourceRecords.id, reference?.currentSourceRecordId ?? ''));
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: in a test, a missing row throwing here is the failure we want
    expect((observation?.payload as { facts?: unknown }).facts).toEqual([{ key: 'openfacts.nutriscore_grade', value: 'b' }]);
  });

  it('reads the unmatched GTIN as DEMAND for any source that does not hold it', async () => {
    // Just below this file's GTIN, so siblings' demand cannot push it past the limit.
    const after = (BigInt(GTIN) - 1n).toString().padStart(GTIN.length, '0');
    const forStranger = await listGtinDemand(db, { askingSourceId: `nobody-${RUN}`, after, limit: 50 });
    expect(forStranger).toContain(GTIN);
    // The reference source already holds an object under it: no demand for it.
    const forReference = await listGtinDemand(db, { askingSourceId: referenceSourceId, after, limit: 50 });
    expect(forReference).not.toContain(GTIN);
  });

  it('a DRY RUN reports the mint and writes nothing', async () => {
    const runId = await backfill('reference_products', 'dry_run');
    const reference = await objectOf(referenceSourceId);
    const record = await recordFor(runId, reference?.id ?? '');
    expect(record?.reasonCode).toBe('reference_product_minted');
    expect(record?.canonicalProductId).toBeNull();
    expect(await seededProducts()).toEqual([]);
  });

  it('APPLY mints one draft holding the GTIN, from the seeding source only', async () => {
    const runId = await backfill('reference_products', 'apply');
    const reference = await objectOf(referenceSourceId);
    const price = await objectOf(priceSourceId);
    const record = await recordFor(runId, reference?.id ?? '');
    expect(record?.reasonCode).toBe('reference_product_minted');
    // A source without the right is never examined, whatever its matcher said.
    expect(await recordFor(runId, price?.id ?? '')).toBeUndefined();

    const products = await seededProducts();
    expect(products).toHaveLength(1);
    expect(products[0]?.status).toBe('draft');
    expect(products[0]?.name).toBe(NAME);
    expect(record?.canonicalProductId).toBe(products[0]?.id);

    const identifiers = await db
      .select()
      .from(productIdentifiers)
      .where(and(eq(productIdentifiers.variantId, record?.canonicalVariantId ?? ''), eq(productIdentifiers.status, 'active')));
    expect(identifiers).toHaveLength(1);
    expect(identifiers[0]?.sourceRecordId).toBe(reference?.currentSourceRecordId);

    // The stage links nothing and moves no object: attaching is the matcher's.
    expect((await objectOf(referenceSourceId))?.state).toBe('unmatched');
  });

  it('a second APPLY run converges on the same product', async () => {
    await backfill('reference_products', 'apply');
    expect(await seededProducts()).toHaveLength(1);
  });

  it('source_readvance attaches both objects and materializes the informational offer', async () => {
    const runId = await backfill('source_readvance', 'apply');
    const price = await objectOf(priceSourceId);
    const reference = await objectOf(referenceSourceId);
    expect((await recordFor(runId, price?.id ?? ''))?.reasonCode).toBe('readvance_matched');
    expect((await recordFor(runId, reference?.id ?? ''))?.reasonCode).toBe('readvance_matched');

    // The reference source is bound to no merchant, so it attaches and stops.
    expect(reference?.state).toBe('matched');
    expect(price?.state).toBe('offer_current');
    const [offer] = await db.select().from(offers).where(eq(offers.id, price?.offerId ?? ''));
    expect(offer?.kind).toBe('informational');
    expect(offer?.merchantId).toBe(priceMerchantId);
    expect(offer?.priceAmount).toBe(89);
    expect(offer?.priceCurrency).toBe('EUR');
  });

  it('names an open-data source and the day it saw the price', async () => {
    const price = await objectOf(priceSourceId);
    // The provenance an Open Prices offer carries; this fixture's own provider
    // slug is not an open-data provider, so the row would name nothing.
    const offer = {
      id: price?.offerId ?? '',
      provenance: { provider: 'open_prices', sourceRecordId: price?.currentSourceRecordId ?? undefined },
    } as unknown as Offer;
    const sources = await resolveOfferSources([offer], db);
    expect(sources.get(offer.id)).toEqual({
      name: 'Open Prices',
      homepage: 'https://prices.openfoodfacts.org',
      licence: 'odbl_1_0',
      licenceLabel: 'ODbL 1.0',
      observedAt: SIGHTED.toISOString(),
    });
    const unnamed = { id: 'x', provenance: { provider: 'ebay_browse' } } as unknown as Offer;
    expect((await resolveOfferSources([unnamed], db)).size).toBe(0);
  });

  it('reference_promotion makes the seeded product active', async () => {
    const runId = await backfill('reference_promotion', 'apply');
    const [product] = await seededProducts();
    const [record] = await db
      .select()
      .from(catalogBackfillRecords)
      .where(and(eq(catalogBackfillRecords.runId, runId), eq(catalogBackfillRecords.subjectKey, `canonical_product:${product?.id ?? ''}`)));
    expect(record?.reasonCode).toBe('reference_product_promoted');
    expect(product?.status).toBe('active');
  });
});
