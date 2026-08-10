/**
 * The durable-record reads a merchant demand snapshot is built from (#86
 * acceptance 1).
 *
 * Every function here answers ONE question against ONE store of record, and
 * none of them interprets: the arithmetic, the thresholds and the three-way
 * "measured / suppressed / unavailable" verdict all live in
 * `services/merchant-demand/`. That split is what makes the facts testable
 * against a real server without a policy in the way, and it is why nothing in
 * this file imports the metric registry.
 *
 * ## Bots are excluded HERE, in the predicate, not at read
 *
 * Every event predicate carries `traffic_class in ANALYTICS_HUMAN_TRAFFIC_CLASSES`
 * (#86 acceptance 3). #77's rollup makes the same choice in the same place and
 * for the same reason: a filter applied after aggregation leaves the inflated
 * figure standing in whatever the caller happened to store.
 *
 * ## The merchant's scope is its CURRENT offer set
 *
 * An `analytics_events` row names a canonical product, an offer, a merchant or a
 * storefront — never all four. So a merchant's demand over PRODUCTS is measured
 * by resolving the canonical products the merchant currently offers and counting
 * events on those, which is what #86 fact 1 asks for in those words ("products
 * the merchant currently offers"). The consequence is stated on every metric
 * definition rather than hidden: a product added during the window contributes
 * interactions from before it was added.
 */

import { and, eq, gte, inArray, isNotNull, lt, max, sql } from 'drizzle-orm';
import {
  ANALYTICS_HUMAN_TRAFFIC_CLASSES,
  type AnalyticsEventType,
  type CurrencyCode,
} from '@mercaria/shared-types';
import { inList } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { analyticsEvents } from '../schema/analytics.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';
import { nativeStoreLinks } from '../schema/merchants.js';
import { offers } from '../schema/offers.js';
import { orders } from '../schema/orders.js';
import { productSaveAggregates } from '../schema/productSaves.js';
import { sourceRecords } from '../schema/provenance.js';
import { stores } from '../schema/stores.js';

/** The human traffic classes, rendered once for every predicate below. */
const HUMAN_TRAFFIC = sql.raw(inList(ANALYTICS_HUMAN_TRAFFIC_CLASSES));

/** One of the merchant's active offers, with what freshness needs to judge it. */
export interface MerchantOfferFact {
  readonly offerId: string;
  readonly kind: string;
  readonly status: string;
  readonly canonicalVariantId: string;
  readonly canonicalProductId: string;
  readonly storefrontId: string | null;
  readonly sourceId: string | null;
  readonly observedAt: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly lastConfirmedAt: Date | null;
  readonly declaredUnavailableAt: Date | null;
  readonly staleAt: Date;
}

/**
 * Every ACTIVE offer this merchant has, with its canonical product and its
 * source.
 *
 * The source comes through `source_records` because an offer names its
 * OBSERVATION and never its source — #57's stated reason for not carrying a
 * copy, and #68's health service resolves it the same way.
 *
 * Bounded by `limit`. A merchant with a hundred thousand offers gets a snapshot
 * over the first page of them and the snapshot's coverage counters say how many
 * products it saw, which is the honest failure: a report that silently scanned
 * a tenth of a catalogue and a report over a small catalogue look identical
 * otherwise.
 */
export async function listMerchantOfferFacts(
  input: { merchantId: string; market?: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly MerchantOfferFact[]> {
  const rows = await db
    .select({
      offerId: offers.id,
      kind: offers.kind,
      status: offers.status,
      canonicalVariantId: offers.canonicalVariantId,
      canonicalProductId: canonicalVariants.productId,
      storefrontId: offers.storefrontId,
      sourceId: sourceRecords.sourceId,
      observedAt: offers.observedAt,
      firstSeenAt: offers.firstSeenAt,
      lastSeenAt: offers.lastSeenAt,
      lastConfirmedAt: offers.lastConfirmedAt,
      declaredUnavailableAt: offers.declaredUnavailableAt,
      staleAt: offers.staleAt,
      country: offers.country,
    })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .leftJoin(sourceRecords, eq(sourceRecords.id, offers.sourceRecordId))
    .where(and(eq(offers.merchantId, input.merchantId), eq(offers.status, 'active')))
    .orderBy(offers.id)
    .limit(input.limit);

  const market = input.market;
  return rows
    // A market filter narrows to offers that NAME the market. An offer with no
    // country is left in: absence is not a statement that it is unavailable
    // there, and dropping it would understate a merchant's own catalogue.
    .filter((row) => market === undefined || row.country === null || row.country === market)
    .map((row) => ({
      offerId: row.offerId,
      kind: row.kind,
      status: row.status,
      canonicalVariantId: row.canonicalVariantId,
      canonicalProductId: row.canonicalProductId,
      storefrontId: row.storefrontId,
      sourceId: row.sourceId,
      observedAt: row.observedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      lastConfirmedAt: row.lastConfirmedAt,
      declaredUnavailableAt: row.declaredUnavailableAt,
      staleAt: row.staleAt,
    }));
}

/** A window, half-open, plus the market it is scoped to. */
export interface DemandWindow {
  readonly from: Date;
  readonly to: Date;
  /** `''` means every market. */
  readonly market: string;
}

/** The market predicate, or nothing when the window covers every market. */
function marketPredicate(market: string) {
  return market === '' ? undefined : eq(analyticsEvents.market, market);
}

/**
 * Count events of one type naming this merchant directly.
 *
 * Used for `offer_impression`, which carries `merchant_id` from all three
 * emitting controllers.
 */
export async function countMerchantScopedEvents(
  input: { merchantId: string; eventType: AnalyticsEventType; window: DemandWindow },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`count(*)` })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.merchantId, input.merchantId),
        eq(analyticsEvents.eventType, input.eventType),
        gte(analyticsEvents.occurredAt, input.window.from),
        lt(analyticsEvents.occurredAt, input.window.to),
        sql`${analyticsEvents.trafficClass} in (${HUMAN_TRAFFIC})`,
        marketPredicate(input.window.market),
      ),
    );
  // postgres.js decodes `count(*)` as a STRING (it is an int8), and drizzle
  // types it whatever the template says — so the coercion is explicit here
  // rather than left to a `+` somewhere downstream that would concatenate.
  return Number(rows[0]?.total ?? 0);
}

/**
 * Count events of one type on a given set of canonical products.
 *
 * The set is the merchant's current products, resolved by the caller. Batched
 * with `inArray` rather than one query per product: a merchant with two hundred
 * products would otherwise be two hundred round trips inside one snapshot
 * build.
 */
export async function countProductScopedEvents(
  input: {
    canonicalProductIds: readonly string[];
    eventType: AnalyticsEventType;
    window: DemandWindow;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, number>> {
  if (input.canonicalProductIds.length === 0) return new Map();
  const rows = await db
    .select({
      canonicalProductId: analyticsEvents.canonicalProductId,
      total: sql<string>`count(*)`,
    })
    .from(analyticsEvents)
    .where(
      and(
        isNotNull(analyticsEvents.canonicalProductId),
        inArray(analyticsEvents.canonicalProductId, [...input.canonicalProductIds]),
        eq(analyticsEvents.eventType, input.eventType),
        gte(analyticsEvents.occurredAt, input.window.from),
        lt(analyticsEvents.occurredAt, input.window.to),
        sql`${analyticsEvents.trafficClass} in (${HUMAN_TRAFFIC})`,
        marketPredicate(input.window.market),
      ),
    )
    .groupBy(analyticsEvents.canonicalProductId);

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.canonicalProductId === null) continue;
    counts.set(row.canonicalProductId, Number(row.total));
  }
  return counts;
}

/**
 * Count `offer_impression` events per canonical product for one merchant.
 *
 * Scoped by merchant AND product, so the number on a product row is this
 * merchant's own impressions of that product and not the marketplace's.
 */
export async function countMerchantProductImpressions(
  input: { merchantId: string; canonicalProductIds: readonly string[]; window: DemandWindow },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, number>> {
  if (input.canonicalProductIds.length === 0) return new Map();
  const rows = await db
    .select({
      canonicalProductId: analyticsEvents.canonicalProductId,
      total: sql<string>`count(*)`,
    })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.merchantId, input.merchantId),
        eq(analyticsEvents.eventType, 'offer_impression'),
        isNotNull(analyticsEvents.canonicalProductId),
        inArray(analyticsEvents.canonicalProductId, [...input.canonicalProductIds]),
        gte(analyticsEvents.occurredAt, input.window.from),
        lt(analyticsEvents.occurredAt, input.window.to),
        sql`${analyticsEvents.trafficClass} in (${HUMAN_TRAFFIC})`,
        marketPredicate(input.window.market),
      ),
    )
    .groupBy(analyticsEvents.canonicalProductId);

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.canonicalProductId === null) continue;
    counts.set(row.canonicalProductId, Number(row.total));
  }
  return counts;
}

/** The newest `occurred_at` any human event in the window carried. */
export async function findNewestEventInstant(
  window: DemandWindow,
  db: DatabaseOrTransaction = getDb(),
): Promise<Date | undefined> {
  // drizzle's `max()` rather than a raw `sql` template: the raw form is decoded
  // by whatever the driver happens to return, and postgres.js hands back a
  // STRING for an aggregate over a timestamptz — which then fails at INSERT
  // time on `value.toISOString is not a function`, several functions away from
  // where it was read. `max()` carries the column's own decoder, so the value
  // is a Date because the COLUMN says so. Measured; the raw form was the first
  // spelling here and the realdb suite is what caught it.
  const rows = await db
    .select({ newest: max(analyticsEvents.occurredAt) })
    .from(analyticsEvents)
    .where(
      and(
        gte(analyticsEvents.occurredAt, window.from),
        lt(analyticsEvents.occurredAt, window.to),
        sql`${analyticsEvents.trafficClass} in (${HUMAN_TRAFFIC})`,
      ),
    );
  const newest = rows[0]?.newest;
  return newest === null || newest === undefined ? undefined : newest;
}

/** The native store this merchant operates, if a live link says so. */
export async function findLinkedNativeStoreId(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | undefined> {
  const rows = await db
    .select({ storeId: nativeStoreLinks.storeId })
    .from(nativeStoreLinks)
    .where(and(eq(nativeStoreLinks.merchantId, merchantId), eq(nativeStoreLinks.status, 'active')))
    .limit(1);
  return rows[0]?.storeId;
}

/** Paid native orders and their gross value, in the store's OWN currency. */
export interface NativeOrderFacts {
  readonly paidOrderCount: number;
  readonly grossAmountMinor: number;
  readonly currency: CurrencyCode;
}

/**
 * The merchant's native trading in the window, read from `orders`.
 *
 * From the durable order record and never from a client event: a paid-order
 * figure a browser could inflate is worse than no figure at all (#77 identity
 * rule 8, and #86 acceptance 2's neighbour).
 *
 * The sum is over the SHOP side and is `$match`ed to the store's own
 * `default_currency`, exactly as `report.service` does — an order settled in
 * another shop currency is a different accounting fact and is not converted
 * into this one.
 *
 * A REFUNDED order still counts. The purchase happened; a refund is a later,
 * separate fact with its own record, and excluding it would make a merchant's
 * March figure change in May.
 */
export async function readNativeOrderFacts(
  input: { storeId: string; window: DemandWindow },
  db: DatabaseOrTransaction = getDb(),
): Promise<NativeOrderFacts | undefined> {
  const storeRows = await db
    .select({ defaultCurrency: stores.defaultCurrency })
    .from(stores)
    .where(eq(stores.id, input.storeId))
    .limit(1);
  const stored = storeRows[0]?.defaultCurrency;
  if (stored === undefined) return undefined;
  // `stores.default_currency` is `text` with a currency CHECK rendered from the
  // same tuple `CurrencyCode` is, so the narrowing is a statement about the
  // constraint rather than an assumption about the data.
  const defaultCurrency = stored as CurrencyCode;

  const rows = await db
    .select({
      orderCount: sql<string>`count(*)`,
      gross: sql<string>`coalesce(sum(${orders.totalsGrandTotalShopAmount}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, input.storeId),
        eq(orders.totalsGrandTotalShopCurrency, defaultCurrency),
        isNotNull(orders.paymentPaidAt),
        gte(orders.paymentPaidAt, input.window.from),
        lt(orders.paymentPaidAt, input.window.to),
      ),
    );

  return {
    paidOrderCount: Number(rows[0]?.orderCount ?? 0),
    // `sum()` over a bigint column comes back a STRING from postgres.js, so the
    // coercion is explicit — `max + 1` on one of these is string concatenation.
    grossAmountMinor: Number(rows[0]?.gross ?? 0),
    currency: defaultCurrency,
  };
}

/**
 * #80's stored save counts for a set of canonical products.
 *
 * Read through #80's own aggregate table and floored by #80's own
 * `discloseProductSaveCount` in the service — this repository returns the raw
 * counts and the caller applies the policy, because two floors applied in two
 * places is how one of them gets forgotten.
 */
export async function readProductSaveCounts(
  canonicalProductIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, number>> {
  if (canonicalProductIds.length === 0) return new Map();
  const rows = await db
    .select({
      canonicalProductId: productSaveAggregates.canonicalProductId,
      saveCount: productSaveAggregates.saveCount,
    })
    .from(productSaveAggregates)
    .where(inArray(productSaveAggregates.canonicalProductId, [...canonicalProductIds]));
  return new Map(rows.map((row) => [row.canonicalProductId, row.saveCount]));
}

/**
 * Which of these canonical products the merchant sells NATIVELY.
 *
 * A native offer is the structural test for "activated": #57 makes external
 * offers unable to enter a cart at all, so a merchant with only external offers
 * has not activated whatever a link or a claim says.
 */
export async function findNativeOfferProductIds(
  input: { merchantId: string; canonicalProductIds: readonly string[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlySet<string>> {
  if (input.canonicalProductIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ canonicalProductId: canonicalVariants.productId })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .where(
      and(
        eq(offers.merchantId, input.merchantId),
        eq(offers.kind, 'native'),
        eq(offers.status, 'active'),
        inArray(canonicalVariants.productId, [...input.canonicalProductIds]),
      ),
    );
  return new Set(rows.map((row) => row.canonicalProductId));
}
