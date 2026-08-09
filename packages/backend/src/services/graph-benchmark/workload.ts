/**
 * The fourteen query shapes #61 names, expressed as INVOCATIONS OF THE REAL
 * READERS rather than as SQL somebody transcribed.
 *
 * ## Why a shape is a function call and not a string
 *
 * The obvious way to benchmark a query is to paste its SQL into the harness.
 * That paste is a SECOND SPELLING of the read, and the moment it drifts the
 * benchmark reports a number for a query production does not run — silently, and
 * in the direction that flatters whoever wrote the paste. Every entry in
 * {@link WORKLOAD_SHAPES} therefore calls the repository function the API calls,
 * against a handle that RECORDS the statements postgres.js actually sent (see
 * `runner.ts`), and the recorded statement is what gets EXPLAINed. There is no
 * transcription anywhere in the loop, so there is nothing to drift.
 *
 * It also means a shape cannot outlive its reader: delete the function and this
 * file stops compiling.
 *
 * ## The two lists are different KINDS, not one list with a flag
 *
 * {@link WORKLOAD_SHAPES} are reads Mercaria performs. {@link EXPLORATORY_SHAPES}
 * are shapes #61 was asked to compare that NO shipped code path runs — a
 * merchant page whose reader belongs to #84, a per-product cheapest-offer
 * ranking whose reader belongs to #74. Keeping them in separate exports with
 * different types is what stops an exploratory number being quoted as a
 * production latency, and what lets the plan-regression suite consume the first
 * list wholesale without having to remember which entries were real.
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findCanonicalProductBySlug } from '../../db/canonical/canonicalProductRepository.js';
import { listProductsForBrand } from '../../db/canonical/canonicalProductRepository.js';
import { findCanonicalProductIdsByNormalizedAlias } from '../../db/canonical/canonicalProductRepository.js';
import { searchCanonicalProductsByNameSimilarity } from '../../db/canonical/canonicalProductRepository.js';
import { listVariantsForProduct } from '../../db/canonical/canonicalVariantRepository.js';
import { findActiveCanonicalOwner } from '../../db/canonical/productIdentifierRepository.js';
import { listProductsForFamily } from '../../db/canonical/canonicalProductRepository.js';
import {
  listOffersForComparison,
  listLapsedExternalOfferCandidates,
} from '../../db/offers/offerRepository.js';
import { findCurrentRelationships } from '../../db/commerce-graph/relationshipRepository.js';
import { listPendingMatchReviews } from '../../db/matching/matchDecisionRepository.js';
import { listBackfillRecordsForRun } from '../../db/backfill/backfillRecordRepository.js';
import { searchListingsPage } from '../../db/catalog/listingRepository.js';
import { offers } from '../../db/schema/offers.js';
import { canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import type { SeededGraph } from './dataset.js';
import type { ShapeExpectation } from './measure.js';

/** One measured read. */
export interface WorkloadShape {
  /** Stable handle, quoted by the report and by the plan-regression suite. */
  readonly id: string;
  /** The numbered entry in #61's "Required query workload" this answers. */
  readonly workloadItem: number;
  readonly title: string;
  /** The real reader, `path::exportName`. A test asserts it resolves. */
  readonly reader: string;
  readonly expectation: ShapeExpectation;
  /**
   * Whether running this shape WRITES. A mutating shape is EXPLAINed inside a
   * transaction the runner rolls back — `EXPLAIN ANALYZE` really executes, so
   * measuring the sweep fifty times outside one would retire fifty pages of
   * offers and every run after the first would measure an empty predicate.
   */
  readonly mutates?: boolean;
  readonly run: (db: DatabaseOrTransaction, graph: SeededGraph) => Promise<unknown>;
}

/**
 * A shape #61 asks about that is NOT measured as a shipped read.
 *
 * Two reasons qualify, and both must be stated rather than implied: nothing in
 * `services/` runs the shape at all (a merchant page, a per-product ranking),
 * or a shipped reader runs it only as a FRAGMENT of a larger statement measured
 * whole in {@link WORKLOAD_SHAPES}. Either way the figure must not be read as a
 * latency any request currently pays, which is why these live in their own
 * export with their own type.
 */
export interface ExploratoryShape {
  readonly id: string;
  readonly workloadItem: number;
  readonly title: string;
  /** Why it is not a shipped-read measurement, naming the issue that owns it. */
  readonly provenance: string;
  readonly expectation: ShapeExpectation;
  readonly build: (graph: SeededGraph) => SQL;
}

/** How many rows a page-shaped read asks for. The API's own default. */
const PAGE = 20;

export const WORKLOAD_SHAPES: readonly WorkloadShape[] = [
  {
    id: 'Q01',
    workloadItem: 1,
    title: 'Canonical product by slug',
    reader: 'db/canonical/canonicalProductRepository.ts::findCanonicalProductBySlug',
    expectation: {
      minRowsReturned: 1,
      requireIndexes: ['canonical_products_slug_key'],
      forbidNodeTypes: ['Seq Scan'],
    },
    run: (db, graph) => findCanonicalProductBySlug(db, graph.hottestProductSlug),
  },
  {
    id: 'Q02',
    workloadItem: 2,
    title: 'Product by GTIN — the identifier collision gate',
    reader: 'db/canonical/productIdentifierRepository.ts::findActiveCanonicalOwner',
    expectation: {
      minRowsReturned: 1,
      requireIndexes: ['product_identifiers_canonical_active_key'],
      forbidNodeTypes: ['Seq Scan'],
    },
    run: (db, graph) => findActiveCanonicalOwner(db, 'gtin', graph.knownGtinCanonical),
  },
  {
    id: 'Q03',
    workloadItem: 3,
    title: 'Product by model alias',
    reader: 'db/canonical/canonicalProductRepository.ts::findCanonicalProductIdsByNormalizedAlias',
    expectation: {
      minRowsReturned: 1,
      requireIndexes: ['canonical_product_aliases_alias_idx'],
      forbidNodeTypes: ['Seq Scan'],
    },
    run: (db, graph) => findCanonicalProductIdsByNormalizedAlias(db, graph.knownAlias),
  },
  {
    id: 'Q04',
    workloadItem: 4,
    title: 'Product with its canonical variants',
    reader: 'db/canonical/canonicalVariantRepository.ts::listVariantsForProduct',
    expectation: {
      minRowsReturned: 1,
      requireIndexes: ['canonical_variants_product_id_idx'],
      forbidNodeTypes: ['Seq Scan'],
    },
    run: (db, graph) => listVariantsForProduct(db, graph.hottestProductId),
  },
  {
    id: 'Q05',
    workloadItem: 5,
    title: 'Variant with active offers, cheapest first — the worst variant',
    reader: 'db/offers/offerRepository.ts::listOffersForComparison',
    expectation: { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    run: (db, graph) =>
      listOffersForComparison(db, { canonicalVariantId: graph.hottestVariantId, limit: PAGE }),
  },
  {
    id: 'Q06',
    workloadItem: 6,
    title: 'Best eligible offers for one market, stale excluded',
    reader: 'db/offers/offerRepository.ts::listOffersForComparison',
    expectation: { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    run: (db, graph) =>
      listOffersForComparison(db, {
        canonicalVariantId: graph.hottestVariantId,
        country: graph.market,
        excludeStale: true,
        limit: PAGE,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
  },
  {
    id: 'Q07',
    workloadItem: 7,
    title: 'Brand page — the products of the biggest brand',
    reader: 'db/canonical/canonicalProductRepository.ts::listProductsForBrand',
    expectation: { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    run: (db, graph) => listProductsForBrand(db, graph.biggestBrandId, PAGE),
  },
  {
    id: 'Q08',
    workloadItem: 7,
    title: 'Family page — every live product of one family',
    reader: 'db/canonical/canonicalProductRepository.ts::listProductsForFamily',
    expectation: { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    run: (db, graph) => listProductsForFamily(db, graph.biggestFamilyId),
  },
  {
    id: 'Q09',
    workloadItem: 9,
    title: 'Official channels and resellers for a brand in one market',
    reader: 'db/commerce-graph/relationshipRepository.ts::findCurrentRelationships',
    expectation: {
      minRowsReturned: 1,
      requireIndexes: ['commerce_relationships_brand_idx'],
      forbidNodeTypes: ['Seq Scan'],
    },
    run: (db, graph) =>
      findCurrentRelationships(db, {
        kinds: ['merchant_official_channel_for_brand', 'merchant_authorized_reseller_for_brand'],
        brandId: 'bx-brand-0',
        market: graph.market,
        at: new Date('2026-01-01T00:00:00.000Z'),
      }),
  },
  {
    id: 'Q10',
    workloadItem: 10,
    title: 'Search candidate generation — trigram similarity over product names',
    reader:
      'db/canonical/canonicalProductRepository.ts::searchCanonicalProductsByNameSimilarity',
    /**
     * NO index requirement and NO forbidden node, and that is the measurement
     * rather than a gap in it.
     *
     * `pg_trgm`'s `%` operator has a real GIN index behind it and the planner
     * still prefers a sequential scan while the table is small — a GIN scan
     * pays a startup cost a ten-thousand-row heap does not justify. Which side
     * of that line a scale falls on is exactly what the report is for, so
     * pinning either answer here would turn a scale-dependent fact into a
     * failing build on the scale that disagrees.
     */
    expectation: { minRowsReturned: 1 },
    run: (db, graph) => searchCanonicalProductsByNameSimilarity(db, graph.knownProductName, 25),
  },
  {
    id: 'Q11',
    workloadItem: 11,
    title: 'The #59 review inbox — decisions waiting for a person',
    reader: 'db/matching/matchDecisionRepository.ts::listPendingMatchReviews',
    expectation: {
      minRowsReturned: 1,
      requireIndexes: ['match_decisions_review_idx'],
      forbidNodeTypes: ['Seq Scan'],
    },
    run: (db, graph) =>
      listPendingMatchReviews(db, { policyVersionId: graph.matchPolicyVersionId, limit: 50 }),
  },
  {
    id: 'Q12',
    workloadItem: 11,
    title: 'Backfill evidence for one run, worst outcomes',
    reader: 'db/backfill/backfillRecordRepository.ts::listBackfillRecordsForRun',
    expectation: { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    run: (db, graph) =>
      listBackfillRecordsForRun(
        { runId: graph.backfillRunId, outcome: 'review_required', limit: 100 },
        db,
      ),
  },
  {
    id: 'Q13',
    workloadItem: 12,
    title: 'Offer freshness sweep — find what lapsed',
    reader: 'db/offers/offerRepository.ts::listLapsedExternalOfferCandidates',
    // The sweep's whole job is to find lapsed rows; if it returns none the seed
    // produced no lapsed offers and every number below is about an empty
    // predicate. This is the shape whose floor matters most, because "nothing
    // to do" is also what a healthy production sweep reports.
    //
    // #68 made the sweep a READ: whether a lapsed offer may be retired now
    // depends on its source's grace window and current health, which no single
    // UPDATE can join without re-implementing the policy in SQL. So this shape
    // no longer mutates, and what it measures is the candidate scan plus the
    // provenance join the policy lookup needs.
    expectation: { minRowsReturned: 1 },
    run: (db) =>
      listLapsedExternalOfferCandidates(db, {
        limit: 500,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
  },
  {
    id: 'Q14',
    workloadItem: 13,
    title: 'Nearby listings within 5 km, with free text',
    reader: 'db/catalog/listingRepository.ts::searchListingsPage',
    // Same reasoning as Q10: the tsvector GIN and the geo GiST are both real,
    // and which one the planner leads with depends on the selectivity of the
    // radius against the term at this scale.
    expectation: { minRowsReturned: 1 },
    run: (db) =>
      searchListingsPage(
        { text: 'bicycle', near: { lng: 2.17, lat: 41.38, radiusM: 5_000 } },
        'newest',
        1,
        PAGE,
        db,
      ),
  },
  {
    id: 'Q15',
    workloadItem: 14,
    title: 'Product page under full offer fan-out — the semi-join through variants',
    reader: 'db/offers/offerRepository.ts::listOffersForComparison',
    expectation: { minRowsReturned: 1, forbidNodeTypes: ['Seq Scan'] },
    run: (db, graph) =>
      listOffersForComparison(db, { canonicalProductId: graph.hottestProductId, limit: PAGE }),
  },
];

/**
 * `Number.MAX_SAFE_INTEGER` — where an unpriced offer sorts, repeated here for
 * the exploratory ranking comparison only.
 *
 * `offerRepository.UNPRICED_SORT_KEY` is not exported and must not become so for
 * a benchmark: it is that module's private answer to "where do NULLs go", and a
 * second exported spelling is exactly the drift {@link WORKLOAD_SHAPES} avoids
 * by calling real readers. These shapes have no reader to call, which is the
 * whole reason they sit in the other list.
 */
const UNPRICED_SORT_KEY = Number.MAX_SAFE_INTEGER;

export const EXPLORATORY_SHAPES: readonly ExploratoryShape[] = [
  {
    id: 'X01',
    workloadItem: 8,
    title: 'Merchant page — one seller’s current offers, most recently seen first',
    provenance:
      '#57 built offers_merchant_browse_idx for this and NO shipped reader issues it. ' +
      'The merchant storefront page is #84; ranking is #74. Measured so both inherit a number.',
    expectation: { minRowsReturned: 1, requireIndexes: ['offers_merchant_browse_idx'] },
    build: (graph) => sql`
      select ${offers.id}, ${offers.priceAmount}, ${offers.lastSeenAt}
      from ${offers}
      where ${offers.merchantId} = ${graph.busiestMerchantId} and ${offers.status} = 'active'
      order by ${offers.lastSeenAt} desc
      limit ${PAGE}`,
  },
  {
    id: 'X02',
    workloadItem: 8,
    title: 'Merchant page, DEDUPLICATED to one offer per canonical product (DISTINCT ON)',
    provenance:
      'Deduplicating a seller’s offers to one row per product is a ranking decision (#74) ' +
      'and has no shipped reader. Compared against X03 for #61’s strategy 5.',
    expectation: { minRowsReturned: 1 },
    build: (graph) => sql`
      select distinct on (v.product_id) v.product_id, o.id, o.price_amount
      from ${offers} o
      join ${canonicalVariants} v on v.id = o.canonical_variant_id
      where o.merchant_id = ${graph.busiestMerchantId} and o.status = 'active'
      order by v.product_id, coalesce(o.price_amount, ${UNPRICED_SORT_KEY}::bigint)
      limit ${PAGE}`,
  },
  {
    id: 'X03',
    workloadItem: 8,
    title: 'The same deduplication as a LATERAL join (#61 strategy 5)',
    provenance:
      'The LATERAL half of the strategy comparison X02 opens. No shipped reader; #74 owns it.',
    expectation: { minRowsReturned: 1 },
    build: (graph) => sql`
      select p.product_id, cheapest.id, cheapest.price_amount
      from (
        select distinct v.product_id
        from ${offers} o join ${canonicalVariants} v on v.id = o.canonical_variant_id
        where o.merchant_id = ${graph.busiestMerchantId} and o.status = 'active'
        limit ${PAGE}
      ) p
      cross join lateral (
        select o2.id, o2.price_amount
        from ${offers} o2 join ${canonicalVariants} v2 on v2.id = o2.canonical_variant_id
        where v2.product_id = p.product_id and o2.status = 'active'
          and o2.merchant_id = ${graph.busiestMerchantId}
        order by coalesce(o2.price_amount, ${UNPRICED_SORT_KEY}::bigint)
        limit 1
      ) cheapest`,
  },
  {
    id: 'X04',
    workloadItem: 10,
    title: 'Search candidate generation by discriminating token (GIN array overlap)',
    provenance:
      'A FRAGMENT of a shipped read: #58’s PostgresCandidateSource.retrieveByTitle issues this ' +
      'only when the trigram half (Q10) under-fills, so it is measured directly to give the GIN ' +
      'half its own number rather than one averaged with a branch that usually does not run.',
    expectation: { minRowsReturned: 1, requireIndexes: ['canonical_products_search_tokens_idx'] },
    build: (graph) => sql`
      select id from canonical_products
      where search_tokens && ${sql.param([graph.knownModelCode])}::text[]
        and status <> 'merged' and status <> 'suppressed'
      order by created_at desc
      limit 25`,
  },
  {
    id: 'X05',
    workloadItem: 12,
    title: 'Freshness scan WITHOUT the write — what the sweep’s predicate costs',
    provenance:
      'A FRAGMENT of a shipped read: #68’s listLapsedExternalOfferCandidates selects exactly ' +
      'this before its provenance join. Isolated so the index scan is separable from the join ' +
      'cost, which Q13 measures together.',
    expectation: { minRowsReturned: 1, requireIndexes: ['offers_freshness_idx'] },
    build: () => sql`
      select ${offers.id} from ${offers}
      where ${offers.status} = 'active' and ${offers.kind} <> 'native'
        and ${offers.staleAt} <= '2026-01-01T00:00:00.000Z'::timestamptz
      order by ${offers.staleAt}
      limit 500`,
  },
];

/**
 * Every issue workload item at least one shape covers.
 *
 * Exported so the coverage assertion lives beside the shapes rather than being
 * re-derived in a test — the count in the test would then be a second spelling
 * of the same fact, which is what lets a dropped shape pass as a smaller list.
 */
export function coveredWorkloadItems(): ReadonlySet<number> {
  const items = new Set<number>();
  for (const shape of WORKLOAD_SHAPES) items.add(shape.workloadItem);
  for (const shape of EXPLORATORY_SHAPES) items.add(shape.workloadItem);
  return items;
}
