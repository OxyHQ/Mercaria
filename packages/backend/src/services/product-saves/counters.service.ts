/**
 * Counter rebuilds and drift detection — the operator's half of #80 counter
 * rule 3 and acceptance 6.
 *
 * ## Detection and repair are separate acts
 *
 * `readCounterDrift` reports and changes nothing; `rebuildCounters` repairs and
 * reports nothing new. That separation is the `payment_discrepancies` posture
 * and it exists because a sweep that silently rewrote a wrong number would also
 * silently hide whatever was writing it — the drift is EVIDENCE, and an
 * operator who never sees it never learns that a path is broken.
 *
 * ## Both counters, because they answer different questions
 *
 * `product_save_aggregates.save_count` is how many people saved a canonical
 * PRODUCT; `listings.favorite_count` is how many saved one exact LISTING. #80
 * counter rule 2 keeps the second scoped to listing saves, and the two are
 * reported side by side rather than summed anywhere — a total across them would
 * double-count every buyer whose favorite the migration also turned into a
 * product save.
 */

import type { ProductSaveCounterDrift } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  countBuyerAuthoredProductSaves,
  countMigratedProductSaves,
  findCanonicalProductIdsWithSaves,
} from '../../db/productSaves/productSaveRepository.js';
import {
  findListingFavoriteCounterDrift,
  findProductSaveCounterDrift,
  findStaleProductSaveAggregates,
  readProductSaveAggregateTrace,
  rebuildListingFavoriteCount,
  rebuildProductSaveAggregate,
} from '../../db/productSaves/productSaveAggregateRepository.js';

export interface CounterDriftQuery {
  readonly limit?: number;
  readonly productCursor?: string;
  readonly listingCursor?: string;
}

/** One bounded, resumable pass of both drift probes. */
export async function readCounterDrift(
  query: CounterDriftQuery = {},
): Promise<ProductSaveCounterDrift> {
  const limit = Math.min(query.limit ?? 100, config.productSaves.counterSweepBatchSize);
  const db = getDb();

  const [products, listings] = await Promise.all([
    findProductSaveCounterDrift(limit, query.productCursor, db),
    findListingFavoriteCounterDrift(limit, query.listingCursor, db),
  ]);

  return {
    scannedProducts: products.scanned,
    scannedListings: listings.scanned,
    productDrift: products.drift,
    listingDrift: listings.drift,
    ...(products.nextCursor ? { nextProductCursor: products.nextCursor } : {}),
    ...(listings.nextCursor ? { nextListingCursor: listings.nextCursor } : {}),
  };
}

/**
 * Rebuild one product's save counter.
 *
 * Idempotent by construction — the same `count(*)` however many times it runs —
 * so an operator repeating it converges rather than compounding, which is what
 * makes it safe to expose at all.
 */
export async function rebuildOneProductCounter(canonicalProductId: string): Promise<number> {
  return rebuildProductSaveAggregate(canonicalProductId);
}

/** Rebuild one listing's favorite counter, from `favorites`. */
export async function rebuildOneListingCounter(listingId: string): Promise<number> {
  return rebuildListingFavoriteCount(listingId);
}

/**
 * Rebuild a bounded page of aggregates, oldest-rebuilt first.
 *
 * `findStaleProductSaveAggregates` visits rows that HAVE an aggregate; a
 * product with saves and no aggregate row is reached by the second pass, which
 * walks `product_saves` itself. Both are needed and neither subsumes the other:
 * the first repairs a number that went wrong, the second creates one that was
 * never written — which is the state a save left behind by a path that skipped
 * the rebuild would be in, and precisely the state a drift probe over
 * `product_save_aggregates` alone can never see.
 */
export async function rebuildCounterPage(limit?: number): Promise<{
  rebuiltFromAggregates: number;
  rebuiltFromSaves: number;
  nextSaveCursor?: string;
}> {
  const size = Math.min(limit ?? 100, config.productSaves.counterSweepBatchSize);
  const db = getDb();

  const stale = await findStaleProductSaveAggregates(size, db);
  for (const canonicalProductId of stale) {
    await rebuildProductSaveAggregate(canonicalProductId, db);
  }

  const withSaves = await findCanonicalProductIdsWithSaves(size, undefined, db);
  for (const canonicalProductId of withSaves) {
    await rebuildProductSaveAggregate(canonicalProductId, db);
  }

  const last = withSaves[withSaves.length - 1];
  return {
    rebuiltFromAggregates: stale.length,
    rebuiltFromSaves: withSaves.length,
    ...(withSaves.length === size && last ? { nextSaveCursor: last } : {}),
  };
}

/** What an operator trace of one product's counter reports. */
export interface ProductSaveTrace {
  readonly canonicalProductId: string;
  readonly storedCount?: number;
  readonly derivedCount: number;
  readonly countsAgree: boolean;
  readonly lastRebuiltAt?: string;
  readonly migratedSaves: number;
  readonly buyerAuthoredSaves: number;
}

/**
 * Trace one product's saves.
 *
 * Opens from a CANONICAL PRODUCT ID and nothing else — no Oxy account id, no
 * listing, no order. "Who saved this product" is not a question this surface
 * can be asked (#80 privacy rule 1), and the reason it cannot is that every
 * value it returns is a count.
 *
 * `countsAgree` is stated explicitly rather than left to the reader to compare,
 * the #60 metrics decision: a trace whose two numbers happen to differ by one is
 * exactly the thing a person skims past.
 */
export async function traceProductSaves(canonicalProductId: string): Promise<ProductSaveTrace> {
  const db = getDb();
  const [{ stored, derived }, migrated, buyerAuthored] = await Promise.all([
    readProductSaveAggregateTrace(canonicalProductId, db),
    countMigratedProductSaves(canonicalProductId, db),
    countBuyerAuthoredProductSaves(canonicalProductId, db),
  ]);

  return {
    canonicalProductId,
    ...(stored ? { storedCount: stored.saveCount } : {}),
    derivedCount: derived,
    countsAgree: stored !== undefined && stored.saveCount === derived,
    ...(stored?.lastRebuiltAt ? { lastRebuiltAt: stored.lastRebuiltAt.toISOString() } : {}),
    migratedSaves: migrated,
    buyerAuthoredSaves: buyerAuthored,
  };
}
