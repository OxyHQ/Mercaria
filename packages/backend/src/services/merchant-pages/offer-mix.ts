/**
 * Offer counts by native, external, condition and market
 * (#73 merchant requirement 7).
 *
 * PURE, over the census rows the repository grouped. The seller-role dimension
 * is derived here through `deriveOfferSellerRole` — the ONE definition of ADR
 * 0002 D8's comparison — rather than in SQL, so a marketplace offer is counted
 * as one by exactly the same rule that labels it as one on a card.
 *
 * Buckets are sorted by count descending and then by key, which is what makes a
 * page's chips stable between two reads of unchanged data. An empty dimension
 * produces an empty array rather than a zero bucket: "no offer of this merchant
 * is refurbished" and "we counted zero refurbished offers" are the same fact,
 * and inventing the second shape would make a client render a chip reading
 * `Refurbished 0`.
 */

import { deriveOfferSellerRole } from '@mercaria/shared-types';
import type {
  MerchantOfferMix,
  MerchantOfferMixBucket,
  OfferConditionKey,
  OfferKind,
  OfferSellerRole,
} from '@mercaria/shared-types';
import type { MerchantOfferCensusRow } from '../../db/merchantPages/merchantCatalogRepository.js';

/**
 * Accumulate into a keyed map, then emit the sorted buckets.
 *
 * `Map` rather than a plain object, because one dimension's key is `string |
 * null` (a market-less offer) and an object would coerce that null to the
 * STRING `"null"` — a country code somebody could then filter on and get
 * nothing back.
 */
function bucketsOf<TKey>(counts: ReadonlyMap<TKey, number>): MerchantOfferMixBucket<TKey>[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count - a.count) || String(a.key).localeCompare(String(b.key)));
}

function add<TKey>(counts: Map<TKey, number>, key: TKey, count: number): void {
  if (count === 0) return;
  counts.set(key, (counts.get(key) ?? 0) + count);
}

/**
 * Narrow a stored offer condition to the taxonomy.
 *
 * `offers.condition` still admits the transitional `'used'` until migration
 * `0031` narrows its CHECK. `offer-projection.ts` and
 * `services/condition/condition-projection.ts` each carry this same one-line
 * narrowing and say that all of them disappear together — a third copy is the
 * established shape here, and the alternative (counting `used` as its own
 * bucket) would put a key on a chip that no filter accepts.
 */
function narrowStoredCondition(stored: string): OfferConditionKey {
  return (stored === 'used' ? 'used_good' : stored) as OfferConditionKey;
}

/**
 * The mix, from the census.
 *
 * The three dimensional maps are built ONLY from `currentCount` — a lapsed
 * offer is not part of what this merchant is currently offering, and filing it
 * under a condition or a market would put it in a chip a shopper could then tap
 * and be shown nothing. `staleOfferCount` carries that population instead, as
 * one number about Mercaria's information rather than about the shop's stock.
 */
export function summariseMerchantOfferMix(
  census: readonly MerchantOfferCensusRow[],
): MerchantOfferMix {
  let activeOfferCount = 0;
  let currentOfferCount = 0;
  const byKind = new Map<OfferKind, number>();
  const bySellerRole = new Map<OfferSellerRole, number>();
  const byCondition = new Map<OfferConditionKey, number>();
  const byMarket = new Map<string | null, number>();

  for (const row of census) {
    activeOfferCount += row.activeCount;
    currentOfferCount += row.currentCount;
    add(byKind, row.kind as OfferKind, row.currentCount);
    add(
      bySellerRole,
      deriveOfferSellerRole(row.sellerMerchantId, row.operatorMerchantId),
      row.currentCount,
    );
    add(byCondition, narrowStoredCondition(row.condition), row.currentCount);
    add(byMarket, row.country, row.currentCount);
  }

  return {
    activeOfferCount,
    currentOfferCount,
    staleOfferCount: activeOfferCount - currentOfferCount,
    byKind: bucketsOf(byKind),
    bySellerRole: bucketsOf(bySellerRole),
    byCondition: bucketsOf(byCondition),
    byMarket: bucketsOf(byMarket),
  };
}
