/**
 * Competitive price analytics for a native store (#89's `competitive_price_analytics`).
 *
 * For each of the store's live native listing variants matched to a canonical
 * product: the store's own price against the OTHER offers its public comparison
 * shows — how many sellers, their lowest and median price, and a position band —
 * and, per listing, the same comparison over time from price history.
 *
 * ## Whose rules
 *
 * Nothing here decides which offers are comparable or how a market is summed up.
 *
 * - The CURRENT half is #82's `buildPriceSignalContext`: #74's admission (stale,
 *   suppressed, restricted and unbuyable offers excluded), one identity per
 *   seller, every amount converted ONCE into the comparison currency with the
 *   rate that did it. The same function the free `/merchant-competitiveness`
 *   surface and the shopper's price badge read.
 * - The HISTORICAL half is #78's `derivePriceSeries` over the immutable
 *   observations (superseded, quarantined, anomalous, not-displayable and
 *   unconvertible observations excluded), run once per seller so each seller
 *   contributes its own lowest price per bucket.
 * - The statistics and ALL FOUR floors are #82's (`market.ts` calls
 *   `priceSampleShortfall`), under the ACTIVE price-signal policy — including
 *   `minCoverageDays`, which a cross-section can be judged on because every
 *   entry carries its offer's own observation record rather than the read's
 *   clock. With no policy active, no row is measured — the same honest empty
 *   state every #82 surface has.
 *
 * ## What the store is compared with, and what it is not
 *
 * The comparison currency is the listing's OWN currency, so the store's price is
 * never converted and other sellers' prices are converted for display only, at
 * read time (nothing stored is rewritten — `AGENTS.md` §Money). The store's own
 * other listings and the canonical merchant it is verifiably linked to
 * (`native_store_links`) are the store itself and never part of "the market".
 *
 * ## What it never does
 *
 * It writes nothing: no price, no listing, no row of its own. It returns no other
 * seller's identity — the response types have no field for one and the realdb
 * suite walks a real response for the names. And it suggests nothing: a price
 * comparison is the whole tool, and a plan never buys placement.
 */

import {
  ALL_CURRENCY_CODES,
  CONDITION_KEY_GROUP,
  priceHistoryBucketStart,
  STORE_PRICE_NEAR_LOWEST_BPS,
  STORE_PRICE_POSITION_BANDS,
  type ConditionGroup,
  type CurrencyCode,
  type ItemConditionKey,
  type PriceSignalPolicy,
  type StorePriceAnalyticsResponse,
  type StorePriceAnalyticsRow,
  type StorePriceConversion,
  type StorePricePositionBand,
  type StorePriceTrendGranularity,
  type StorePriceTrendPoint,
  type StorePriceTrendResponse,
  type StorePriceTrendWindowDays,
  type StorePriceUnmeasuredReason,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import {
  findActivePriceSignalPolicy,
  toPriceSignalPolicy,
} from '../../db/priceSignals/priceSignalPolicyRepository.js';
import { listOfferSellerIdentities } from '../../db/priceSignals/priceSignalSubjectRepository.js';
import { listPriceDisplayPermittedSourceIds } from '../../db/priceHistory/priceEligibilityRepository.js';
import {
  listPriceObservationsForScope,
  type PriceObservationRow,
} from '../../db/priceHistory/priceSnapshotRepository.js';
import {
  countStoreComparableListings,
  findActiveLinkedMerchantId,
  listStoreComparableListings,
  listStoreOwnedListingIds,
  type StoreComparableListing,
} from '../../db/storePriceBenchmark/storePriceBenchmarkRepository.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { getRates } from '../fx.service.js';
import { derivePriceSeries } from '../price-history/derive.js';
import {
  buildPriceSignalContext,
  type PriceSignalContext,
} from '../price-signals/context.service.js';
import {
  observationSpanStart,
  sellerDedupKey,
  type PriceSampleEntry,
} from '../price-signals/statistics.js';
import { positionFor, summarizeMarket } from './market.js';

/**
 * How many listing variants one read analyses.
 *
 * Each costs one comparison read (offers, admission, a price-history window), so
 * the bound is what keeps one request inside the proxy's time budget. A store
 * with more is answered with `truncated: true` and the count it has, never with
 * a silently smaller denominator.
 */
export const STORE_PRICE_ANALYTICS_MAX_LISTINGS = 200;

/** Comparison reads in flight at once for one request. */
const CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface StorePriceAnalyticsRequest {
  readonly storeId: string;
  /** ISO 3166-1 alpha-2; absent compares across every market. */
  readonly market?: string;
  readonly now?: Date;
  /**
   * The policy to judge against. Production omits it and the ACTIVE version is
   * read. A realdb suite passes a fixture version instead of activating one,
   * because the active version is a single global row a parallel file would see.
   */
  readonly policy?: PriceSignalPolicy | null;
}

async function resolvePolicy(
  given: PriceSignalPolicy | null | undefined,
): Promise<PriceSignalPolicy | undefined> {
  if (given === null) return undefined;
  if (given !== undefined) return given;
  const active = await findActivePriceSignalPolicy();
  return active === undefined ? undefined : toPriceSignalPolicy(active);
}

function comparisonCurrency(currency: string | null): CurrencyCode | undefined {
  if (currency === null) return undefined;
  return (ALL_CURRENCY_CODES as readonly string[]).includes(currency)
    ? (currency as CurrencyCode)
    : undefined;
}

function segmentOf(condition: string): ConditionGroup | undefined {
  if (condition === 'unknown') return undefined;
  return CONDITION_KEY_GROUP[condition as ItemConditionKey];
}

/** Why a listing cannot be compared at all, before any comparison read. */
function preliminaryReason(
  listing: StoreComparableListing,
  policy: PriceSignalPolicy | undefined,
): StorePriceUnmeasuredReason | undefined {
  if (policy === undefined) return 'no_active_policy';
  if (listing.priceAmount === null) return 'price_missing';
  if (comparisonCurrency(listing.priceCurrency) === undefined) return 'currency_not_comparable';
  if (segmentOf(listing.condition) === undefined) return 'condition_unknown';
  return undefined;
}

/** Run `work` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await work(item);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * The seller keys that are the STORE ITSELF among `entries`: its own native
 * listings (any of them, not only the one a row is about) and its linked
 * canonical merchant.
 */
async function storeSellerKeys(
  storeId: string,
  linkedMerchantId: string | null,
  sellerKeys: Iterable<string>,
): Promise<Set<string>> {
  const listingIds = [...new Set(sellerKeys)]
    .filter((key) => key.startsWith('listing:'))
    .map((key) => key.slice('listing:'.length));
  const owned = await listStoreOwnedListingIds(storeId, listingIds);
  const keys = new Set([...owned].map((id) => `listing:${id}`));
  if (linkedMerchantId !== null) keys.add(`merchant:${linkedMerchantId}`);
  return keys;
}

/** The FX basis of the converted prices among `entries`, when any were converted. */
function conversionOf(
  context: PriceSignalContext,
  entries: readonly PriceSampleEntry[],
): StorePriceConversion | undefined {
  for (const entry of entries) {
    const value = context.input.values.get(entry.id);
    if (value !== undefined && value.basis === 'historical_quote') {
      return { provider: value.quote.provider, asOf: value.quote.asOf };
    }
  }
  return undefined;
}

function baseRow(listing: StoreComparableListing): Omit<StorePriceAnalyticsRow, 'state'> {
  return {
    productVariantId: listing.productVariantId,
    listingId: listing.listingId,
    listingTitle: listing.listingTitle,
    variantTitle: listing.variantTitle,
    sku: listing.sku,
    canonicalProductName: listing.canonicalProductName,
    segment: segmentOf(listing.condition) ?? null,
    currency: listing.priceCurrency,
    ownAmount: listing.priceAmount,
    inComparison: false,
  };
}

/**
 * The store's listings against their comparisons, now.
 *
 * Analyses the first {@link STORE_PRICE_ANALYTICS_MAX_LISTINGS} comparable
 * listing variants in a stable order and states the total, so a truncated read
 * says so rather than reporting a smaller store.
 */
export async function readStorePriceAnalytics(
  request: StorePriceAnalyticsRequest,
): Promise<StorePriceAnalyticsResponse> {
  const now = request.now ?? new Date();
  const policy = await resolvePolicy(request.policy);

  const [listingsTotal, listings, linkedMerchantId] = await Promise.all([
    countStoreComparableListings(request.storeId),
    listStoreComparableListings({
      storeId: request.storeId,
      limit: STORE_PRICE_ANALYTICS_MAX_LISTINGS,
    }),
    findActiveLinkedMerchantId(request.storeId),
  ]);

  // One comparison read per (canonical variant, segment, currency): two of the
  // store's variants on one product are compared against the same market.
  const contexts = new Map<string, Promise<PriceSignalContext>>();
  const contextFor = (
    listing: StoreComparableListing,
    segment: ConditionGroup,
    currency: CurrencyCode,
    active: PriceSignalPolicy,
  ): Promise<PriceSignalContext> => {
    const key = `${listing.canonicalVariantId}|${segment}|${currency}`;
    let pending = contexts.get(key);
    if (pending === undefined) {
      pending = buildPriceSignalContext({
        canonicalVariantId: listing.canonicalVariantId,
        segment,
        currency,
        ...(request.market === undefined ? {} : { market: request.market }),
        policy: active,
        now,
      });
      contexts.set(key, pending);
    }
    return pending;
  };

  const rows = await mapWithLimit(listings, CONCURRENCY, async (listing) => {
    const base = baseRow(listing);
    const reason = preliminaryReason(listing, policy);
    if (reason !== undefined || policy === undefined) {
      return { ...base, state: 'unmeasured', reason: reason ?? 'no_active_policy' } as const;
    }
    // All three are established by `preliminaryReason`; re-read for the types.
    const segment = segmentOf(listing.condition) as ConditionGroup;
    const currency = comparisonCurrency(listing.priceCurrency) as CurrencyCode;
    const ownAmount = listing.priceAmount as number;

    const context = await contextFor(listing, segment, currency, policy);
    const entries = context.input.currentItemPrice;
    const own = await storeSellerKeys(
      request.storeId,
      linkedMerchantId,
      entries.map((entry) => entry.sellerKey),
    );
    const others = entries.filter((entry) => !own.has(entry.sellerKey));
    const inComparison = entries.some((entry) => entry.offerId === listing.offerId);
    const conversion = conversionOf(context, others);
    const market = summarizeMarket(others, policy);

    if (market.outcome === 'unmeasured') {
      return {
        ...base,
        inComparison,
        state: 'unmeasured',
        reason: market.reason,
        ...(conversion === undefined ? {} : { conversion }),
      } as const;
    }
    return {
      ...base,
      inComparison,
      state: 'measured',
      market: market.market,
      position: positionFor(ownAmount, market.market),
      ...(conversion === undefined ? {} : { conversion }),
    } as const;
  });

  const byBand = Object.fromEntries(STORE_PRICE_POSITION_BANDS.map((band) => [band, 0])) as Record<
    StorePricePositionBand,
    number
  >;
  let measured = 0;
  for (const row of rows) {
    if (row.state !== 'measured' || row.position === undefined) continue;
    measured += 1;
    byBand[row.position.band] += 1;
  }

  return {
    storeId: request.storeId,
    computedAt: now.toISOString(),
    ...(policy === undefined
      ? {}
      : {
          semantics: {
            policyVersion: policy.version,
            minObservations: policy.minObservations,
            minDistinctSellers: policy.minDistinctSellers,
            minDistinctOffers: policy.minDistinctOffers,
            minCoverageDays: policy.minCoverageDays,
            nearLowestBps: STORE_PRICE_NEAR_LOWEST_BPS,
            deduplication: 'one_offer_per_distinct_seller',
            medianMethod: 'lower_median_over_observed_values',
            outlierMethod: 'modified_z_score_over_median_absolute_deviation',
          },
        }),
    summary: {
      listingsAnalysed: rows.length,
      measured,
      unmeasured: rows.length - measured,
      byBand,
    },
    coverage: {
      listingsTotal,
      listingsAnalysed: rows.length,
      truncated: listingsTotal > rows.length,
    },
    rows,
  };
}

export interface StorePriceTrendRequest extends StorePriceAnalyticsRequest {
  readonly productVariantId: string;
  readonly windowDays: StorePriceTrendWindowDays;
  readonly granularity: StorePriceTrendGranularity;
}

/** Every bucket start from `from` to `to`, inclusive, in the trend's granularity. */
function bucketStarts(from: Date, to: Date, granularity: StorePriceTrendGranularity): Date[] {
  const step = granularity === 'week' ? 7 * DAY_MS : DAY_MS;
  const starts: Date[] = [];
  let cursor = priceHistoryBucketStart(from, granularity);
  while (cursor.getTime() <= to.getTime()) {
    starts.push(cursor);
    cursor = priceHistoryBucketStart(new Date(cursor.getTime() + step), granularity);
  }
  return starts;
}

/**
 * One listing's price against its comparison over time.
 *
 * The listing must be one of the store's comparable ones — anything else is the
 * same 404 a listing that does not exist gets.
 *
 * Each seller's observations are derived SEPARATELY through #78's
 * `derivePriceSeries`, so a bucket holds one admitted lowest price per seller —
 * deduplication by construction — and the store's own series is its listing's
 * lowest admitted price in the bucket. Each bucket's market clears the policy's
 * four floors on its own, or says which one it missed: a bucket is the
 * cross-section at that time, so each entry carries its offer's observation
 * record up to that point (`observationSpanStart` from its first sighting,
 * clamped to the policy's recent window before the observation) — the same
 * definition the overview's current entries use.
 */
export async function readStorePriceTrend(
  request: StorePriceTrendRequest,
): Promise<StorePriceTrendResponse> {
  const now = request.now ?? new Date();
  const [listing] = await listStoreComparableListings({
    storeId: request.storeId,
    productVariantId: request.productVariantId,
    limit: 1,
  });
  if (listing === undefined) throw notFound('Listing not found');

  const policy = await resolvePolicy(request.policy);
  const from = new Date(now.getTime() - request.windowDays * DAY_MS);
  const head = {
    productVariantId: listing.productVariantId,
    listingTitle: listing.listingTitle,
    variantTitle: listing.variantTitle,
    currency: listing.priceCurrency,
    segment: segmentOf(listing.condition) ?? null,
    granularity: request.granularity,
    windowDays: request.windowDays,
    from: from.toISOString(),
    to: now.toISOString(),
  };

  const reason = preliminaryReason(listing, policy);
  if (reason !== undefined || policy === undefined) {
    return { ...head, reason: reason ?? 'no_active_policy', points: [] };
  }
  const segment = segmentOf(listing.condition) as ConditionGroup;
  const currency = comparisonCurrency(listing.priceCurrency) as CurrencyCode;

  const [observations, permittedSources, rates, linkedMerchantId] = await Promise.all([
    listPriceObservationsForScope({
      canonicalVariantId: listing.canonicalVariantId,
      ...(request.market === undefined ? {} : { market: request.market }),
      from,
      to: now,
      limit: config.priceHistory.rebuildObservationLimit,
    }),
    listPriceDisplayPermittedSourceIds(),
    // Every currency, for #78's reason: `convert` reads both sides against the
    // rate map's base, and a pair it cannot quote is EXCLUDED, never guessed.
    getRates(currency, [...ALL_CURRENCY_CODES]),
    findActiveLinkedMerchantId(request.storeId),
  ]);

  const identities = await listOfferSellerIdentities([
    ...new Set(observations.map((row) => row.offerId)),
  ]);
  const ownedListings = await listStoreOwnedListingIds(
    request.storeId,
    [...identities.values()].flatMap((identity) =>
      identity.listingId === null ? [] : [identity.listingId],
    ),
  );

  // Partition by seller. The row's own listing is the store's series; the
  // store's other listings and its linked merchant are neither the store's
  // series nor the market, and a seller Mercaria cannot identify is excluded
  // rather than given a key of its own (`sellerDedupKey`).
  const own: PriceObservationRow[] = [];
  const bySeller = new Map<string, PriceObservationRow[]>();
  for (const observation of observations) {
    const identity = identities.get(observation.offerId);
    if (identity === undefined) continue;
    if (identity.listingId === listing.listingId) {
      own.push(observation);
      continue;
    }
    if (identity.listingId !== null && ownedListings.has(identity.listingId)) continue;
    if (identity.merchantId !== null && identity.merchantId === linkedMerchantId) continue;
    const seller = sellerDedupKey({
      ...(identity.merchantId === null ? {} : { merchantId: identity.merchantId }),
      ...(identity.listingId === null ? {} : { listingId: identity.listingId }),
    });
    if (seller === undefined) continue;
    const list = bySeller.get(seller);
    if (list === undefined) bySeller.set(seller, [observation]);
    else list.push(observation);
  }

  const derive = (rows: readonly PriceObservationRow[]) =>
    derivePriceSeries({
      observations: rows,
      displayCurrency: currency,
      granularity: request.granularity,
      rates,
      priceDisplayPermittedSourceIds: permittedSources,
      // Only `lowest_item_price` is derived, which never reads the official set.
      officialStoreMerchantIds: new Set(),
      measures: ['lowest_item_price'],
    }).points.filter((point) => point.segment === segment);

  const ownByBucket = new Map<number, number>();
  for (const point of derive(own)) {
    const key = point.bucketStart.getTime();
    const existing = ownByBucket.get(key);
    if (existing === undefined || point.displayAmount < existing) {
      ownByBucket.set(key, point.displayAmount);
    }
  }

  const othersByBucket = new Map<number, PriceSampleEntry[]>();
  for (const [sellerKey, rows] of bySeller) {
    for (const point of derive(rows)) {
      const key = point.bucketStart.getTime();
      const firstSeenAt = identities.get(point.offerId)?.firstSeenAt;
      const entry: PriceSampleEntry = {
        id: point.snapshotId,
        offerId: point.offerId,
        sellerKey,
        amount: point.displayAmount,
        observedAt: point.observedAt,
        // Every point's offer is in `identities` (the partition above skipped
        // the rest), so this is never absent; written out because a non-null
        // assertion is forbidden, and absent leaves the entry a single read.
        ...(firstSeenAt === undefined
          ? {}
          : {
              observedFrom: observationSpanStart(
                firstSeenAt,
                point.observedAt,
                policy.recentWindowDays,
              ),
            }),
      };
      const list = othersByBucket.get(key);
      if (list === undefined) othersByBucket.set(key, [entry]);
      else list.push(entry);
    }
  }

  const points: StorePriceTrendPoint[] = bucketStarts(from, now, request.granularity).map(
    (start) => {
      const key = start.getTime();
      const market = summarizeMarket(othersByBucket.get(key) ?? [], policy);
      return {
        bucketStart: start.toISOString(),
        ownAmount: ownByBucket.get(key) ?? null,
        ...(market.outcome === 'measured'
          ? {
              market: {
                otherSellers: market.market.otherSellers,
                lowestAmount: market.market.lowestAmount,
                medianAmount: market.market.medianAmount,
              },
            }
          : { market: null, marketReason: market.reason }),
      };
    },
  );

  return { ...head, points };
}
