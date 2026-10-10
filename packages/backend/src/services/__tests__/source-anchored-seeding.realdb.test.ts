/**
 * ADR 0016 end to end: a source with no GTIN seeds products by its OWN product
 * key, and keeps them attached when a price moves.
 *
 * One source (a Scryfall-shaped card source) granted `seed_catalog` and bound to
 * a merchant publishes one card in two finishes. `reference_products` mints ONE
 * draft with two variants, anchors both observations and re-advances them, so
 * both offers materialize; `reference_promotion` activates it. A later delivery
 * with a new price is attached by the matcher's existing-link stage and moves the
 * offer instead of orphaning it.
 */

import './fixtures/enable-canonical-writes.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { CatalogBackfillMode, CatalogBackfillStage } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';
import { openSourceRun } from '../../db/ingestion/catalogSourceRunRepository.js';
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
const OPERATOR = `operator-anchor-${RUN}`;

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

const OBSERVED = new Date('2025-05-01T10:00:00.000Z');
const LATER = new Date('2025-05-02T10:00:00.000Z');
const CARD_ID = `card-${RUN}`;
const NAME = `Lightning Bolt ${RUN}`;

function cardRecord(finish: 'Nonfoil' | 'Foil', amount: number, observedAt: Date): AdapterRecord {
  return {
    externalType: 'offer',
    externalId: `${CARD_ID}:${finish.toLowerCase()}`,
    observedAt,
    raw: { id: CARD_ID, finish, amount },
    normalized: {
      title: NAME,
      identifiers: [],
      options: [{ name: 'Finish', value: finish }],
      productGroupKey: CARD_ID,
      media: [],
      merchantHint: 'Cardmarket',
      price: { amount, currency: 'EUR' },
      facts: [{ key: 'scryfall.rarity', value: 'common' }],
    },
  };
}

let cardSourceId = '';
let cardProvider = '';
let priceMerchantId = '';

async function bringUpSource(input: {
  label: string;
  kind: 'feed' | 'marketplace_api';
  pages: AdapterRecord[][];
  merchantId?: string;
  rights: Partial<typeof FULL_RIGHTS> & { maySeedCatalog?: boolean };
}): Promise<string> {
  const provider = `anchor_${input.label}_${RUN}`.toLowerCase();
  registerCatalogSourceAdapter(createFixtureAdapter({ provider, kind: input.kind, pages: input.pages }));
  registeredProviders.push(provider);
  cardProvider = provider;
  const resolved = await configureIngestionSource({
    name: `Anchored seeding ${input.label} ${RUN}`,
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
async function ingest(sourceId: string, now: Date): Promise<void> {
  const run = await openSourceRun(db, {
    sourceId,
    kind: 'manual',
    refreshMode: 'full_snapshot',
    since: null,
    requestedByOxyUserId: OPERATOR,
    now,
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

async function objectsOf(sourceId: string) {
  return db.select().from(catalogSourceObjects).where(eq(catalogSourceObjects.sourceId, sourceId)).orderBy(catalogSourceObjects.externalId);
}

async function recordFor(runId: string, sourceObjectId: string) {
  const [record] = await db
    .select()
    .from(catalogBackfillRecords)
    .where(and(eq(catalogBackfillRecords.runId, runId), eq(catalogBackfillRecords.subjectKey, `source_object:${sourceObjectId}`)));
  return record;
}

async function seededProducts() {
  return db.select().from(canonicalProducts).where(eq(canonicalProducts.name, NAME));
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
    .values({ name: `Cardmarket ${RUN}`, slug: `cardmarket-anchor-${RUN}` })
    .returning({ id: merchants.id });
  if (merchant === undefined) throw new Error('merchant insert returned no row');
  priceMerchantId = merchant.id;
  createdMerchantIds.push(merchant.id);

  cardSourceId = await bringUpSource({
    label: 'cards',
    kind: 'marketplace_api',
    pages: [[cardRecord('Nonfoil', 25, OBSERVED), cardRecord('Foil', 140, OBSERVED)]],
    merchantId: priceMerchantId,
    // A trend price, not a listing: informational, and the source seeds.
    rights: { mayLinkOut: false, maySeedCatalog: true },
  });
  await ingest(cardSourceId, OBSERVED);
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

describe('ADR 0016: a source seeds products by its own product key', () => {
  it('stores the source product key on both objects, which the matcher leaves unattached', async () => {
    const objects = await objectsOf(cardSourceId);
    expect(objects).toHaveLength(2);
    for (const object of objects) {
      expect(object.productGroupKey).toBe(CARD_ID);
      expect(['unmatched', 'review_required']).toContain(object.state);
    }
  });

  it('a DRY RUN reports the mint and writes nothing', async () => {
    const runId = await backfill('reference_products', 'dry_run');
    const [first] = await objectsOf(cardSourceId);
    expect((await recordFor(runId, first?.id ?? ''))?.reasonCode).toBe('reference_product_minted');
    expect(await seededProducts()).toEqual([]);
  });

  it('APPLY mints ONE product with a variant per finish, and both offers materialize', async () => {
    const runId = await backfill('reference_products', 'apply');
    const products = await seededProducts();
    expect(products).toHaveLength(1);
    const product = products[0];
    expect(product?.status).toBe('draft');
    expect(product?.variantDefiningAttributeKeys).toEqual(['finish']);

    const variants = await db.select().from(canonicalVariants).where(eq(canonicalVariants.productId, product?.id ?? ''));
    expect(variants).toHaveLength(2);

    const objects = await objectsOf(cardSourceId);
    for (const object of objects) {
      expect((await recordFor(runId, object.id))?.canonicalProductId).toBe(product?.id);
      expect(object.state).toBe('offer_current');
    }
    const amounts = (await db.select().from(offers).where(eq(offers.merchantId, priceMerchantId)))
      .map((offer) => [offer.kind, offer.priceAmount, offer.status])
      .sort();
    expect(amounts).toEqual([
      ['informational', 140, 'active'],
      ['informational', 25, 'active'],
    ]);
  });

  it('a second APPLY run converges on the same product and variants', async () => {
    await backfill('reference_products', 'apply');
    const products = await seededProducts();
    expect(products).toHaveLength(1);
    const variants = await db.select().from(canonicalVariants).where(eq(canonicalVariants.productId, products[0]?.id ?? ''));
    expect(variants).toHaveLength(2);
  });

  it('reference_promotion makes it active on its anchor and its priced offers', async () => {
    await backfill('reference_promotion', 'apply');
    expect((await seededProducts())[0]?.status).toBe('active');
  });

  it('a new price is attached through the existing link, and moves the offer', async () => {
    unregisterCatalogSourceAdapter(cardProvider);
    registerCatalogSourceAdapter(
      createFixtureAdapter({ provider: cardProvider, kind: 'marketplace_api', pages: [[cardRecord('Nonfoil', 30, LATER), cardRecord('Foil', 140, LATER)]] }),
    );
    await ingest(cardSourceId, LATER);
    const objects = await objectsOf(cardSourceId);
    const nonfoil = objects.find((object) => object.externalId.endsWith(':nonfoil'));
    expect(nonfoil?.state).toBe('offer_current');
    const [decision] = await db.select().from(matchDecisions).where(eq(matchDecisions.id, nonfoil?.lastMatchDecisionId ?? ''));
    expect(decision?.decidedStage).toBe('existing_source_link');
    const [offer] = await db.select().from(offers).where(eq(offers.id, nonfoil?.offerId ?? ''));
    expect(offer?.priceAmount).toBe(30);
    expect(await seededProducts()).toHaveLength(1);
  });
});
