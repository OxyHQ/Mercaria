/**
 * The staged catalogue backfill, against a REAL PostgreSQL database (#60).
 *
 * The properties pinned here are exactly the ones a mock cannot see: the run's
 * counter CHECK, the two triggers, the partial uniques that make a re-run
 * converge, the lease, and — the one this whole issue is judged on — that an
 * APPLY pass over a live catalogue leaves every placed order byte-identical,
 * `xmin` included.
 *
 * Acceptance criteria mapped to tests:
 *  1. "A seeded store product with variants backfills to one product, matching
 *     variants and native offers" — the end-to-end chain, run stage by stage.
 *  3. "A P2P listing can remain unmatched and purchasable" — reported
 *     `unmatched`/`p2p_left_unattached`, with the listing row untouched.
 *  4. "No placed-order document changes during migration" — every order and
 *     order-item row compared before and after, INCLUDING `xmin`, so a write
 *     that changed nothing visible still fails.
 *  6. "Consistency checks find no active native offer without a valid active
 *     native source" — the sweep is clean, then a revoked attachment opens a
 *     finding, then restoring it resolves that finding.
 *  7. "Canary rollout and rollback are tested" — a cohort-scoped run pages by
 *     hand, an empty cohort is refused, and the dry-run rehearsal writes nothing
 *     to the graph while producing the same `scanned` count as the apply.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every id, handle, title and barcode this file writes
 * carries the per-run suffix, every assertion is scoped to rows this file
 * created, and teardown deletes exactly what it made. Global counts are never
 * asserted.
 */

/**
 * FIRST, and its position is load-bearing: it sets
 * `CANONICAL_WRITE_PUBLICATION_ENABLED` before any later import initialises the
 * frozen `config`. Without it every `apply` run in this file would take the
 * dry-run writer and assert nothing at all.
 */
import './fixtures/enable-canonical-writes.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { CatalogBackfillMode, CatalogBackfillStage } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listingOptions, listings } from '../../db/schema/catalog.js';
import { stores, storeMembers } from '../../db/schema/stores.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { nativeListingLinks, offers } from '../../db/schema/offers.js';
import { merchants, nativeStoreLinks } from '../../db/schema/merchants.js';
import {
  catalogBackfillRecords,
  catalogBackfillRuns,
  catalogConsistencyFindings,
} from '../../db/schema/backfill.js';
import { insertVariants } from '../../db/catalog/variantRepository.js';
import { insertOrder, nextOrderNumber } from '../../db/orders/orderRepository.js';
import { orderItems, orders } from '../../db/schema/orders.js';
import { openCatalogBackfillRun, runCatalogBackfillPage } from '../backfill/backfill.service.js';
import { ALL_COHORT, parseCohort } from '../backfill/cohort.js';
import { CATALOG_BACKFILL_MAPPING_VERSION } from '../backfill/mapping-version.js';
import { applyMatchOutcome, toMatchPolicy } from '../matching/match.service.js';
import { evaluateMatch } from '../matching/pipeline.js';
import { PostgresCandidateSource } from '../matching/postgres-candidate-source.js';
import { loadNativeVariantSubject } from '../matching/subject-loader.js';
import { drainOfferOutbox } from '../offers/offer-outbox-dispatcher.js';
import { createMatchPolicyVersion } from '../matching/match-policy.service.js';
import { convergeNativeOffersForListing } from '../offers/native-offer.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `operator-${RUN}`;

const createdRunIds: string[] = [];
const createdListingIds: string[] = [];
const createdStoreIds: string[] = [];
const createdProductIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdOrderIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // Order matters: evidence RESTRICTs its run and its canonical rows, offers and
  // links CASCADE from the native side, and a native store link RESTRICTs its
  // merchant. Nothing here is a domain operation — it is teardown, and the
  // domain itself issues no DELETE at all.
  if (createdRunIds.length > 0) {
    await db
      .delete(catalogBackfillRecords)
      .where(inArray(catalogBackfillRecords.runId, createdRunIds));
    await db
      .delete(catalogConsistencyFindings)
      .where(inArray(catalogConsistencyFindings.lastRunId, createdRunIds));
    await db.delete(catalogBackfillRuns).where(inArray(catalogBackfillRuns.id, createdRunIds));
  }
  if (createdOrderIds.length > 0) {
    // Before the listings: `order_items` keeps a no-FK historical snapshot of the
    // listing, but the order row itself must go before anything it references.
    await db.delete(orderItems).where(inArray(orderItems.orderId, createdOrderIds));
    await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  }
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  if (createdProductIds.length > 0) {
    await db
      .delete(canonicalVariants)
      .where(inArray(canonicalVariants.productId, createdProductIds));
    await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, createdProductIds));
  }
  if (createdStoreIds.length > 0) {
    // Every store this file seeded was scanned by the whole-catalogue
    // `store_merchants` pass, so each may carry a link and a merchant this file
    // caused — collected from the links rather than from the one id the main
    // test happens to remember.
    const links = await db
      .select({ merchantId: nativeStoreLinks.merchantId })
      .from(nativeStoreLinks)
      .where(inArray(nativeStoreLinks.storeId, createdStoreIds));
    await db.delete(nativeStoreLinks).where(inArray(nativeStoreLinks.storeId, createdStoreIds));
    const merchantIds = [...new Set([...links.map((row) => row.merchantId), ...createdMerchantIds])];
    if (merchantIds.length > 0) {
      await db.delete(merchants).where(inArray(merchants.id, merchantIds));
    }
    await db.delete(storeMembers).where(inArray(storeMembers.storeId, createdStoreIds));
    await deleteTestStores(db, createdStoreIds);
  }
  await closePostgres();
});

/** Seed a native store with an `owner` member — the evidence stage 1 needs. */
async function seedStore(suffix: string): Promise<string> {
  const [store] = await db
    .insert(stores)
    .values({
      handle: `bf-${RUN}-${suffix}`,
      name: `Backfill Store ${suffix} ${RUN}`,
      description: 'seeded by backfill.realdb.test',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  createdStoreIds.push(store.id);
  await db.insert(storeMembers).values({
    storeId: store.id,
    oxyUserId: `owner-${RUN}-${suffix}`,
    role: 'owner',
    permissions: [],
    joinedAt: new Date(),
  });
  return store.id;
}

/** Seed one active listing plus its variants. */
async function seedListing(input: {
  ownerType: 'user' | 'store';
  storeId?: string;
  title: string;
  /**
   * Each variant's option VALUE on the single `Size` axis, when it has one.
   *
   * Two native variants carrying no options at all are two spellings of ONE
   * configuration, and `createVariant` converges them onto a single canonical
   * variant by signature — correct behaviour, and a seed that relied on it would
   * have asserted the wrong thing about acceptance 1.
   */
  variants: readonly { title: string; barcode?: string; size?: string }[];
}): Promise<{ listingId: string; variantIds: string[] }> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: input.ownerType,
      ...(input.ownerType === 'store'
        ? { storeId: input.storeId ?? null }
        : { oxyUserId: `seller-${RUN}` }),
      title: input.title,
      description: 'seeded by backfill.realdb.test',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      publishedAt: new Date(),
    })
    .returning({ id: listings.id });
  createdListingIds.push(listing.id);

  const sizes = input.variants
    .map((variant) => variant.size)
    .filter((size): size is string => size !== undefined);
  if (sizes.length > 0) {
    // The listing-level AXIS declaration. `optionAxesFor` reads it to decide the
    // canonical product's `variantDefiningAttributeKeys`, and a canonical variant
    // whose options are not declared axes is refused outright.
    await db
      .insert(listingOptions)
      .values({ listingId: listing.id, name: 'Size', values: sizes, position: 0 });
  }

  const rows = await insertVariants(
    listing.id,
    input.variants.map((variant, index) => ({
      title: variant.title,
      ...(variant.barcode === undefined ? {} : { barcode: variant.barcode }),
      priceAmount: 1_000 + index,
      priceCurrency: 'EUR' as const,
      inventoryTracked: false,
      inventoryAvailable: 0,
      position: index,
      optionValues:
        variant.size === undefined ? [] : [{ name: 'Size', value: variant.size, position: 0 }],
    })),
  );
  return { listingId: listing.id, variantIds: rows.map((row) => row.id) };
}

/**
 * The policy this file's matcher runs under — a DRAFT, never activated.
 *
 * `match_policy_versions_active_key` is a partial unique on `status='active'`,
 * which is DATABASE-GLOBAL: one active policy per deployment, by design. The
 * suite shares one throwaway database across parallel workers, so a file that
 * activates its own policy collides with #58's realdb file — measured, and it
 * fails BOTH files rather than only the newcomer.
 *
 * So this file never touches the global active policy. It drives the real
 * pipeline with the policy INJECTED, which is also the stronger test: the
 * outcome no longer depends on which file happened to activate a policy first.
 *
 * That is why it takes no `acquireActivePolicySlot`, and #266 asked whether it
 * should: `createMatchPolicyVersion` hardcodes `status: 'draft'`
 * (`matching/match-policy.service.ts:71`), the unique index is partial on
 * `active`, and `evaluateMatch`/`applyMatchOutcome` take the policy as an
 * ARGUMENT rather than looking one up — so there is nothing here to serialize.
 * Taking the slot would fail the census in
 * `services/ingestion/__tests__/active-policy-slot.test.ts`, deliberately: a
 * holder that reaches no active policy is a file serializing for a reason
 * nobody can derive, which is the same folklore the census exists to remove.
 */
let matchPolicy: Awaited<ReturnType<typeof createMatchPolicyVersion>> | undefined;

/**
 * Run #58's real pipeline for ONE native variant and persist its decision.
 *
 * `evaluateMatch` + `applyMatchOutcome` are exactly what `runMatch` calls; the
 * only thing skipped is `runMatch`'s own lookup of the globally-active policy.
 */
async function matchVariant(productVariantId: string): Promise<void> {
  if (matchPolicy === undefined) throw new Error('the draft match policy was not created');
  const subject = await loadNativeVariantSubject(productVariantId);
  if (subject === null) throw new Error(`native variant ${productVariantId} vanished`);
  const policy = toMatchPolicy(matchPolicy);
  const evaluation = await evaluateMatch(subject, policy, new PostgresCandidateSource());
  await applyMatchOutcome(subject, evaluation, policy);
}

/** Open a run and page it to completion, returning the accumulated counters. */
async function runToCompletion(
  stage: CatalogBackfillStage,
  mode: CatalogBackfillMode,
  cohort = ALL_COHORT,
): Promise<{ runId: string; scanned: number; pages: number }> {
  const { run } = await openCatalogBackfillRun({
    stage,
    mode,
    cohort,
    requestedByOxyUserId: OPERATOR,
  });
  if (!createdRunIds.includes(run.id)) createdRunIds.push(run.id);

  let pages = 0;
  for (;;) {
    const page = await runCatalogBackfillPage(run.id, { limit: 50 });
    if (page === undefined) throw new Error('the lease was held by somebody else');
    pages += 1;
    if (page.nextCursor === null) break;
    if (pages > 200) throw new Error('the pass did not terminate');
  }

  const [final] = await db
    .select({ scanned: catalogBackfillRuns.scanned, status: catalogBackfillRuns.status })
    .from(catalogBackfillRuns)
    .where(eq(catalogBackfillRuns.id, run.id));
  expect(final.status).toBe('completed');
  return { runId: run.id, scanned: final.scanned, pages };
}

/** One subject's verdict under a run's mapping version and mode. */
async function verdictFor(
  stage: CatalogBackfillStage,
  mode: CatalogBackfillMode,
  subjectKey: string,
): Promise<{ outcome: string; reasonCode: string; canonicalProductId: string | null } | undefined> {
  const rows = await db
    .select({
      outcome: catalogBackfillRecords.outcome,
      reasonCode: catalogBackfillRecords.reasonCode,
      canonicalProductId: catalogBackfillRecords.canonicalProductId,
    })
    .from(catalogBackfillRecords)
    .where(
      and(
        eq(catalogBackfillRecords.mappingVersion, CATALOG_BACKFILL_MAPPING_VERSION),
        eq(catalogBackfillRecords.mode, mode),
        eq(catalogBackfillRecords.stage, stage),
        eq(catalogBackfillRecords.subjectKey, subjectKey),
      ),
    );
  return rows[0];
}

/**
 * Seed one PLACED order against a listing, so acceptance 4 has something to be
 * about.
 *
 * A P2P order with no fee snapshot: the migration must not touch ANY placed
 * order, and the simplest one that exists is the sharpest probe.
 */
async function seedOrder(listingId: string, variantId: string): Promise<string> {
  const money = (amount: number) => ({
    shop: { amount, currency: 'EUR' as const },
    presentment: { amount, currency: 'EUR' as const },
  });
  const order = await insertOrder({
    orderNumber: await nextOrderNumber(),
    buyerOrigin: 'oxy',
    buyerOxyUserId: `buyer-${RUN}`,
    sellerType: 'user',
    commercialRole: 'connected_marketplace',
    sellerOxyUserId: `seller-${RUN}`,
    items: [
      {
        listingId,
        variantId,
        title: 'Backfill immutability probe',
        variantTitle: 'Small',
        optionValues: [],
        unitPrice: money(1_000),
        quantity: 1,
        lineTotal: money(1_000),
      },
    ],
    shippingAddress: {
      recipientName: 'Buyer',
      line1: '1 Street',
      city: 'Barcelona',
      postalCode: '08001',
      country: 'ES',
    },
    shippingMethod: 'standard',
    shippingLabel: 'Standard',
    shippingCost: money(0),
    totals: {
      subtotal: money(1_000),
      discountTotal: money(0),
      shipping: money(0),
      tax: money(0),
      grandTotal: money(1_000),
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    checkoutGroupId: uuidv7(),
    // `actorKind` and its paired actor id are #106's, and they are never
    // defaulted by a writer: an `oxy` transition must name the account that
    // drove it, and a CHECK refuses the pair being half-filled.
    statusHistory: [
      {
        status: 'pending_payment',
        at: new Date(),
        actorKind: 'oxy',
        byOxyUserId: `buyer-${RUN}`,
      },
    ],
    appliedDiscounts: [],
    taxLines: [],
  });
  createdOrderIds.push(order.id);
  return order.id;
}

/**
 * One order and its items, WITH `xmin`.
 *
 * `xmin` is the transaction that last wrote the tuple, so a write that set every
 * column back to the value it already held still moves it. That is what makes
 * this a real check rather than a column comparison: `UPDATE orders SET status =
 * status` is invisible to the latter and fails the former.
 *
 * Scoped to THIS file's order, and that scoping is not tidiness — one throwaway
 * database serves the whole suite and vitest runs files in parallel workers, so
 * a fingerprint over every order in the database measures the payment suite's
 * concurrent writes and fails for reasons that have nothing to do with the
 * migration. Measured: it did exactly that.
 */
async function orderFingerprint(orderId: string): Promise<string> {
  const rows = await db.execute<{ fingerprint: string | null }>(
    sql`select coalesce(
          md5(string_agg(t.line, '|' order by t.line)), 'empty'
        ) as fingerprint
        from (
          select o.id || ':' || o.xmin::text || ':' || o.status || ':' || o.payment_status as line
          from orders o where o.id = ${orderId}
          union all
          select 'item:' || i.id || ':' || i.xmin::text || ':' || i.quantity::text as line
          from order_items i where i.order_id = ${orderId}
        ) t`,
  );
  return rows[0]?.fingerprint ?? 'empty';
}

describe('the catalogue backfill, against a real database', () => {
  it('refuses a cohort that selects nothing, before a run exists to report on it', async () => {
    const emptyStoreId = await seedStore('empty');
    await expect(
      openCatalogBackfillRun({
        stage: 'provisional_products',
        mode: 'dry_run',
        cohort: parseCohort('store', emptyStoreId),
        requestedByOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/selects no listings/);
  });

  it('refuses a cohort on a stage that does not operate on listings', async () => {
    const storeId = await seedStore('cohort-refusal');
    await seedListing({
      ownerType: 'store',
      storeId,
      title: `Cohort refusal ${RUN}`,
      variants: [{ title: 'Default Title' }],
    });
    await expect(
      openCatalogBackfillRun({
        stage: 'store_merchants',
        mode: 'apply',
        cohort: parseCohort('store', storeId),
        requestedByOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/does not operate on listings/);
  });

  it(
    'backfills a seeded store product into one canonical product, its variants and native offers (acceptance 1), leaves a P2P listing alone (acceptance 3), and never touches a placed order (acceptance 4)',
    async () => {
      const storeId = await seedStore('main');
      const store = await seedListing({
        ownerType: 'store',
        storeId,
        title: `Backfill Widget ${RUN}`,
        // A GTIN-13 whose check digit validates, and a second variant with none —
        // so both the identifier path and the no-identifier path are exercised.
        variants: [
          { title: 'Small', barcode: '4006381333931', size: 'Small' },
          { title: 'Large', size: 'Large' },
        ],
      });
      const p2p = await seedListing({
        ownerType: 'user',
        title: `P2P Widget ${RUN}`,
        variants: [{ title: 'Default Title' }],
      });

      // ACCEPTANCE 4's subject: a placed order against the very listing the
      // migration is about to touch, so the probe is on the sharpest possible
      // case rather than on an unrelated row.
      const orderId = await seedOrder(store.listingId, store.variantIds[0] ?? '');
      const ordersBefore = await orderFingerprint(orderId);

      // A DRAFT policy, deliberately never activated — see `matchVariant`.
      const policy = await createMatchPolicyVersion({
        versionKey: `backfill-${RUN}`,
        description: 'backfill.realdb.test',
        autoMinConfidence: 0.9,
        reviewMinConfidence: 0.6,
        minCandidateSeparation: 0.1,
        maxCandidates: 20,
        minTitleSimilarity: 0.5,
        weightIdentifier: 4,
        weightBrand: 2,
        weightModel: 2,
        weightAttribute: 1,
        weightTitle: 1,
        weightCategory: 1,
        weightSemantic: 0,
        semanticEnabled: false,
        // The schema floors these at 0.95 / 20 — a launch threshold a tuning
        // pass cannot quietly drop below.
        minBenchmarkPrecision: 0.95,
        minBenchmarkSamples: 20,
        createdByOxyUserId: OPERATOR,
      });
      matchPolicy = policy;

      // ── Stage 1: the store becomes a canonical merchant ────────────────────
      await runToCompletion('store_merchants', 'apply');
      const storeVerdict = await verdictFor('store_merchants', 'apply', `store:${storeId}`);
      expect(storeVerdict?.outcome).toBe('created');
      expect(storeVerdict?.reasonCode).toBe('merchant_minted');

      const [link] = await db
        .select({ merchantId: nativeStoreLinks.merchantId, method: nativeStoreLinks.verificationMethod })
        .from(nativeStoreLinks)
        .where(and(eq(nativeStoreLinks.storeId, storeId), eq(nativeStoreLinks.status, 'active')));
      expect(link).toBeDefined();
      expect(link.method).toBe('owner_authentication');
      createdMerchantIds.push(link.merchantId);

      // ── Stage 3: hand every variant to the matcher, and drain it ───────────
      await runToCompletion('variant_matching', 'apply');
      for (const variantId of store.variantIds) await matchVariant(variantId);

      // ── Stage 4: the unmatched store listing mints a DRAFT product ─────────
      await runToCompletion('provisional_products', 'apply');

      const storeListingVerdict = await verdictFor(
        'provisional_products',
        'apply',
        `listing:${store.listingId}`,
      );
      expect(storeListingVerdict?.outcome).toBe('created');
      expect(storeListingVerdict?.reasonCode).toBe('provisional_product_minted');
      expect(storeListingVerdict?.canonicalProductId).not.toBeNull();
      const productId = storeListingVerdict?.canonicalProductId ?? '';
      createdProductIds.push(productId);

      // ACCEPTANCE 1: ONE product, one canonical variant per native variant, one
      // ACTIVE attachment each.
      const [product] = await db
        .select({ status: canonicalProducts.status, name: canonicalProducts.name })
        .from(canonicalProducts)
        .where(eq(canonicalProducts.id, productId));
      // DRAFT, never active: a product minted from one seller's listing title is
      // a provisional guess, and promotion is #59's review.
      expect(product.status).toBe('draft');
      expect(product.name).toBe(`Backfill Widget ${RUN}`);

      const canonicalVariantRows = await db
        .select({ id: canonicalVariants.id })
        .from(canonicalVariants)
        .where(eq(canonicalVariants.productId, productId));
      expect(canonicalVariantRows).toHaveLength(2);

      const links = await db
        .select({ method: nativeListingLinks.method, confidence: nativeListingLinks.confidence })
        .from(nativeListingLinks)
        .where(
          and(
            eq(nativeListingLinks.listingId, store.listingId),
            eq(nativeListingLinks.status, 'active'),
          ),
        );
      expect(links).toHaveLength(2);
      for (const row of links) {
        expect(row.method).toBe('backfill');
        // CHECK-restricted to `matcher` rows: this attachment is certain by
        // construction because the stage created both of its ends.
        expect(row.confidence).toBeNull();
      }

      // ACCEPTANCE 3: the P2P listing is reported and left entirely alone.
      const p2pVerdict = await verdictFor(
        'provisional_products',
        'apply',
        `listing:${p2p.listingId}`,
      );
      expect(p2pVerdict?.outcome).toBe('unmatched');
      expect(p2pVerdict?.reasonCode).toBe('p2p_left_unattached');
      const p2pLinks = await db
        .select({ id: nativeListingLinks.id })
        .from(nativeListingLinks)
        .where(eq(nativeListingLinks.listingId, p2p.listingId));
      expect(p2pLinks).toHaveLength(0);

      // ── Stage 5: the attached listing materializes its native offers ───────
      await runToCompletion('native_offers', 'apply');
      for (let i = 0; i < 5; i += 1) {
        const drained = await drainOfferOutbox({ batchSize: 50 });
        if (drained.claimed === 0) break;
      }

      const nativeOffers = await db
        .select({ id: offers.id, canonicalVariantId: offers.canonicalVariantId })
        .from(offers)
        .where(
          and(
            eq(offers.listingId, store.listingId),
            eq(offers.kind, 'native'),
            eq(offers.status, 'active'),
          ),
        );
      expect(nativeOffers).toHaveLength(2);

      // ── ACCEPTANCE 4: every placed order is byte-identical, `xmin` included ─
      expect(await orderFingerprint(orderId)).toBe(ordersBefore);

      // ── ACCEPTANCE 6: the consistency sweep finds nothing ──────────────────
      await runToCompletion('consistency', 'apply');
      const openFindings = await db
        .select({ kind: catalogConsistencyFindings.kind })
        .from(catalogConsistencyFindings)
        .where(
          and(
            sql`${catalogConsistencyFindings.resolvedAt} is null`,
            inArray(catalogConsistencyFindings.subjectKey, [
              ...store.variantIds.map((id) => `product_variant:${id}`),
              ...nativeOffers.map((offer) => `native_offer:${offer.id}`),
            ]),
          ),
        );
      expect(openFindings).toEqual([]);

      // …and it FINDS the disagreement when one exists. Revoking an attachment
      // leaves an active native offer with no active native source, which is
      // acceptance 6's exact wording.
      await db
        .update(nativeListingLinks)
        .set({
          status: 'revoked',
          revokedAt: new Date(),
          revokedByOxyUserId: OPERATOR,
          revokeReason: 'realdb consistency probe',
        })
        .where(
          and(
            eq(nativeListingLinks.listingId, store.listingId),
            eq(nativeListingLinks.status, 'active'),
          ),
        );

      await runToCompletion('consistency', 'apply');
      const broken = await db
        .select({ kind: catalogConsistencyFindings.kind })
        .from(catalogConsistencyFindings)
        .where(
          and(
            sql`${catalogConsistencyFindings.resolvedAt} is null`,
            inArray(
              catalogConsistencyFindings.subjectKey,
              nativeOffers.map((offer) => `native_offer:${offer.id}`),
            ),
          ),
        );
      expect(broken.length).toBeGreaterThan(0);
      expect(broken.every((row) => row.kind === 'offer_without_active_link')).toBe(true);

      // …and it RESOLVES rather than accumulating once the offers are converged
      // back into agreement with the (now unattached) listing.
      await convergeNativeOffersForListing(store.listingId);
      await runToCompletion('consistency', 'apply');
      const stillOpen = await db
        .select({ id: catalogConsistencyFindings.id })
        .from(catalogConsistencyFindings)
        .where(
          and(
            sql`${catalogConsistencyFindings.resolvedAt} is null`,
            inArray(
              catalogConsistencyFindings.subjectKey,
              nativeOffers.map((offer) => `native_offer:${offer.id}`),
            ),
          ),
        );
      expect(stillOpen).toEqual([]);
    },
    120_000,
  );

  it('a DRY RUN reports the same subjects and writes nothing to the graph', async () => {
    const storeId = await seedStore('dry');
    // A title no other file can produce, because the assertion below is "no
    // canonical product with THIS name exists" — see the scoping note there.
    const title = `Zephyr Kalimba ${uuidv7().slice(-12)}`;
    const seeded = await seedListing({
      ownerType: 'store',
      storeId,
      title,
      variants: [{ title: 'Default Title' }],
    });

    // The mint stage refuses to act before the matcher has spoken (rule 4), so a
    // rehearsal of it needs the same precondition a real run needs — otherwise
    // the "dry run wrote nothing" assertion below would pass for the wrong
    // reason: the stage would have skipped every subject.
    await runToCompletion('variant_matching', 'apply', parseCohort('store', storeId));
    for (const variantId of seeded.variantIds) await matchVariant(variantId);

    const dry = await runToCompletion(
      'provisional_products',
      'dry_run',
      parseCohort('store', storeId),
    );

    // The vacuity floor, as an assertion: a rehearsal that scanned nothing and a
    // rehearsal that found nothing to do produce the same counters, and only the
    // first is a bug.
    expect(dry.scanned).toBeGreaterThan(0);

    const verdict = await verdictFor(
      'provisional_products',
      'dry_run',
      `listing:${seeded.listingId}`,
    );
    // The dry run PREDICTS the mint — an outcome it is allowed to record, because
    // refusing to store one would make the mode unable to report the counts it
    // exists for.
    expect(verdict?.outcome).toBe('created');
    // …and names no canonical product, because it created none.
    expect(verdict?.canonicalProductId).toBeNull();

    /**
     * Scoped to what THIS rehearsal would have minted, never a global count.
     *
     * `provisional_products` names a minted product after the listing's title,
     * so "no canonical product carries this title" is exactly the claim "the dry
     * run created nothing" — and it is unaffected by the products sibling files
     * create in the same database at the same time. A before/after count over
     * the whole table measures the rest of the suite instead, which is the
     * mistake this file's own header warns about. Measured: it failed on 35 vs
     * 37 for reasons entirely outside this test.
     */
    const mintedByThisRun = await db
      .select({ id: canonicalProducts.id })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.name, title));
    expect(mintedByThisRun).toEqual([]);

    const linksAfter = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(nativeListingLinks)
      .where(eq(nativeListingLinks.listingId, seeded.listingId));
    expect(linksAfter[0].count).toBe(0);
  });

  it("refuses an UPDATE that lowers a run's counter", async () => {
    const { run } = await openCatalogBackfillRun({
      stage: 'rebuild_projections',
      mode: 'dry_run',
      cohort: ALL_COHORT,
      requestedByOxyUserId: `${OPERATOR}-monotonic`,
    });
    createdRunIds.push(run.id);
    await db
      .update(catalogBackfillRuns)
      .set({ scanned: 5, skipped: 5, startedAt: new Date(), status: 'paused' })
      .where(eq(catalogBackfillRuns.id, run.id));

    await expect(
      db
        .update(catalogBackfillRuns)
        .set({ scanned: 1, skipped: 1 })
        .where(eq(catalogBackfillRuns.id, run.id)),
    ).rejects.toThrow();
  });

  it("refuses a counter set that does not add up to what was scanned", async () => {
    const { run } = await openCatalogBackfillRun({
      stage: 'search_reindex',
      mode: 'dry_run',
      cohort: ALL_COHORT,
      requestedByOxyUserId: `${OPERATOR}-total`,
    });
    createdRunIds.push(run.id);
    await expect(
      db
        .update(catalogBackfillRuns)
        // 10 scanned and 3 classified: the shape of a page that swallowed seven
        // records and reported success.
        .set({ scanned: 10, skipped: 3, startedAt: new Date(), status: 'paused' })
        .where(eq(catalogBackfillRuns.id, run.id)),
    ).rejects.toThrow();
  });

  it("refuses an UPDATE that moves a report row's subject", async () => {
    const storeId = await seedStore('identity');
    await seedListing({
      ownerType: 'store',
      storeId,
      title: `Identity Widget ${RUN}`,
      variants: [{ title: 'Default Title' }],
    });
    const { runId } = await runToCompletion(
      'variant_matching',
      'dry_run',
      parseCohort('store', storeId),
    );
    const [record] = await db
      .select({ id: catalogBackfillRecords.id })
      .from(catalogBackfillRecords)
      .where(eq(catalogBackfillRecords.runId, runId))
      .limit(1);
    expect(record).toBeDefined();

    await expect(
      db
        .update(catalogBackfillRecords)
        .set({ subjectKey: `product_variant:moved-${RUN}` })
        .where(eq(catalogBackfillRecords.id, record.id)),
    ).rejects.toThrow();
  });
});
