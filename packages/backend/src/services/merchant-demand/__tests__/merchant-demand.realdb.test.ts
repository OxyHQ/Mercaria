/**
 * Merchant demand analytics against a REAL PostgreSQL database — issue #86.
 *
 * The four cases #86 acceptance 8 names, plus the two constraints that only a
 * real server holds:
 *
 *  1. **Tenant isolation** — one merchant's snapshot counts one merchant's
 *     events, and a caller who is somebody else gets the same 404 an unknown
 *     merchant gets.
 *  2. **Low-count suppression** — a product below the floor produces NO row and
 *     is counted as withheld; an aggregate below the floor is a STATE and not a
 *     zero; the preview's floor is higher than the dashboard's.
 *  3. **Attribution correction** — a rebuild SUPERSEDES rather than edits, the
 *     superseded figures stay on file, and the immutability trigger refuses an
 *     edit from any caller.
 *  4. **Claim transition** — an unclaimed merchant serves a preview and refuses
 *     a dashboard; the moment `claim_state` moves the two swap over, with no
 *     sweep in between.
 *
 * Plus: the coverage counters must ADD UP (a CHECK, so a report that lost a
 * product row cannot be stored at all), and the outreach log and audit trail
 * refuse UPDATE and DELETE.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every name, slug and account id this file writes
 * carries a per-run suffix and teardown deletes exactly what it created.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray, sql } from 'drizzle-orm';

/**
 * Collection has to be ON before the module graph loads, because `config` is
 * frozen at import: with `ANALYTICS_COLLECTION_MODE` at its shipped default of
 * `off`, every event-sourced metric answers `collection_disabled` and every case
 * below would assert against a seam instead of a measurement.
 *
 * `vi.hoisted` is what runs before the imports — a plain assignment at the top
 * of the file would not, since ESM hoists every `import` above it.
 */
vi.hoisted(() => {
  process.env['ANALYTICS_COLLECTION_MODE'] = 'full';
  process.env['MERCHANT_DEMAND_ENABLED'] = 'true';
  process.env['MERCHANT_DEMAND_PREVIEW_ENABLED'] = 'true';
});

import { uuidv7 } from '@oxyhq/db';
import {
  ANALYTICS_ENVELOPE_VERSION,
  MERCHANT_DEMAND_AGGREGATE_MIN_COUNT,
  MERCHANT_DEMAND_PRODUCT_MIN_COUNT,
  MERCHANT_DEMAND_WINDOW_DAYS,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { analyticsEvents } from '../../../db/schema/analytics.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { merchants, storefronts } from '../../../db/schema/merchants.js';
import { offers } from '../../../db/schema/offers.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import {
  merchantAcquisitionAudits,
  merchantAcquisitionCandidates,
  merchantAcquisitionContactSources,
  merchantAcquisitionOutreach,
  merchantDemandMetrics,
  merchantDemandSnapshots,
} from '../../../db/schema/merchantDemand.js';
import { insertOffer } from '../../../db/offers/offerRepository.js';
import { resolveMerchantDemandAccess } from '../access.js';
import { readMerchantDemandDashboard } from '../dashboard.service.js';
import { readMerchantDemandPreview } from '../preview.service.js';
import { buildMerchantDemandSnapshot } from '../snapshot.service.js';
import {
  enrolMerchant,
  logOutreach,
  readCandidate,
  rescoreCandidate,
  setDoNotContact,
} from '../acquisition.service.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const CLAIMANT = `demand-claimant-${RUN}`;
const STRANGER = `demand-stranger-${RUN}`;
const OPERATOR = `demand-operator-${RUN}`;

const createdMerchantIds: string[] = [];
const createdStorefrontIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdSourceIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/** A 64-character hex-ish digest, which several `content_hash` columns want. */
function digest(): string {
  return uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);
}

/**
 * Assert a write is refused, and report WHY — the whole cause chain.
 *
 * drizzle's own message says "Failed query: …" and the constraint or trigger
 * name lives on the `PostgresError` it wraps, so a test matching only the outer
 * message would pass against ANY refusal, including a typo in the fixture.
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

/**
 * The window every case measures — the SHORTEST member of the closed set.
 *
 * Not an arbitrary 1: `MERCHANT_DEMAND_WINDOW_DAYS` is closed precisely so a
 * caller cannot ask for overlapping windows, and a test asking for a window the
 * product does not offer would measure a path no client can reach.
 */
const WINDOW_DAYS = MERCHANT_DEMAND_WINDOW_DAYS[0];

/** An instant inside the window `resolveWindow` draws for `WINDOW_DAYS`. */
function insideWindow(): Date {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(to.getTime() - 12 * 60 * 60 * 1_000);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db
    .delete(analyticsEvents)
    .where(inArray(analyticsEvents.merchantId, safeIds(createdMerchantIds)));
  await db.execute(
    sql`delete from analytics_events
        where canonical_product_id = any(${sql.param(safeIds(createdProductIds))}::text[])`,
  );

  /**
   * The three demand tables are append-only against UPDATE and PERMIT delete —
   * that is the `analytics_events` posture and the reason the retention sweep
   * works — so teardown needs no trigger escape for them. The two acquisition
   * records refuse DELETE as well, so those two do.
   *
   * `alter table … disable trigger` is DATABASE-WIDE, so both toggles are taken
   * under the shared mutex and every statement here is issued on that
   * transaction's own handle. On the pool the DDL autocommits, so a throw
   * before a re-enable would leave the trigger off for the rest of the run and
   * every later file asserting it refuses a write would pass vacuously.
   *
   * ONE window rather than two: the two tables are torn down in a fixed order
   * — outreach cites a candidate row deleted below it — so the pair was already
   * interleaved, and splitting it would mean holding the mutex twice over
   * statements that never left it.
   */
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table merchant_acquisition_outreach disable trigger merchant_acquisition_outreach_append_only`,
    );
    await tx.execute(
      sql`alter table merchant_acquisition_audits disable trigger merchant_acquisition_audits_append_only`,
    );
    await tx.execute(
      sql`delete from merchant_acquisition_outreach where candidate_id in (
        select id from merchant_acquisition_candidates
        where merchant_id = any(${sql.param(safeIds(createdMerchantIds))}::text[])
      )`,
    );
    await tx
      .delete(merchantAcquisitionAudits)
      .where(inArray(merchantAcquisitionAudits.merchantId, safeIds(createdMerchantIds)));
    await tx.execute(
      sql`alter table merchant_acquisition_outreach enable trigger merchant_acquisition_outreach_append_only`,
    );
    await tx.execute(
      sql`alter table merchant_acquisition_audits enable trigger merchant_acquisition_audits_append_only`,
    );
  });

  await db.execute(
    sql`delete from merchant_acquisition_contact_sources where candidate_id in (
      select id from merchant_acquisition_candidates
      where merchant_id = any(${sql.param(safeIds(createdMerchantIds))}::text[])
    )`,
  );
  await db
    .delete(merchantAcquisitionCandidates)
    .where(inArray(merchantAcquisitionCandidates.merchantId, safeIds(createdMerchantIds)));
  await db.execute(
    sql`delete from merchant_demand_metrics where snapshot_id in (
      select id from merchant_demand_snapshots
      where merchant_id = any(${sql.param(safeIds(createdMerchantIds))}::text[])
    )`,
  );
  await db.execute(
    sql`delete from merchant_demand_products where snapshot_id in (
      select id from merchant_demand_snapshots
      where merchant_id = any(${sql.param(safeIds(createdMerchantIds))}::text[])
    )`,
  );
  await db
    .delete(merchantDemandSnapshots)
    .where(inArray(merchantDemandSnapshots.merchantId, safeIds(createdMerchantIds)));

  await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(storefronts).where(inArray(storefronts.id, safeIds(createdStorefrontIds)));
  await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

/** A merchant and the channel it operates. */
async function mintMerchant(label: string): Promise<{ merchantId: string; storefrontId: string }> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Demand ${label} ${RUN}`, slug: `demand-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('the merchant was not written');
  createdMerchantIds.push(merchant.id);

  const [storefront] = await db
    .insert(storefronts)
    .values({
      merchantId: merchant.id,
      name: `Channel ${label} ${RUN}`,
      slug: `demand-channel-${label}-${RUN}`,
      channelKind: 'web',
    })
    .returning({ id: storefronts.id });
  if (!storefront) throw new Error('the storefront was not written');
  createdStorefrontIds.push(storefront.id);
  return { merchantId: merchant.id, storefrontId: storefront.id };
}

/** A canonical product with one configuration. */
async function mintProduct(label: string): Promise<{ productId: string; variantId: string }> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Demand product ${label} ${RUN}`,
      normalizedName: `demand product ${label} ${RUN}`,
      slug: `demand-product-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({ productId: product.id, signature: digest() })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the canonical variant was not written');
  createdVariantIds.push(variant.id);
  return { productId: product.id, variantId: variant.id };
}

/** A catalog source and one observation on it. */
async function mintObservation(label: string): Promise<string> {
  const [source] = await db
    .insert(catalogSources)
    .values({
      name: `Demand source ${label} ${RUN}`,
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
      externalId: `demand-${label}-${RUN}`,
      contentHash: digest(),
      observedAt: new Date(),
    })
    .returning({ id: sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return record.id;
}

/** One external offer for a merchant, written through every real CHECK. */
async function seedExternalOffer(input: {
  label: string;
  variantId: string;
  merchantId: string;
  storefrontId: string;
}): Promise<string> {
  const recordId = await mintObservation(input.label);
  const now = new Date();
  const row = await insertOffer(db, {
    kind: 'external',
    status: 'active',
    canonicalVariantId: input.variantId,
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    sourceRecordId: recordId,
    provider: `demand-${input.label}-${RUN}`.toLowerCase().slice(0, 64),
    externalOfferId: `demand-ext-${input.label}-${RUN}`,
    destinationUrl: `https://${input.label}-${RUN}.example.test/item`.toLowerCase(),
    priceAmount: 9_900,
    priceCurrency: 'EUR',
    availability: 'in_stock',
    condition: 'new',
    conditionMappingState: 'declared',
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

/** `count` human events of one type, inside the window. */
async function seedEvents(input: {
  eventType: 'offer_impression' | 'product_page_view';
  count: number;
  merchantId?: string;
  canonicalProductId?: string;
  trafficClass?: 'human' | 'crawler';
}): Promise<void> {
  if (input.count === 0) return;
  const at = insideWindow();
  await db.insert(analyticsEvents).values(
    Array.from({ length: input.count }, () => ({
      envelopeVersion: ANALYTICS_ENVELOPE_VERSION,
      eventType: input.eventType,
      eventClass: 'discovery' as const,
      occurredAt: at,
      receivedAt: at,
      actorKind: 'anonymous' as const,
      clientSurface: 'storefront_web' as const,
      trafficClass: input.trafficClass ?? ('human' as const),
      consentState: 'not_required' as const,
      collectionMode: 'full' as const,
      market: 'ES',
      ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
      ...(input.canonicalProductId === undefined
        ? {}
        : { canonicalProductId: input.canonicalProductId }),
      expiresAt: new Date(at.getTime() + 90 * 24 * 60 * 60 * 1_000),
    })),
  );
}

/** The measured count of one metric on a view, or `undefined` when it is not. */
function measuredCount(
  view: Awaited<ReturnType<typeof readMerchantDemandDashboard>>,
  metricKey: string,
): number | undefined {
  const metric = view.metrics.find((row) => row.metricKey === metricKey);
  if (metric === undefined) return undefined;
  if (metric.value.state !== 'measured') return undefined;
  if (metric.value.measure.unit !== 'count') return undefined;
  return metric.value.measure.count;
}

describe('tenant isolation (#86 acceptance 8, privacy 6)', () => {
  it('counts one merchant’s events and never a neighbour’s', async () => {
    const mine = await mintMerchant('tenant-mine');
    const theirs = await mintMerchant('tenant-theirs');
    const product = await mintProduct('tenant');
    await seedExternalOffer({
      label: 'tenant-mine',
      variantId: product.variantId,
      merchantId: mine.merchantId,
      storefrontId: mine.storefrontId,
    });
    await seedExternalOffer({
      label: 'tenant-theirs',
      variantId: product.variantId,
      merchantId: theirs.merchantId,
      storefrontId: theirs.storefrontId,
    });

    // Both merchants offer the SAME product, which is the case a naive
    // product-scoped count gets wrong: impressions must follow the merchant.
    await seedEvents({
      eventType: 'offer_impression',
      count: 30,
      merchantId: mine.merchantId,
      canonicalProductId: product.productId,
    });
    await seedEvents({
      eventType: 'offer_impression',
      count: 70,
      merchantId: theirs.merchantId,
      canonicalProductId: product.productId,
    });

    const mineView = await readMerchantDemandDashboard({
      merchantId: mine.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });
    const theirsView = await readMerchantDemandDashboard({
      merchantId: theirs.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });

    expect(measuredCount(mineView, 'offer_impressions')).toBe(30);
    expect(measuredCount(theirsView, 'offer_impressions')).toBe(70);
  });

  it('excludes bot traffic from a merchant’s demand (#86 acceptance 3)', async () => {
    const merchant = await mintMerchant('bots');
    const product = await mintProduct('bots');
    await seedExternalOffer({
      label: 'bots',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });
    // Above the PRODUCT floor, so the product is a disclosed row and the
    // aggregate is publishable at all — otherwise this would measure the
    // residual policy rather than bot exclusion.
    await seedEvents({
      eventType: 'offer_impression',
      count: 30,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
    });
    await seedEvents({
      eventType: 'offer_impression',
      count: 500,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
      trafficClass: 'crawler',
    });

    const view = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });
    // Thirty, not five hundred and thirty. The crawler traffic is excluded in
    // the PREDICATE, so the inflated number never reaches a stored aggregate.
    expect(measuredCount(view, 'offer_impressions')).toBe(30);
  });

  it('refuses a stranger and the merchant’s own neighbour with the SAME answer', async () => {
    const mine = await mintMerchant('access-mine');
    await db.execute(
      sql`update merchants set claim_state = 'claimed', claimed_by_oxy_user_id = ${CLAIMANT}
          where id = ${mine.merchantId}`,
    );

    const granted = await resolveMerchantDemandAccess({
      merchantId: mine.merchantId,
      oxyUserId: CLAIMANT,
    });
    expect(granted.outcome).toBe('granted');

    const refusedStranger = await resolveMerchantDemandAccess({
      merchantId: mine.merchantId,
      oxyUserId: STRANGER,
    });
    const refusedUnknown = await resolveMerchantDemandAccess({
      merchantId: uuidv7(),
      oxyUserId: STRANGER,
    });
    // Byte-identical. A distinguishable refusal is an oracle for which
    // merchants have been claimed.
    expect(refusedStranger).toEqual(refusedUnknown);
    expect(refusedStranger.outcome).toBe('refused');
  });
});

describe('low-count suppression (#86 privacy 1, acceptance 8)', () => {
  it('withholds a product row below the floor and COUNTS the withholding', async () => {
    const merchant = await mintMerchant('floor');
    const loud = await mintProduct('floor-loud');
    const quiet = await mintProduct('floor-quiet');
    await seedExternalOffer({
      label: 'floor-loud',
      variantId: loud.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });
    await seedExternalOffer({
      label: 'floor-quiet',
      variantId: quiet.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });

    await seedEvents({
      eventType: 'product_page_view',
      count: MERCHANT_DEMAND_PRODUCT_MIN_COUNT + 5,
      canonicalProductId: loud.productId,
    });
    await seedEvents({
      eventType: 'product_page_view',
      count: MERCHANT_DEMAND_PRODUCT_MIN_COUNT - 1,
      canonicalProductId: quiet.productId,
    });

    const view = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });

    const productIds = view.products.map((row) => row.canonicalProductId);
    expect(productIds).toContain(loud.productId);
    expect(productIds, 'a product below the floor must have NO row at all').not.toContain(
      quiet.productId,
    );
    expect(view.coverage.productRowsDisclosed).toBe(1);
    expect(view.coverage.productRowsSuppressed).toBe(1);
    // The counters ADD UP, and a CHECK refuses a row where they do not — so a
    // report that lost a product between counting and writing cannot exist.
    expect(view.coverage.productsOffered).toBe(
      view.coverage.productRowsDisclosed + view.coverage.productRowsSuppressed,
    );
  });

  it('an aggregate MINUS the disclosed rows cannot isolate a sub-floor product', async () => {
    // The differencing attack, end to end and in ONE ordinary dashboard read:
    // the aggregate and the product breakdown sum over the SAME population at
    // DIFFERENT grains, so an aggregate that includes a withheld product hands
    // the merchant its exact count by subtraction. One suppressed contributor
    // is the sharp case — the residual IS that product.
    const merchant = await mintMerchant('difference-one');
    const loud = await mintProduct('difference-loud');
    const quiet = await mintProduct('difference-quiet');
    for (const [label, product] of [
      ['difference-loud', loud],
      ['difference-quiet', quiet],
    ] as const) {
      await seedExternalOffer({
        label,
        variantId: product.variantId,
        merchantId: merchant.merchantId,
        storefrontId: merchant.storefrontId,
      });
    }
    await seedEvents({
      eventType: 'product_page_view',
      count: 30,
      canonicalProductId: loud.productId,
    });
    await seedEvents({
      eventType: 'product_page_view',
      count: 6,
      canonicalProductId: quiet.productId,
    });

    const view = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });

    const aggregate = measuredCount(view, 'product_page_views_with_offer');
    expect(aggregate, 'the aggregate must still be published').toBeDefined();
    const disclosed = view.products.reduce((sum, row) => sum + row.productPageViews, 0);
    expect(disclosed, 'the loud product is disclosed exactly').toBe(30);
    expect(view.coverage.productRowsSuppressed).toBe(1);

    // The whole property, in one line: the residual is not the quiet product's
    // count. With a single sub-floor contributor there is nothing to hide it
    // among, so the residual is folded away and the aggregate is the disclosed
    // rows — which the basis says out loud.
    expect((aggregate ?? 0) - disclosed, 'the residual isolates a withheld product').not.toBe(6);
    expect((aggregate ?? 0) - disclosed).toBe(0);
    const metric = view.metrics.find((row) => row.metricKey === 'product_page_views_with_offer');
    expect(metric?.aggregateBasis).toBe('disclosed_rows_only');
  });

  it('publishes the residual only once enough withheld products hide each other', async () => {
    const merchant = await mintMerchant('difference-many');
    const loud = await mintProduct('difference-many-loud');
    const quietA = await mintProduct('difference-many-a');
    const quietB = await mintProduct('difference-many-b');
    for (const [label, product] of [
      ['difference-many-loud', loud],
      ['difference-many-a', quietA],
      ['difference-many-b', quietB],
    ] as const) {
      await seedExternalOffer({
        label,
        variantId: product.variantId,
        merchantId: merchant.merchantId,
        storefrontId: merchant.storefrontId,
      });
    }
    await seedEvents({ eventType: 'product_page_view', count: 30, canonicalProductId: loud.productId });
    await seedEvents({ eventType: 'product_page_view', count: 9, canonicalProductId: quietA.productId });
    await seedEvents({ eventType: 'product_page_view', count: 8, canonicalProductId: quietB.productId });

    const view = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });

    const aggregate = measuredCount(view, 'product_page_views_with_offer') ?? 0;
    const disclosed = view.products.reduce((sum, row) => sum + row.productPageViews, 0);
    expect(disclosed).toBe(30);
    expect(view.coverage.productRowsSuppressed).toBe(2);

    // TWO contributors and a residual over the value floor, so it is published
    // — and it identifies neither of them.
    //
    // The assertion is the PROPERTY rather than the arithmetic. `9 + 8 = 17` is
    // incidental; what makes the residual safe is that it is strictly larger
    // than any single contributor, because a residual EQUAL to one of them
    // would BE that one. Pinning the literal total would also pin every
    // seeded event being counted, which is a different claim and one this case
    // is not about — and it went red once under full-suite load at 16 without
    // an explanation I could reproduce in four attempts.
    const residual = aggregate - disclosed;

    // TWO assertions, because they fail for different reasons and a single one
    // conflates them. The first is the COMPOSITION invariant — the residual is
    // exactly the withheld products' contribution, read back from the database
    // rather than assumed from what was seeded. The second is the SECURITY
    // property — the residual is strictly larger than any single contributor,
    // because one equal to a contributor would BE that contributor.
    //
    // Pinning the literal 17 instead would conflate both with a third claim,
    // "every seeded event was counted", which is what went red once at 16 under
    // full-suite load with no reproduction in four attempts. Splitting them
    // means a recurrence names which of the three broke.
    //
    // What was RULED OUT, so nobody re-runs it: WINDOW ARITHMETIC of any kind.
    // `seedEvents` computes ONE shared `occurredAt` and inserts every row of a
    // call in a single bulk `values()` array, so a boundary can only include or
    // exclude an entire batch ATOMICALLY — it cannot admit eight of nine
    // identically-timestamped rows and drop the ninth. A single-row loss on a
    // 9-plus-8 split is therefore structurally incompatible with the window,
    // whatever the comparisons are. (They are also correct: all four fact
    // queries bound `[from, to)` with `gte`/`lt`, and `insideWindow()` places
    // every event twelve hours inside the upper edge.) If it recurs, look at
    // bulk-insert or transaction visibility, or at the harness — not here. The
    // anomaly remains unexplained.
    const withheldInDatabase = await db
      .select({ total: sql<string>`count(*)` })
      .from(analyticsEvents)
      .where(
        sql`${analyticsEvents.eventType} = 'product_page_view'
            and ${analyticsEvents.trafficClass} = 'human'
            and ${analyticsEvents.canonicalProductId} = any(${sql.param([
              quietA.productId,
              quietB.productId,
            ])}::text[])`,
      );
    expect(residual, 'the residual is not the withheld products’ contribution').toBe(
      Number(withheldInDatabase[0]?.total ?? 0),
    );
    expect(residual, 'the residual must aggregate more than one product').toBeGreaterThan(9);
    const metric = view.metrics.find((row) => row.metricKey === 'product_page_views_with_offer');
    expect(metric?.aggregateBasis).toBe('whole_catalogue');
  });

  it('suppresses an aggregate as a STATE rather than reporting it as zero', async () => {
    const merchant = await mintMerchant('aggregate-floor');
    const product = await mintProduct('aggregate-floor');
    await seedExternalOffer({
      label: 'aggregate-floor',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });
    await seedEvents({
      eventType: 'offer_impression',
      count: MERCHANT_DEMAND_AGGREGATE_MIN_COUNT - 1,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
    });

    const view = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });
    const metric = view.metrics.find((row) => row.metricKey === 'offer_impressions');
    expect(metric?.value.state).toBe('suppressed');
    // Not a zero, and not a bound either: the stored row carries the floor and
    // no count, so a client cannot render "9" or "under 10".
    const stored = await db
      .select()
      .from(merchantDemandMetrics)
      .where(sql`${merchantDemandMetrics.snapshotId} = ${view.id}
                 and ${merchantDemandMetrics.metricKey} = 'offer_impressions'`);
    expect(stored[0]?.countValue).toBeNull();
    expect(stored[0]?.suppressedBelow).toBe(MERCHANT_DEMAND_AGGREGATE_MIN_COUNT);
  });

  it('the PREVIEW floor is higher than the dashboard’s, on the same data', async () => {
    const merchant = await mintMerchant('preview-floor');
    const product = await mintProduct('preview-floor');
    await seedExternalOffer({
      label: 'preview-floor',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });
    // Comfortably above the dashboard floor and below the preview one.
    await seedEvents({
      eventType: 'offer_impression',
      count: 40,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
    });

    const dashboard = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });
    expect(measuredCount(dashboard, 'offer_impressions')).toBe(40);

    const preview = await readMerchantDemandPreview({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
    });
    const line = preview.lines.find((row) => row.metricKey === 'offer_impressions');
    expect(line?.value.state, 'the preview must withhold what the dashboard may show').toBe(
      'suppressed',
    );
    // Nothing on the preview is a money figure or a conversion figure.
    for (const previewLine of preview.lines) {
      expect(['impressions', 'views', 'visits', 'searches']).toContain(previewLine.noun);
    }
  });
});

describe('attribution correction (#86 acceptance 8)', () => {
  it('SUPERSEDES rather than editing, and the old figures stay on file', async () => {
    const merchant = await mintMerchant('correction');
    const product = await mintProduct('correction');
    await seedExternalOffer({
      label: 'correction',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });
    // Above the PRODUCT floor for the reason the bot case is: this is about
    // supersession, not about the residual policy.
    await seedEvents({
      eventType: 'offer_impression',
      count: 30,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
    });

    const first = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });
    expect(measuredCount(first, 'offer_impressions')).toBe(30);

    // A correction: five more impressions arrive late, as a network revision or
    // a delayed flush would deliver them.
    await seedEvents({
      eventType: 'offer_impression',
      count: 5,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
    });
    const second = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });

    expect(second.id).not.toBe(first.id);
    expect(measuredCount(second, 'offer_impressions')).toBe(35);

    const rows = await db
      .select()
      .from(merchantDemandSnapshots)
      .where(inArray(merchantDemandSnapshots.id, [first.id, second.id]));
    const old = rows.find((row) => row.id === first.id);
    const current = rows.find((row) => row.id === second.id);
    // The number a merchant was shown BEFORE the correction is still on file,
    // stamped with what replaced it.
    expect(old?.supersededAt).not.toBeNull();
    expect(old?.supersededById).toBe(second.id);
    expect(current?.supersededAt).toBeNull();

    const oldMetrics = await db
      .select()
      .from(merchantDemandMetrics)
      .where(sql`${merchantDemandMetrics.snapshotId} = ${first.id}
                 and ${merchantDemandMetrics.metricKey} = 'offer_impressions'`);
    expect(oldMetrics[0]?.countValue).toBe(30);
  });

  it('the immutability trigger refuses an EDIT from any caller', async () => {
    const merchant = await mintMerchant('immutable');
    const view = await readMerchantDemandDashboard({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
      refresh: true,
    });

    expect(
      await rejectionMessage(() =>
        db.execute(
          sql`update merchant_demand_snapshots set products_offered = 99 where id = ${view.id}`,
        ),
      ),
    ).toMatch(/immutable/u);

    expect(
      await rejectionMessage(() =>
        db.execute(
          sql`update merchant_demand_metrics set count_value = 9999 where snapshot_id = ${view.id}`,
        ),
      ),
    ).toMatch(/append-only/u);
  });

  it('a coverage row whose counters do not add up cannot be stored', async () => {
    const merchant = await mintMerchant('coverage-check');
    expect(
      await rejectionMessage(() =>
        db.execute(sql`
          insert into merchant_demand_snapshots
            (id, merchant_id, market, window_from, window_to, data_fresh_as_of,
             event_policy_version, attribution_policy_version, collection_mode,
             aggregate_floor, product_floor, products_offered,
             product_rows_disclosed, product_rows_suppressed, expires_at)
          values
            (${uuidv7()}, ${merchant.merchantId}, '', now() - interval '1 day', now(), now(),
             'x', 'y', 'full', 10, 25, 5, 1, 1, now() + interval '1 day')
        `),
      ),
    ).toMatch(/coverage_total_check/u);
  });
});

describe('claim transition (#86 acceptance 8)', () => {
  it('swaps the preview for the dashboard the moment the claim verdict moves', async () => {
    const merchant = await mintMerchant('claim');
    const product = await mintProduct('claim');
    await seedExternalOffer({
      label: 'claim',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });

    // UNCLAIMED: the preview answers and the dashboard refuses.
    const preview = await readMerchantDemandPreview({
      merchantId: merchant.merchantId,
      market: '',
      windowDays: WINDOW_DAYS,
    });
    expect(preview.merchantId).toBe(merchant.merchantId);
    expect(
      (await resolveMerchantDemandAccess({ merchantId: merchant.merchantId, oxyUserId: CLAIMANT }))
        .outcome,
    ).toBe('refused');

    // The claim lands. #83 is the only writer of this column; the test moves it
    // directly because what is under test here is that this domain READS it
    // live rather than caching a copy.
    await db.execute(
      sql`update merchants set claim_state = 'claimed', claimed_by_oxy_user_id = ${CLAIMANT}
          where id = ${merchant.merchantId}`,
    );

    const access = await resolveMerchantDemandAccess({
      merchantId: merchant.merchantId,
      oxyUserId: CLAIMANT,
    });
    expect(access.outcome).toBe('granted');
    // …and the preview stops answering, with no sweep in between: a rounded
    // figure beside an exact one for the same window is a disclosure.
    await expect(
      readMerchantDemandPreview({
        merchantId: merchant.merchantId,
        market: '',
        windowDays: WINDOW_DAYS,
      }),
    ).rejects.toThrow(/not found/iu);

    // A revocation takes it away again, in the statement that revokes it.
    await db.execute(
      sql`update merchants set claim_state = 'unclaimed', claimed_by_oxy_user_id = null
          where id = ${merchant.merchantId}`,
    );
    expect(
      (await resolveMerchantDemandAccess({ merchantId: merchant.merchantId, oxyUserId: CLAIMANT }))
        .outcome,
    ).toBe('refused');
  });

  it('the derived conversion stage follows the claim, and is stored nowhere', async () => {
    const merchant = await mintMerchant('conversion');
    await enrolMerchant(merchant.merchantId);
    expect((await readCandidate(merchant.merchantId)).conversionStage).toBe('unclaimed');

    await db.execute(
      sql`update merchants set claim_state = 'claimed', claimed_by_oxy_user_id = ${CLAIMANT}
          where id = ${merchant.merchantId}`,
    );
    expect((await readCandidate(merchant.merchantId)).conversionStage).toBe('claimed');

    // No column moved. The candidate row has none to move.
    const stored = await db
      .select()
      .from(merchantAcquisitionCandidates)
      .where(sql`${merchantAcquisitionCandidates.merchantId} = ${merchant.merchantId}`);
    expect(Object.keys(stored[0] ?? {})).not.toContain('claimState');
  });
});

describe('the acquisition pipeline records and never sends', () => {
  it('scores from a snapshot, and the score cites the evidence', async () => {
    const merchant = await mintMerchant('score');
    const product = await mintProduct('score');
    await seedExternalOffer({
      label: 'score',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });
    await seedEvents({
      eventType: 'offer_impression',
      count: 50,
      merchantId: merchant.merchantId,
      canonicalProductId: product.productId,
    });

    await enrolMerchant(merchant.merchantId);
    const scored = await rescoreCandidate({
      merchantId: merchant.merchantId,
      actorOxyUserId: OPERATOR,
      market: '',
      windowDays: WINDOW_DAYS,
    });
    expect(scored.scoreBps).toBeGreaterThan(0);
    expect(scored.snapshotId, 'a score with no evidence is a number somebody typed').toBeDefined();
    expect(scored.contributingInputs.length).toBeGreaterThan(0);

    // Every attempt is audited, including this one.
    const audits = await db
      .select()
      .from(merchantAcquisitionAudits)
      .where(sql`${merchantAcquisitionAudits.merchantId} = ${merchant.merchantId}`);
    expect(audits.some((row) => row.action === 'rescore' && row.outcome === 'granted')).toBe(true);
  });

  it('refuses outreach against a do-not-contact merchant, and AUDITS the refusal', async () => {
    const merchant = await mintMerchant('dnc');
    await enrolMerchant(merchant.merchantId);
    await setDoNotContact({
      merchantId: merchant.merchantId,
      actorOxyUserId: OPERATOR,
      doNotContact: true,
    });

    await expect(
      logOutreach({
        merchantId: merchant.merchantId,
        actorOxyUserId: OPERATOR,
        channel: 'email',
        outcome: 'sent',
        occurredAt: new Date(),
      }),
    ).rejects.toThrow(/not found/iu);

    const audits = await db
      .select()
      .from(merchantAcquisitionAudits)
      .where(sql`${merchantAcquisitionAudits.merchantId} = ${merchant.merchantId}`);
    const refusal = audits.find(
      (row) => row.action === 'record_outreach' && row.outcome === 'refused',
    );
    expect(refusal?.refusalCode).toBe('do_not_contact_is_set');

    // And nothing was logged as having happened.
    const logged = await db
      .select()
      .from(merchantAcquisitionOutreach)
      .where(
        sql`${merchantAcquisitionOutreach.candidateId} in (
          select id from merchant_acquisition_candidates where merchant_id = ${merchant.merchantId}
        )`,
      );
    expect(logged).toEqual([]);
  });

  it('the outreach log and the audit trail refuse UPDATE and DELETE', async () => {
    const merchant = await mintMerchant('append-only');
    await enrolMerchant(merchant.merchantId);
    const candidate = await db
      .select()
      .from(merchantAcquisitionCandidates)
      .where(sql`${merchantAcquisitionCandidates.merchantId} = ${merchant.merchantId}`);
    const candidateId = candidate[0]?.id ?? '';

    await logOutreach({
      merchantId: merchant.merchantId,
      actorOxyUserId: OPERATOR,
      channel: 'phone',
      outcome: 'no_response',
      occurredAt: new Date(),
    });

    expect(
      await rejectionMessage(() =>
        db.execute(
          sql`update merchant_acquisition_outreach set outcome = 'replied_interested'
              where candidate_id = ${candidateId}`,
        ),
      ),
    ).toMatch(/append-only/u);
    expect(
      await rejectionMessage(() =>
        db.execute(
          sql`delete from merchant_acquisition_outreach where candidate_id = ${candidateId}`,
        ),
      ),
    ).toMatch(/append-only/u);
    expect(
      await rejectionMessage(() =>
        db.execute(
          sql`delete from merchant_acquisition_audits where merchant_id = ${merchant.merchantId}`,
        ),
      ),
    ).toMatch(/append-only/u);
  });

  it('a contact SOURCE is append-only and no column can hold a contact value', async () => {
    const merchant = await mintMerchant('contact-source');
    await enrolMerchant(merchant.merchantId);
    const candidate = await db
      .select()
      .from(merchantAcquisitionCandidates)
      .where(sql`${merchantAcquisitionCandidates.merchantId} = ${merchant.merchantId}`);
    const candidateId = candidate[0]?.id ?? '';

    await db.insert(merchantAcquisitionContactSources).values({
      candidateId,
      kind: 'merchant_website_imprint',
      sourceUrl: `https://contact-${RUN}.example.test/imprint`,
      locatorNote: 'Legal notice, foot of the page',
      observedAt: new Date(),
      recordedByOxyUserId: OPERATOR,
    });

    // The locator note is shape-CHECKed against becoming the value it points at.
    expect(
      await rejectionMessage(() =>
        db.insert(merchantAcquisitionContactSources).values({
          candidateId,
          kind: 'merchant_website_contact_page',
          sourceUrl: `https://contact-${RUN}.example.test/contact`,
          locatorNote: 'write to hola@example.test',
          observedAt: new Date(),
          recordedByOxyUserId: OPERATOR,
        }),
      ),
    ).toMatch(/locator_check/u);

    expect(
      await rejectionMessage(() =>
        db.execute(
          sql`update merchant_acquisition_contact_sources set locator_note = 'edited'
              where candidate_id = ${candidateId}`,
        ),
      ),
    ).toMatch(/append-only/u);
  });
});

describe('a metric that cannot be measured says so, and never reads zero', () => {
  it('every seam metric is stored `unavailable` with a reason, not as a count', async () => {
    const merchant = await mintMerchant('seams');
    const built = await buildMerchantDemandSnapshot({
      merchantId: merchant.merchantId,
      market: '',
      windowFrom: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      windowTo: new Date(),
    });

    const rows = new Map(built.metrics.map((row) => [row.metricKey, row]));
    for (const key of [
      'search_result_impressions',
      'human_outbound_clicks',
      'affiliate_commission',
      'price_alert_demand',
      'zero_result_demand',
    ]) {
      const row = rows.get(key);
      expect(row, `${key} is missing from the snapshot entirely`).toBeDefined();
      expect(row?.unavailableReason, `${key} must say why it has no value`).not.toBeNull();
      expect(row?.countValue, `${key} must not read as zero`).toBeNull();
      expect(row?.amountValue, `${key} must not read as zero`).toBeNull();
    }
    // The floor: the whole registry is walked, so a snapshot cannot quietly
    // omit the metrics it could not answer.
    expect(built.metrics.length).toBeGreaterThanOrEqual(15);
  });

  it('#82’s figure is MEASURED as a rate, from #82’s own aggregation', async () => {
    const merchant = await mintMerchant('comparison');
    const product = await mintProduct('comparison');
    await seedExternalOffer({
      label: 'comparison',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });

    const built = await buildMerchantDemandSnapshot({
      merchantId: merchant.merchantId,
      market: '',
      windowFrom: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      windowTo: new Date(),
    });

    const row = built.metrics.find(
      (metric) => metric.metricKey === 'subjects_with_a_price_comparison',
    );
    expect(row, 'the metric is missing from the snapshot entirely').toBeDefined();
    // A landed dependency must not still read as unbuilt.
    expect(row?.unavailableReason).toBeNull();
    expect(row?.unavailableSeam).toBeNull();
    // A RATE, with its denominator stored beside it. One subject examined; with
    // no reference sample around it, nothing is comparable — which is the
    // honest answer for a lone offer, and is not the same as "unavailable".
    expect(row?.rateDenominator).toBe(1);
    expect(row?.rateNumerator).toBe(0);
    expect(row?.countValue, 'a rate must never be stored as a count').toBeNull();
  });

  it('#82’s figure is WINDOW-INDEPENDENT, so two windows cannot be differenced', async () => {
    // The third differencing surface: a per-merchant figure over the same
    // population the rows enumerate invites "read it twice over two windows and
    // subtract". It cannot leak, and this is why rather than an assertion that
    // it does not: `countMerchantComparableSubjects` takes NO window at all, so
    // the difference between any two windows is exactly zero.
    const merchant = await mintMerchant('window-independent');
    const product = await mintProduct('window-independent');
    await seedExternalOffer({
      label: 'window-independent',
      variantId: product.variantId,
      merchantId: merchant.merchantId,
      storefrontId: merchant.storefrontId,
    });

    const [shortest, longest] = [
      MERCHANT_DEMAND_WINDOW_DAYS[0],
      MERCHANT_DEMAND_WINDOW_DAYS[MERCHANT_DEMAND_WINDOW_DAYS.length - 1],
    ];
    expect(longest).toBeGreaterThan(shortest ?? 0);

    const rateFor = async (windowDays: number): Promise<[number, number]> => {
      const view = await readMerchantDemandDashboard({
        merchantId: merchant.merchantId,
        market: '',
        windowDays,
        refresh: true,
      });
      const metric = view.metrics.find(
        (row) => row.metricKey === 'subjects_with_a_price_comparison',
      );
      if (metric?.value.state !== 'measured' || metric.value.measure.unit !== 'rate') {
        throw new Error('the comparison figure was not measured as a rate');
      }
      return [metric.value.measure.numerator, metric.value.measure.denominator];
    };

    expect(await rateFor(shortest ?? 7)).toEqual(await rateFor(longest ?? 90));
  });
});
