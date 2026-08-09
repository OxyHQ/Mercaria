/**
 * #68's SEVEN acceptance criteria, each as a real test against a real
 * PostgreSQL server.
 *
 * None of them exists under a mock. Four are about CONSTRAINTS and partial
 * uniques (a mocked `insert` accepts a statement the server rejects outright),
 * two are about a convergence key deciding whether a returning offer is the
 * same row or a second one, and the last reads a projection over four tables.
 *
 * The failure mode the whole file guards against is the one #68 exists for: a
 * refresh that looked fine and cost a catalogue. So the assertions are written
 * to fail LOUDLY on the safe-looking direction — an offer that survived when it
 * should have retired is as much a failure here as one that vanished.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import {
  catalogSourceConfigs,
  catalogSourceObjects,
  catalogSourcePolicies,
  catalogSourceRuns,
} from '../../db/schema/ingestion.js';
import {
  catalogSourceDistributions,
  catalogSourceFreshnessPolicies,
  catalogSourceRefreshLeases,
  catalogSourceRunQuarantines,
  offerRefreshTasks,
} from '../../db/schema/offerFreshness.js';
import { offers } from '../../db/schema/offers.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { merchants } from '../../db/schema/merchants.js';
import {
  configureIngestionSource,
  changeIngestionSourceStatus,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import { publishFreshnessPolicy } from '../../db/offerFreshness/freshnessPolicyRepository.js';
import { openSourceRun } from '../../db/ingestion/catalogSourceRunRepository.js';
import { recordSourceHealth } from '../../db/ingestion/catalogSourceConfigRepository.js';
import { recordExternalOffer, listOffers } from '../offers/offer.service.js';
import { findOfferById, retireOffers } from '../../db/offers/offerRepository.js';
import { retireUnseen } from '../ingestion/ingest.service.js';
import { runIngestionPage } from '../ingestion/ingest.service.js';
import { registerCatalogSourceAdapter, unregisterCatalogSourceAdapter } from '../ingestion/registry.js';
import { createFixtureAdapter, fixtureRecord } from '../ingestion/adapters/fixture.js';
import { sweepExpiredOffers } from '../offer-freshness/expiry-sweep.js';
import { assertOfferOutboundEligible } from '../offer-freshness/outbound-gate.js';
import { readSourceCatalogHealth } from '../offer-freshness/health.service.js';
import { readProductOfferSummary } from '../offer-freshness/product-summary.js';
import { resolveSourceFreshnessPolicy } from '../offer-freshness/policy.js';
import { requestPriorityRefresh } from '../offer-freshness/refresh-scheduler.js';
import { recordSourceDistribution } from '../../db/offerFreshness/sourceDistributionRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `freshness-${RUN}`;

const createdSourceIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const registeredProviders: string[] = [];

/**
 * The advisory-lock key every realdb teardown that toggles a policy trigger
 * takes before doing so.
 *
 * `alter table … disable trigger` is database-wide, so two files inside that
 * window at once leave one of them deleting against a trigger the other has
 * re-enabled. An arbitrary constant, shared by
 * `ingestion-writes.realdb.test.ts` and `adapter-contract-suite.ts` — its VALUE
 * means nothing and its SAMENESS is the whole mechanism.
 */
const POLICY_TEARDOWN_LOCK = 6_820_068;

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/**
 * Assert a write is refused, and report WHY.
 *
 * The whole cause chain, not just the top message: drizzle's own error says
 * "Failed query: …" and the constraint name lives on the `PostgresError` it
 * wraps. A test matching only the outer message would pass against ANY refusal,
 * which is precisely the check that cannot tell a CHECK from a typo.
 * `ingestion-writes.realdb.test.ts`' helper, verbatim.
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
  for (const provider of registeredProviders) unregisterCatalogSourceAdapter(provider);
  await db.delete(offerRefreshTasks).where(inArray(offerRefreshTasks.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceRefreshLeases)
    .where(inArray(catalogSourceRefreshLeases.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceRunQuarantines)
    .where(inArray(catalogSourceRunQuarantines.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceDistributions)
    .where(inArray(catalogSourceDistributions.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceObjects)
    .where(inArray(catalogSourceObjects.sourceId, safeIds(createdSourceIds)));
  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db
    .delete(catalogSourceRuns)
    .where(inArray(catalogSourceRuns.sourceId, safeIds(createdSourceIds)));
  // The matcher ran over these observations (with no active policy it decides
  // nothing, but the anomaly cases drive whole pages), so its decisions hold a
  // reference to every source record. They go first.
  // `sql.param`, never a bare array: a bare array renders as a ROW CONSTRUCTOR
  // (`($1, $2, …)`), which Postgres refuses to cast to `text[]` — the trap
  // `~/Oxy/AGENTS.md` §"Drizzle `sql` templates" names, and one `tsc` cannot see.
  await db.execute(
    sql`delete from match_decisions where source_record_id in (
      select id from source_records
      where source_id = any(${sql.param(safeIds(createdSourceIds))}::text[])
    )`,
  );
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceConfigs)
    .where(inArray(catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
  /**
   * Both policy tables freeze a published version with a trigger, and neither
   * permits deleting one — which is the point of the freeze, and why a teardown
   * has to switch the triggers off.
   *
   * `alter table … disable trigger` is DATABASE-WIDE, and this suite shares one
   * server with every other realdb file. Two files disabling and re-enabling
   * the same trigger interleave, and the second file's delete meets a trigger
   * the first has just switched back on — measured, as a teardown failure
   * naming a trigger the test had disabled two statements earlier. So the whole
   * window is taken under a SESSION ADVISORY LOCK on
   * {@link POLICY_TEARDOWN_LOCK}, which every file doing this uses: the lock is
   * what makes "disable, delete, enable" atomic with respect to the other
   * files, and it costs one round trip.
   */
  await db.execute(sql`select pg_advisory_lock(${POLICY_TEARDOWN_LOCK})`);
  try {
    await db.execute(sql`alter table catalog_source_freshness_policies disable trigger all`);
    await db
      .delete(catalogSourceFreshnessPolicies)
      .where(inArray(catalogSourceFreshnessPolicies.sourceId, safeIds(createdSourceIds)));
    await db.execute(sql`alter table catalog_source_freshness_policies enable trigger all`);
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
  await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, safeIds(createdVariantIds)));
  await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, safeIds(createdProductIds)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

/** One canonical product plus its one variant — what an offer must point at. */
async function mintCanonicalVariant(label: string): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Freshness ${label} ${RUN}`,
      normalizedName: `freshness ${label} ${RUN}`,
      slug: `freshness-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);

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
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

async function mintMerchant(label: string): Promise<string> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Freshness ${label} ${RUN}`, slug: `freshness-${label}-${RUN}` })
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
 * `mayStore` is a knob because it decides whether the MATCHER can see anything:
 * `may_store` off means the observation is recorded with no payload, so #58's
 * subject loader returns `null` and no `match_decisions` row is written at all
 * (#62 states that consequence explicitly). Every case in this file that drives
 * a real page turns it OFF — none of them is about matching, and staying out of
 * the match-decision graph keeps this file clear of
 * `match_policy_versions_active_key`, the GLOBAL one-active-policy slot that
 * `~/Oxy/AGENTS.md` names as a shared resource between parallel realdb files.
 */
async function bringUpSource(
  label: string,
  options: { freshnessTtlSeconds?: number; mayStore?: boolean } = {},
): Promise<{ sourceId: string; provider: string; merchantId: string }> {
  const provider = `freshness-${label}-${RUN}`.toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 64);
  const merchantId = await mintMerchant(label);
  const resolved = await configureIngestionSource({
    name: `Freshness source ${label} ${RUN}`,
    kind: 'feed',
    provider,
    merchantId,
    fetchCadenceSeconds: 3_600,
    freshnessTtlSeconds: options.freshnessTtlSeconds ?? 3_600,
    pageSize: 50,
  });
  const sourceId = resolved.source.config.sourceId;
  createdSourceIds.push(sourceId);
  await publishIngestionSourcePolicy({
    sourceId,
    reviewedByOxyUserId: OPERATOR,
    ...FULL_RIGHTS,
    mayStore: options.mayStore ?? true,
  });
  await changeIngestionSourceStatus({
    sourceId,
    status: 'active',
    actorOxyUserId: OPERATOR,
    reason: 'offer freshness acceptance suite',
  });
  return { sourceId, provider, merchantId };
}

/** Publish a freshness contract with distinct thresholds, so none is ambiguous. */
async function publishFreshness(
  sourceId: string,
  overrides: Partial<Parameters<typeof publishFreshnessPolicy>[1]> = {},
): Promise<void> {
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
    ...overrides,
  });
}

/** One external offer for a variant, observed `agoSeconds` ago. */
async function seedOffer(input: {
  sourceId: string;
  merchantId: string;
  variantId: string;
  externalOfferId: string;
  provider: string;
  agoSeconds: number;
  price?: { amount: number; currency: string };
  country?: string;
  network?: string;
  programRef?: string;
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
      price: input.price ?? { amount: 1_999, currency: 'EUR' },
      availability: 'in_stock',
      ...(input.country === undefined ? {} : { country: input.country }),
      ...(input.network === undefined
        ? {}
        : { affiliate: { network: input.network, ...(input.programRef === undefined ? {} : { programRef: input.programRef }) } }),
      observedAt,
      // The stored deadline is the PRE-FILTER; the live policy is the
      // authority. Both are stamped from the same contract here.
      staleAt: new Date(observedAt.getTime() + 3_600_000),
    },
    observedAt,
    db,
  );
}

/** Point a source object at an offer, the way a completed pipeline would. */
async function attachObject(input: {
  sourceId: string;
  externalId: string;
  offerId: string;
  lastSeenAt: Date;
}): Promise<string> {
  const recordId = await mintSourceRecord(input.sourceId, input.externalId);
  const [row] = await db
    .insert(catalogSourceObjects)
    .values({
      sourceId: input.sourceId,
      externalType: 'offer',
      externalId: input.externalId,
      currentSourceRecordId: recordId,
      currentObservedAt: input.lastSeenAt,
      currentContentHash: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      firstObservedAt: input.lastSeenAt,
      lastSeenAt: input.lastSeenAt,
      staleAt: new Date(input.lastSeenAt.getTime() + 3_600_000),
      state: 'observed',
      offerId: input.offerId,
    })
    .returning({ id: catalogSourceObjects.id });
  if (!row) throw new Error('the source object was not written');
  return row.id;
}

// ── Acceptance 1 ────────────────────────────────────────────────────────────

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
      externalOfferId: `outage-${RUN}`,
      // Two hours: past the one-hour expiry, inside the two-hour grace.
      agoSeconds: 7_200,
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

    const duringOutage = await sweepExpiredOffers(new Date());
    expect(duringOutage.withheld).toBeGreaterThanOrEqual(1);
    const survived = await findOfferById(db, offerId);
    expect(survived?.status).toBe('active');

    // …and it is ALREADY invisible, which is what makes the grace safe: the
    // catalogue is kept, and nothing old is presented as fresh.
    const page = await listOffers({ canonicalVariantId: variantId, limit: 10 });
    expect(page.offers).toHaveLength(0);

    // Past the grace, the same sweep retires it.
    const later = new Date(Date.now() + 3 * 3_600_000);
    const afterGrace = await sweepExpiredOffers(later);
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
      externalOfferId: `suspended-${RUN}`,
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
    const result = await sweepExpiredOffers(new Date());
    expect(result.retired).toBeGreaterThanOrEqual(1);
    expect((await findOfferById(db, offerId))?.status).toBe('retired');
  });
});

// ── Acceptance 2 and 3 ──────────────────────────────────────────────────────

describe('acceptance 2 and 3 — omission is evidence only from a COMPLETE snapshot', () => {
  it('a complete snapshot retires what it did not mention, as a snapshot_omission', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('snapshot');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('snapshot');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: `snapshot-${RUN}`,
      agoSeconds: 60,
    });
    const objectId = await attachObject({
      sourceId,
      externalId: `snapshot-${RUN}`,
      offerId,
      lastSeenAt: new Date(Date.now() - 600_000),
    });

    const retired = await retireUnseen(
      await db.select().from(catalogSourceObjects).where(eq(catalogSourceObjects.id, objectId)),
      new Date(),
    );
    expect(retired).toBe(1);

    const [object] = await db
      .select()
      .from(catalogSourceObjects)
      .where(eq(catalogSourceObjects.id, objectId));
    // The EVIDENCE is recorded, not just the fact: "did this merchant delist,
    // or did our crawler stop" is the first thing an operator asks.
    expect(object?.retirementKind).toBe('snapshot_omission');
    expect((await findOfferById(db, offerId))?.retirementReason).toBe('source_disappeared');
  });

  it('an INCREMENTAL run cannot claim a complete enumeration, at the row', async () => {
    // Acceptance 3, held by a CHECK rather than by the sweep remembering: a
    // pass that asked for a fraction of the catalogue cannot set the flag that
    // authorises retiring what it did not see.
    const { sourceId } = await bringUpSource('incremental');
    const run = await openSourceRun(db, {
      sourceId,
      kind: 'incremental',
      refreshMode: 'incremental',
      since: new Date(Date.now() - 3_600_000),
      requestedByOxyUserId: null,
      now: new Date(),
    });
    expect(
      await rejectionMessage(() =>
        db
          .update(catalogSourceRuns)
          .set({ enumerationComplete: true })
          .where(eq(catalogSourceRuns.id, run.id)),
      ),
    ).toMatch(/catalog_source_runs_complete_mode_check/u);
  });

  it('a TARGETED run must name objects, and a snapshot must not', async () => {
    const { sourceId } = await bringUpSource('targeted');
    // `array_length` of an EMPTY array is NULL and a CHECK rejects only FALSE,
    // so the bare `array_length(...) >= 1` spelling ADMITTED this row —
    // measured, and the reason the constraint reads `coalesce(..., 0)`.
    expect(
      await rejectionMessage(() =>
        openSourceRun(db, {
          sourceId,
          kind: 'manual',
          refreshMode: 'targeted',
          targetExternalIds: [],
          since: null,
          requestedByOxyUserId: OPERATOR,
          now: new Date(),
        }),
      ),
    ).toMatch(/catalog_source_runs_target_shape_check/u);
  });
});

// ── Acceptance 4 ────────────────────────────────────────────────────────────

describe('acceptance 4 — an expired offer leaves every surface, and history remains', () => {
  it('leaves comparison, the product summary and outbound routing at once', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('expired');
    await publishFreshness(sourceId);
    const { productId, variantId } = await mintCanonicalVariant('expired');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: `expired-${RUN}`,
      agoSeconds: 7_200,
    });

    const page = await listOffers({ canonicalVariantId: variantId, limit: 10 });
    expect(page.offers).toHaveLength(0);

    // The product page still RENDERS — public behaviour 7 — and says unknown
    // rather than out of stock, because that is a statement about Mercaria's
    // information and not about the retailer's shelves.
    const summary = await readProductOfferSummary({ canonicalProductId: productId }, db);
    expect(summary.currentOfferCount).toBe(0);
    expect(summary.availability).toBe('unknown');
    expect(summary.lowestPrice).toBeUndefined();

    // The outbound gate refuses it, with a reason rather than a boolean.
    const outbound = await assertOfferOutboundEligible(offerId, new Date(), db);
    expect(outbound.outcome).toBe('refused');
    if (outbound.outcome !== 'refused') throw new Error('unreachable: narrowed above');
    expect(outbound.reason).toBe('offer_not_current');

    // And the history is untouched: the row, its observation and its price.
    const stored = await findOfferById(db, offerId);
    expect(stored?.status).toBe('active');
    expect(stored?.sourceRecordId).not.toBeNull();
    expect(stored?.priceAmount).toBe(1_999);
  });

  it('a CURRENT offer is admitted by the same gate, so the refusal is not vacuous', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('current');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('current');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: `current-${RUN}`,
      agoSeconds: 60,
    });

    const page = await listOffers({ canonicalVariantId: variantId, limit: 10 });
    expect(page.offers).toHaveLength(1);
    expect(page.offers[0]?.freshness.level).toBe('current');

    const outbound = await assertOfferOutboundEligible(offerId, new Date(), db);
    expect(outbound.outcome).toBe('permitted');
    if (outbound.outcome !== 'permitted') throw new Error('unreachable: narrowed above');
    expect(outbound.destinationUrl).toContain(`current-${RUN}`);
  });

  it('an EXPLICIT unavailability leaves comparison whatever the clock says', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('unavailable');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('unavailable');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: `unavailable-${RUN}`,
      agoSeconds: 60,
    });
    await db
      .update(offers)
      .set({ declaredUnavailableAt: new Date() })
      .where(eq(offers.id, offerId));

    const page = await listOffers({ canonicalVariantId: variantId, limit: 10 });
    expect(page.offers).toHaveLength(0);
    const outbound = await assertOfferOutboundEligible(offerId, new Date(), db);
    expect(outbound.outcome).toBe('refused');
  });

  it('`source_unavailable` cannot be recorded without a declaration', async () => {
    // The reason NAMES a statement the source made, so there must be one.
    const { sourceId, provider, merchantId } = await bringUpSource('reasoncheck');
    const { variantId } = await mintCanonicalVariant('reasoncheck');
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: `reasoncheck-${RUN}`,
      agoSeconds: 60,
    });
    expect(
      await rejectionMessage(() =>
        db
          .update(offers)
          .set({ status: 'retired', retirementReason: 'source_unavailable', retiredAt: new Date() })
          .where(eq(offers.id, offerId)),
      ),
    ).toMatch(/offers_source_unavailable_reason_check/u);
  });
});

// ── Acceptance 5 ────────────────────────────────────────────────────────────

describe('acceptance 5 — a returning offer revives the SAME identity', () => {
  it('reactivates the retired row rather than minting a second one', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('revival');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('revival');
    const externalOfferId = `revival-${RUN}`;

    const firstId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId,
      agoSeconds: 60,
      price: { amount: 1_999, currency: 'EUR' },
    });
    const first = await findOfferById(db, firstId);
    const firstSeenAt = first?.firstSeenAt;

    await retireOffers(db, [firstId], 'source_disappeared');
    expect((await findOfferById(db, firstId))?.status).toBe('retired');

    // The source publishes it again.
    const secondId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId,
      agoSeconds: 0,
      price: { amount: 1_499, currency: 'EUR' },
    });

    // THE SAME ROW. Before #68 the retired offer did not occupy its source key,
    // so this inserted a second row and split the observed history across two
    // ids with nothing to rejoin them.
    expect(secondId).toBe(firstId);
    const revived = await findOfferById(db, secondId);
    expect(revived?.status).toBe('active');
    expect(revived?.retirementReason).toBeNull();
    expect(revived?.retiredAt).toBeNull();
    expect(revived?.priceAmount).toBe(1_499);
    // `first_seen_at` never moves: a source re-observing an offer it published
    // a year ago must not make it look new.
    expect(revived?.firstSeenAt.getTime()).toBe(firstSeenAt?.getTime());

    const all = await db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.canonicalVariantId, variantId));
    expect(all).toHaveLength(1);
  });

  it('a revival clears the source’s previous claim that the object was gone', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('revival2');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('revival2');
    const externalOfferId = `revival2-${RUN}`;
    const offerId = await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId,
      agoSeconds: 60,
    });
    await db
      .update(offers)
      .set({ declaredUnavailableAt: new Date() })
      .where(eq(offers.id, offerId));

    await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId,
      agoSeconds: 0,
    });
    const revived = await findOfferById(db, offerId);
    // The source is publishing it again, so whatever it once said about the
    // object being gone is no longer its position.
    expect(revived?.declaredUnavailableAt).toBeNull();
  });
});

// ── Acceptance 6 ────────────────────────────────────────────────────────────

describe('acceptance 6 — anomaly fixtures quarantine bad output BEFORE publication', () => {
  /**
   * Bring up a source whose feed publishes exactly these prices, seed the
   * BASELINE it will be judged against, and drive ONE page.
   *
   * The order is load-bearing and was got wrong once: seeding the baseline
   * AFTER a first ingest and then re-running the same feed produces a page of
   * UNCHANGED records, which never reach the publication gate at all — so the
   * assertion passed through a path the test was not about. One run against a
   * pre-seeded baseline is the shape that measures what it claims to.
   *
   * The matcher is deliberately left with no active policy: `runMatch` then
   * answers `null`, the object stays observed and no offer is written. That is
   * exactly the surface these cases need — what is under test is whether the
   * page's output reaches `advanceObject` AT ALL, and a matcher verdict would
   * only add a second reason for it not to.
   */
  async function ingestAgainstBaseline(input: {
    label: string;
    prices: readonly number[];
    currency: string;
    baseline: { medianPriceMinor: number | null; currency: string | null; objectCount: number };
  }): Promise<{ sourceId: string }> {
    const provider = `freshanom-${input.label}-${RUN}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]/gu, '')
      .slice(0, 64);
    const adapter = createFixtureAdapter({
      provider,
      pages: [
        input.prices.map((amount, index) =>
          fixtureRecord({
            externalId: `${input.label}-${index}-${RUN}`,
            title: `Anomaly ${input.label} ${index}`,
            normalized: {
              title: `Anomaly ${input.label} ${index}`,
              identifiers: [],
              options: [],
              media: [],
              price: { amount, currency: input.currency },
            },
          }),
        ),
      ],
    });
    registerCatalogSourceAdapter(adapter);
    registeredProviders.push(provider);

    const merchantId = await mintMerchant(input.label);
    const resolved = await configureIngestionSource({
      name: `Anomaly source ${input.label} ${RUN}`,
      kind: 'feed',
      provider,
      merchantId,
      freshnessTtlSeconds: 3_600,
      pageSize: 50,
    });
    const sourceId = resolved.source.config.sourceId;
    createdSourceIds.push(sourceId);
    // `mayStore: false` — see `bringUpSource`. These cases are about the
    // publication gate, and the matcher would only add a second reason for a
    // page not to reach `advanceObject`.
    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: OPERATOR,
      ...FULL_RIGHTS,
      mayStore: false,
    });
    await changeIngestionSourceStatus({
      sourceId,
      status: 'active',
      actorOxyUserId: OPERATOR,
      reason: 'anomaly fixture',
    });
    await publishFreshness(sourceId);

    await recordSourceDistribution(db, {
      sourceId,
      runId: null,
      distribution: {
        sampleSize: 200,
        pricedCount: 200,
        zeroPricedCount: 0,
        medianPriceMinor: input.baseline.medianPriceMinor,
        dominantCurrency: input.baseline.currency,
        dominantCurrencyShare: 1,
      },
      objectCount: input.baseline.objectCount,
      quarantined: false,
      now: new Date(),
    });

    const leaseOwner = `anom-${input.label}-${RUN}`;
    const run = await openSourceRun(db, {
      sourceId,
      kind: 'manual',
      refreshMode: 'full_snapshot',
      since: null,
      requestedByOxyUserId: OPERATOR,
      now: new Date(),
    });
    await db
      .update(catalogSourceRuns)
      .set({
        status: 'running',
        leaseOwner,
        leaseUntil: new Date(Date.now() + 600_000),
        startedAt: new Date(),
      })
      .where(eq(catalogSourceRuns.id, run.id));
    await runIngestionPage({ runId: run.id, leaseOwner });
    return { sourceId };
  }

  it('quarantines a PRICE SCALE shift and publishes none of the page', async () => {
    // The baseline is a hundredfold higher: majors published where minors were,
    // the failure a single record cannot show.
    const { sourceId } = await ingestAgainstBaseline({
      label: 'scale',
      prices: [1_900, 2_100, 2_000, 2_200, 1_800, 2_050],
      currency: 'EUR',
      baseline: { medianPriceMinor: 200_000, currency: 'EUR', objectCount: 200 },
    });

    const findings = await db
      .select()
      .from(catalogSourceRunQuarantines)
      .where(eq(catalogSourceRunQuarantines.sourceId, sourceId));
    expect(findings.map((finding) => finding.kind)).toContain('price_scale_shift');

    // Nothing from the page was published, and the objects say so. This is the
    // half that matters: the observations exist (provenance is never withheld)
    // and none of them reached `advanceObject`.
    const objects = await db
      .select()
      .from(catalogSourceObjects)
      .where(eq(catalogSourceObjects.sourceId, sourceId));
    expect(objects.length).toBe(6);
    expect(objects.every((object) => object.state === 'quarantined')).toBe(true);
  });

  it('quarantines a CURRENCY change, however plausible the numbers are', async () => {
    const { sourceId } = await ingestAgainstBaseline({
      label: 'currency',
      prices: [1_900, 2_100, 2_000, 2_200, 1_800, 2_050],
      currency: 'EUR',
      baseline: { medianPriceMinor: 2_000, currency: 'USD', objectCount: 200 },
    });

    const findings = await db
      .select()
      .from(catalogSourceRunQuarantines)
      .where(eq(catalogSourceRunQuarantines.sourceId, sourceId));
    expect(findings.map((finding) => finding.kind)).toContain('currency_change');
  });

  it('does NOT quarantine a legitimate half-price sale, so the gate is not vacuous', async () => {
    // The fixture that makes the two above mean something: the same machinery,
    // a median that moved by 2x rather than 100x, and no finding at all.
    const { sourceId } = await ingestAgainstBaseline({
      label: 'sale',
      prices: [950, 1_050, 1_000, 1_100, 900, 1_025],
      currency: 'EUR',
      baseline: { medianPriceMinor: 2_000, currency: 'EUR', objectCount: 200 },
    });

    const findings = await db
      .select()
      .from(catalogSourceRunQuarantines)
      .where(eq(catalogSourceRunQuarantines.sourceId, sourceId));
    expect(findings).toEqual([]);
    const objects = await db
      .select()
      .from(catalogSourceObjects)
      .where(eq(catalogSourceObjects.sourceId, sourceId));
    expect(objects.every((object) => object.state !== 'quarantined')).toBe(true);
  });

  it('a MASS DISAPPEARANCE blocks the retirement it would otherwise authorise', async () => {
    // The one finding a page cannot make, and the one whose consequence is
    // destructive: a feed that dropped nine tenths of its rows must not have
    // them retired on its say-so.
    const { sourceId, provider, merchantId } = await bringUpSource('disappear', { mayStore: false });
    await publishFreshness(sourceId);

    const objectIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      // One variant per offer: `offers_active_commercial_key` allows one active
      // offer per (variant, seller, channel, condition), so six offers from one
      // merchant are six different products — which is also what a catalogue
      // vanishing actually looks like.
      const { variantId } = await mintCanonicalVariant(`disappear-${index}`);
      const offerId = await seedOffer({
        sourceId,
        merchantId,
        variantId,
        provider,
        externalOfferId: `disappear-${index}-${RUN}`,
        agoSeconds: 60,
      });
      objectIds.push(
        await attachObject({
          sourceId,
          externalId: `disappear-${index}-${RUN}`,
          offerId,
          lastSeenAt: new Date(Date.now() - 600_000),
        }),
      );
    }
    await recordSourceDistribution(db, {
      sourceId,
      runId: null,
      distribution: {
        sampleSize: 6,
        pricedCount: 6,
        zeroPricedCount: 0,
        medianPriceMinor: 1_999,
        dominantCurrency: 'EUR',
        dominantCurrencyShare: 1,
      },
      objectCount: 6,
      quarantined: false,
      now: new Date(),
    });

    // The source's own provider slot, answered by a feed that came back EMPTY.
    registerCatalogSourceAdapter(createFixtureAdapter({ provider, pages: [[]] }));
    registeredProviders.push(provider);

    const run = await openSourceRun(db, {
      sourceId,
      kind: 'manual',
      refreshMode: 'full_snapshot',
      since: null,
      requestedByOxyUserId: OPERATOR,
      now: new Date(),
    });
    await db
      .update(catalogSourceRuns)
      .set({
        status: 'running',
        leaseOwner: `dis-${RUN}`,
        leaseUntil: new Date(Date.now() + 600_000),
        startedAt: new Date(),
      })
      .where(eq(catalogSourceRuns.id, run.id));
    await runIngestionPage({ runId: run.id, leaseOwner: `dis-${RUN}` });

    const findings = await db
      .select()
      .from(catalogSourceRunQuarantines)
      .where(eq(catalogSourceRunQuarantines.sourceId, sourceId));
    expect(findings.map((finding) => finding.kind)).toContain('mass_disappearance');

    // NOTHING was retired, which is the point.
    const survivors = await db
      .select({ state: catalogSourceObjects.state })
      .from(catalogSourceObjects)
      .where(inArray(catalogSourceObjects.id, objectIds));
    expect(survivors.every((object) => object.state !== 'retired')).toBe(true);
  });
});

// ── Acceptance 7 ────────────────────────────────────────────────────────────

describe('acceptance 7 — the board names the source, the market and the advertiser', () => {
  it('reports counts, the oldest current observation, the queue and the breakdowns', async () => {
    const { sourceId, provider, merchantId } = await bringUpSource('board');
    await publishFreshness(sourceId);
    const { variantId } = await mintCanonicalVariant('board');
    // TWO merchants: `offers_active_commercial_key` is one active offer per
    // (variant, seller, channel, condition), so one seller cannot list the same
    // variant twice — which is #57 working, not something to route around.
    const secondMerchantId = await mintMerchant('board-second');

    await seedOffer({
      sourceId,
      merchantId,
      variantId,
      provider,
      externalOfferId: `board-es-${RUN}`,
      agoSeconds: 60,
      country: 'ES',
      network: 'awin',
      programRef: 'advertiser-a',
    });
    await seedOffer({
      sourceId,
      merchantId: secondMerchantId,
      variantId,
      provider,
      externalOfferId: `board-de-${RUN}`,
      agoSeconds: 7_200,
      country: 'DE',
      network: 'awin',
      programRef: 'advertiser-b',
    });
    await requestPriorityRefresh(
      { sourceId, externalObjectKey: `board-es-${RUN}`, reason: 'alerted' },
      db,
    );

    const health = await readSourceCatalogHealth({ sourceId }, db);
    expect(health).toBeDefined();
    if (health === undefined) throw new Error('unreachable: asserted above');

    expect(health.offerCounts.current).toBe(1);
    expect(health.offerCounts.expired).toBe(1);
    expect(health.oldestCurrentObservedAt).not.toBeNull();
    expect(health.queue.pending).toBe(1);

    // WHICH market, and WHICH advertiser. An Awin feed whose Spanish advertiser
    // left the network looks perfectly healthy in aggregate; the only thing
    // that says otherwise is one country or one programme going to zero.
    const markets = new Map(health.markets.map((market) => [market.country, market]));
    expect(markets.get('ES')?.currentOffers).toBe(1);
    expect(markets.get('DE')?.expiredOffers).toBe(1);

    const advertisers = new Map(
      health.advertisers.map((advertiser) => [advertiser.affiliateProgramRef, advertiser]),
    );
    expect(advertisers.get('advertiser-a')?.currentOffers).toBe(1);
    expect(advertisers.get('advertiser-b')?.expiredOffers).toBe(1);
  });
});

// ── The freshness model's own contract ──────────────────────────────────────

describe('the freshness contract is per SOURCE, resolved from that source’s rows', () => {
  it('falls back to the source’s OWN configuration when no version is published', async () => {
    const { sourceId } = await bringUpSource('fallback', { freshnessTtlSeconds: 900 });
    const resolved = await resolveSourceFreshnessPolicy(sourceId, db);
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error('unreachable: asserted above');
    expect(resolved.policy.basis).toBe('source_configuration');
    expect(resolved.policy.sourceId).toBe(sourceId);
    // The numbers are that source's own row, never a constant.
    expect(resolved.policy.expiryAfterSeconds).toBe(900);
    expect(resolved.policy.warningAfterSeconds).toBe(600);
  });

  it('a published version supersedes the last and BOTH survive', async () => {
    const { sourceId } = await bringUpSource('versions');
    await publishFreshness(sourceId, { expiryAfterSeconds: 3_600 });
    await publishFreshness(sourceId, { expiryAfterSeconds: 7_200, warningAfterSeconds: 3_600 });

    const rows = await db
      .select()
      .from(catalogSourceFreshnessPolicies)
      .where(eq(catalogSourceFreshnessPolicies.sourceId, sourceId));
    expect(rows).toHaveLength(2);
    // The superseded version keeps its reviewer, its date and its numbers —
    // these encode contractual obligations, and an UPDATE that overwrote them
    // would destroy the only record of what Mercaria had agreed to.
    const superseded = rows.find((row) => row.status === 'superseded');
    expect(superseded?.expiryAfterSeconds).toBe(3_600);
    expect(superseded?.reviewedByOxyUserId).toBe(OPERATOR);

    const resolved = await resolveSourceFreshnessPolicy(sourceId, db);
    expect(resolved?.policy.expiryAfterSeconds).toBe(7_200);
    expect(resolved?.policy.policyVersion).toBe(2);
  });

  it('the RIGHTS policy’s cache cap shortens the resolved lifetime', async () => {
    const { sourceId } = await bringUpSource('cap');
    await publishFreshness(sourceId, { expiryAfterSeconds: 86_400, warningAfterSeconds: 43_200 });
    // The bring-up published `cacheTtlSeconds: 86_400`; narrow it, which is a
    // NEW rights version rather than an edit.
    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: OPERATOR,
      ...FULL_RIGHTS,
      cacheTtlSeconds: 3_600,
    });
    const resolved = await resolveSourceFreshnessPolicy(sourceId, db);
    expect(resolved?.policy.cacheCapSeconds).toBe(3_600);
  });

  it('a published version is FROZEN, and cannot be deleted', async () => {
    // The `fee_schedules` mechanism, third outing. These durations encode
    // contractual obligations, so an UPDATE that overwrote them would destroy
    // the only record of what Mercaria had agreed to — and a CHECK cannot
    // express it, because the rule is about a TRANSITION and a CHECK cannot see
    // the OLD row.
    const { sourceId } = await bringUpSource('frozen');
    await publishFreshness(sourceId);
    const [active] = await db
      .select()
      .from(catalogSourceFreshnessPolicies)
      .where(
        sql`${catalogSourceFreshnessPolicies.sourceId} = ${sourceId}
            and ${catalogSourceFreshnessPolicies.status} = 'active'`,
      );
    if (active === undefined) throw new Error('the active version was not written');

    expect(
      await rejectionMessage(() =>
        db
          .update(catalogSourceFreshnessPolicies)
          .set({ expiryAfterSeconds: 999 })
          .where(eq(catalogSourceFreshnessPolicies.id, active.id)),
      ),
    ).toMatch(/thresholds are frozen/u);

    expect(
      await rejectionMessage(() =>
        db
          .delete(catalogSourceFreshnessPolicies)
          .where(eq(catalogSourceFreshnessPolicies.id, active.id)),
      ),
    ).toMatch(/cannot be deleted/u);

    // …and SUPERSEDING it is permitted, which is how a version ends. Without
    // this half the test would pass against a trigger that froze the row solid.
    await db
      .update(catalogSourceFreshnessPolicies)
      .set({ status: 'superseded', supersededAt: new Date() })
      .where(eq(catalogSourceFreshnessPolicies.id, active.id));
    const [superseded] = await db
      .select({ status: catalogSourceFreshnessPolicies.status })
      .from(catalogSourceFreshnessPolicies)
      .where(eq(catalogSourceFreshnessPolicies.id, active.id));
    expect(superseded?.status).toBe('superseded');
  });

  it('two published versions cannot both be active', async () => {
    const { sourceId } = await bringUpSource('active');
    await publishFreshness(sourceId);
    await publishFreshness(sourceId);
    const active = await db
      .select({ id: catalogSourceFreshnessPolicies.id })
      .from(catalogSourceFreshnessPolicies)
      .where(
        sql`${catalogSourceFreshnessPolicies.sourceId} = ${sourceId}
            and ${catalogSourceFreshnessPolicies.status} = 'active'`,
      );
    expect(active).toHaveLength(1);
  });
});

// ── The refresh queue ───────────────────────────────────────────────────────

describe('the refresh queue converges and never demotes an urgent request', () => {
  it('five requests for one object owe ONE refresh', async () => {
    const { sourceId } = await bringUpSource('converge');
    const key = `converge-${RUN}`;
    for (let index = 0; index < 5; index += 1) {
      await requestPriorityRefresh({ sourceId, externalObjectKey: key, reason: 'popular' }, db);
    }
    const rows = await db
      .select()
      .from(offerRefreshTasks)
      .where(eq(offerRefreshTasks.sourceId, sourceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestedRevision).toBe(5);
  });

  it('an ALERT raises the class and a later SCHEDULED tick cannot lower it', async () => {
    const { sourceId } = await bringUpSource('priority');
    const key = `priority-${RUN}`;
    await requestPriorityRefresh({ sourceId, externalObjectKey: key, reason: 'popular' }, db);
    await requestPriorityRefresh({ sourceId, externalObjectKey: key, reason: 'alerted' }, db);
    await requestPriorityRefresh({ sourceId, externalObjectKey: key, reason: 'clicked' }, db);

    const [row] = await db
      .select()
      .from(offerRefreshTasks)
      .where(eq(offerRefreshTasks.sourceId, sourceId));
    expect(row?.priorityClass).toBe('alerted');
    // The rank is GENERATED from the class, so the queue's ordering key is a
    // function of the row rather than a number a service computed.
    expect(row?.priorityRank).toBe(0);
    // Every reason survives beside the winner, so an operator can see why a row
    // is where it is.
    expect([...(row?.priorityReasons ?? [])].sort()).toEqual(['alerted', 'clicked', 'popular']);
  });

  it('a class outside its own reasons is refused at the row', async () => {
    const { sourceId } = await bringUpSource('membership');
    expect(
      await rejectionMessage(() =>
        db.insert(offerRefreshTasks).values({
          sourceId,
          mode: 'targeted',
          subjectKind: 'external_object',
          subjectKey: `membership-${RUN}`,
          priorityClass: 'alerted',
          priorityReasons: ['scheduled'],
          availableAt: new Date(),
        }),
      ),
    ).toMatch(/offer_refresh_tasks_priority_membership_check/u);

    // …and an EMPTY reason list is refused by the same constraint, which the
    // bare `array_length(...) >= 1` spelling admitted: `array_length` of an
    // empty array is NULL and a CHECK rejects only FALSE.
    expect(
      await rejectionMessage(() =>
        db.insert(offerRefreshTasks).values({
          sourceId,
          mode: 'targeted',
          subjectKind: 'external_object',
          subjectKey: `membership-empty-${RUN}`,
          priorityClass: 'alerted',
          priorityReasons: [],
          availableAt: new Date(),
        }),
      ),
    ).toMatch(/offer_refresh_tasks_priority_membership_check/u);
  });

  it('a whole-source task and an object task cannot collide on the sentinel', async () => {
    const { sourceId } = await bringUpSource('sentinel');
    expect(
      await rejectionMessage(() =>
        db.insert(offerRefreshTasks).values({
          sourceId,
          mode: 'targeted',
          subjectKind: 'external_object',
          subjectKey: '*',
          priorityClass: 'clicked',
          priorityReasons: ['clicked'],
          availableAt: new Date(),
        }),
      ),
    ).toMatch(/offer_refresh_tasks_subject_shape_check/u);
  });
});

// ── The fleet-wide refresh budget ───────────────────────────────────────────

describe('the refresh budget binds the FLEET, not a process', () => {
  it('hands out exactly the configured concurrency and then refuses', async () => {
    const { sourceId } = await bringUpSource('budget');
    const { claimSourceRefreshLease, releaseSourceRefreshLease } = await import(
      '../../db/offerFreshness/refreshLeaseRepository.js'
    );
    const budget = { sourceId, maxConcurrency: 2, maxCallsPerMinute: 10 };
    const now = new Date();

    const first = await claimSourceRefreshLease(
      { budget, leaseOwner: `task-a-${RUN}`, leaseMs: 60_000, now },
      db,
    );
    const second = await claimSourceRefreshLease(
      { budget, leaseOwner: `task-b-${RUN}`, leaseMs: 60_000, now },
      db,
    );
    const third = await claimSourceRefreshLease(
      { budget, leaseOwner: `task-c-${RUN}`, leaseMs: 60_000, now },
      db,
    );

    expect(first.outcome).toBe('granted');
    expect(second.outcome).toBe('granted');
    expect(third.outcome).toBe('refused');
    if (third.outcome !== 'refused') throw new Error('unreachable: narrowed above');
    // A third caller arriving while both slots are held is TRANSIENT, and the
    // two refusals are told apart because they need different fixes.
    expect(third.reason).toBe('all_slots_busy');

    if (first.outcome !== 'granted') throw new Error('unreachable: narrowed above');
    expect(
      await releaseSourceRefreshLease({ leaseId: first.leaseId, leaseOwner: `task-a-${RUN}`, now }, db),
    ).toBe(true);
    // A release by somebody who does NOT own the lease changes nothing.
    expect(
      await releaseSourceRefreshLease({ leaseId: first.leaseId, leaseOwner: `task-z-${RUN}`, now }, db),
    ).toBe(false);
  });
});
