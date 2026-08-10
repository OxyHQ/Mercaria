/**
 * Counters and aggregates REBUILT from the rows that survive a merge or split
 * (#59 merge invariant 6).
 *
 * "Counters and search documents are rebuilt from source records rather than
 * incremented blindly." The reason is specific rather than stylistic: a merge
 * that added the loser's count to the winner's would double every row that was
 * ALREADY shared — a source link both entities held, a variant the winner
 * already had under a different id — and the error would be invisible, because a
 * count has no rows to check it against. Deriving is also what makes the phase
 * idempotent: running it twice produces the same number, which a replay needs.
 *
 * ## Search documents are a NAMED seam, not a silent omission
 *
 * The issue's acceptance 5 asks that "search and public pages converge after
 * correction through documented reindex jobs". Mercaria's canonical search
 * columns (`search_vector`, `search_tokens`) are maintained by the catalogue
 * write path, and the reindexing consumer that drains
 * `attribute_reindex_requests` belongs to **#61**, which owns discovery indexing
 * — #94 already left that queue for it. A merge therefore converges the stored
 * COUNTERS here and leaves the reindex to the job that owns it; what makes this
 * a seam rather than a gap is that the generated `search_vector` columns are
 * recomputed by Postgres on every write, so the winner's own document is
 * correct the moment its row is touched.
 */

import { eq, sql } from 'drizzle-orm';
import type { MergeableEntityType } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariants,
} from '../../db/schema/canonicalCatalog.js';
import { brands } from '../../db/schema/organizations.js';
import { rebuildScopedAggregate } from '../reviews/review-aggregate.service.js';
import {
  listPriceSeriesForScopeIds,
  requestPriceSeriesRebuildByIds,
} from '../../db/priceHistory/priceSeriesRepository.js';
import { rebuildProductSaveAggregate } from '../../db/productSaves/productSaveAggregateRepository.js';

/** `canonical_products.variant_count`, derived. */
async function refreshVariantCount(productId: string, db: DatabaseOrTransaction): Promise<void> {
  await db
    .update(canonicalProducts)
    .set({
      variantCount: sql`(select count(*)::int from ${canonicalVariants}
                         where ${canonicalVariants.productId} = ${productId}
                           and ${canonicalVariants.status} <> 'merged')`,
    })
    .where(eq(canonicalProducts.id, productId));
}

/** `canonical_product_families.product_count`, derived. */
async function refreshFamilyCount(familyId: string, db: DatabaseOrTransaction): Promise<void> {
  await db
    .update(canonicalProductFamilies)
    .set({
      productCount: sql`(select count(*)::int from ${canonicalProducts}
                         where ${canonicalProducts.familyId} = ${familyId}
                           and ${canonicalProducts.status} <> 'merged')`,
    })
    .where(eq(canonicalProductFamilies.id, familyId));
}

/** `brands.product_count`, derived. `active_offer_count` is #57's to maintain. */
async function refreshBrandCount(brandId: string, db: DatabaseOrTransaction): Promise<void> {
  await db
    .update(brands)
    .set({
      productCount: sql`(select count(*)::int from ${canonicalProducts}
                         where ${canonicalProducts.brandId} = ${brandId}
                           and ${canonicalProducts.status} <> 'merged')`,
    })
    .where(eq(brands.id, brandId));
}

/**
 * Re-derive every rollup the two sides of a merge or split touch.
 *
 * Both sides, always. The loser's numbers must go to zero (or to what its
 * tombstone genuinely still holds) as surely as the winner's must absorb what
 * moved — a rebuild that only touched the survivor would leave a tombstone
 * claiming twelve products, which is exactly the figure an operator would read
 * when trying to understand what the merge did.
 *
 * Review aggregates are re-derived through #76's own `rebuildScopedAggregate`,
 * which is the authority for them; this module does not compute a rating.
 * Failures there are logged rather than thrown, because #76's own sweep
 * re-derives them and a merge that already moved every row must not be rolled
 * back by an aggregate that can converge on its own.
 */
export async function rebuildEntityRollups(
  entityType: MergeableEntityType,
  loserId: string,
  winnerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  let rebuilt = 0;
  switch (entityType) {
    case 'canonical_variant': {
      const rows = await db
        .select({ productId: canonicalVariants.productId })
        .from(canonicalVariants)
        .where(sql`${canonicalVariants.id} in (${loserId}, ${winnerId})`);
      for (const productId of new Set(rows.map((row) => row.productId))) {
        await refreshVariantCount(productId, db);
        rebuilt += 1;
      }
      return rebuilt;
    }
    case 'canonical_product': {
      for (const productId of [loserId, winnerId]) {
        await refreshVariantCount(productId, db);
        rebuilt += 1;
      }
      const rows = await db
        .select({ familyId: canonicalProducts.familyId, brandId: canonicalProducts.brandId })
        .from(canonicalProducts)
        .where(sql`${canonicalProducts.id} in (${loserId}, ${winnerId})`);
      for (const familyId of new Set(rows.map((row) => row.familyId).filter((id): id is string => id !== null))) {
        await refreshFamilyCount(familyId, db);
        rebuilt += 1;
      }
      for (const brandId of new Set(rows.map((row) => row.brandId).filter((id): id is string => id !== null))) {
        await refreshBrandCount(brandId, db);
        rebuilt += 1;
      }
      return rebuilt;
    }
    case 'canonical_product_family': {
      for (const familyId of [loserId, winnerId]) {
        await refreshFamilyCount(familyId, db);
        rebuilt += 1;
      }
      return rebuilt;
    }
    case 'brand': {
      for (const brandId of [loserId, winnerId]) {
        await refreshBrandCount(brandId, db);
        rebuilt += 1;
      }
      return rebuilt;
    }
    case 'merchant':
      // `merchants` carries `rating`/`rating_count` and `offer_count`. The
      // rating pair is #76's projection and is re-derived by
      // {@link rebuildEntityAggregates} AFTER the phase commits; `offer_count`
      // is #57's rollup, maintained by the offer converger — deriving it here
      // would make two writers of one number, which is the disagreement these
      // rollups exist to prevent.
      return 0;
    case 'storefront':
      // A storefront carries no derived counter of its own; what a merge of one
      // changes is which merchant operates it, and that merchant's own rollups
      // are #57's. Zero here is the fact.
      return 0;
    case 'organization':
      // An organization holds no derived counter of its own — its products and
      // offers are reached through the brands and merchants it owns, and those
      // relationships are `commerce_relationships` rows a merge repoints without
      // changing any total. Returning zero here is the fact, not a gap.
      return 0;
  }
}

/**
 * #76's aggregate rebuild, for both sides of the move — OUTSIDE the phase
 * transaction, and that is not a preference.
 *
 * `rebuildScopedAggregate` opens its own connection and UPDATEs the same
 * `canonical_products` / `merchants` row the phase transaction has locked. Called
 * from inside, it waits for a lock the caller holds and the caller waits for it:
 * a deadlock that presents as a merge hanging until the test runner's timeout,
 * with no error anywhere. #56's own product merge records the same rule for the
 * adjacent reason — a rebuild inside the transaction would derive from rows
 * nobody else can see yet.
 *
 * Best-effort: #76's sweep re-derives these on its own clock, and a merge that
 * has already moved every row must not be rolled back by an aggregate that
 * converges by itself.
 */
export async function rebuildEntityAggregates(
  entityType: MergeableEntityType,
  loserId: string,
  winnerId: string,
): Promise<void> {
  if (entityType === 'canonical_product') {
    await rebuildReviewScopes('product', [loserId, winnerId]);
    await rebuildProductSaveCounts([loserId, winnerId]);
    await rearmPriceSeries({ canonicalProductIds: [loserId, winnerId] });
    return;
  }
  if (entityType === 'canonical_variant') {
    await rearmPriceSeries({ canonicalVariantIds: [loserId, winnerId] });
    return;
  }
  if (entityType === 'merchant') {
    await rebuildReviewScopes('merchant', [loserId, winnerId]);
  }
}

/**
 * #78's price series, for both sides — RE-ARMED, never rehomed (#59 merge
 * invariant 6).
 *
 * A series is a projection, so `merge-plan.ts` retains the loser's with the
 * tombstone and there is no row to move. What the merge changes is the INPUT:
 * a price observation carries no canonical id at all, so the `offers` phase
 * repointing the offers is what puts the loser's whole history under the
 * winner, and one rebuild picks it up. The tombstone's own series rebuilds to
 * ZERO points for the same reason, which is how it self-clears instead of
 * sitting as a stale answer forever.
 *
 * Best-effort and outside the phase transaction, like the two rebuilds beside
 * it: this only bumps a revision, the dispatcher does the work, and a merge
 * that has already moved every row must not be rolled back over a queue entry.
 */
async function rearmPriceSeries(scope: {
  canonicalProductIds?: readonly string[];
  canonicalVariantIds?: readonly string[];
}): Promise<void> {
  try {
    const series = await listPriceSeriesForScopeIds(scope);
    await requestPriceSeriesRebuildByIds(series.map((row) => row.id));
  } catch (err) {
    log.general.warn(
      { err, scope },
      '[Curation] price-series re-arm after a merge failed; the next observation will request it',
    );
  }
}

/**
 * #80's save counter, for both sides — DERIVED, never summed (#59 merge
 * invariant 6).
 *
 * The loser's row is retained by the tombstone (`merge-plan.ts` says so and the
 * census enforces it), so its count has to be re-derived too: after the merge it
 * covers only the saves that stayed behind, and leaving the pre-merge figure
 * there is exactly the number an operator would read when trying to understand
 * what the merge did.
 *
 * Best-effort, like the review rebuild beside it and for the same reason: every
 * row has already moved, the counter converges on its own sweep, and rolling a
 * completed merge back over an aggregate would be the worse outcome.
 */
async function rebuildProductSaveCounts(canonicalProductIds: readonly string[]): Promise<void> {
  for (const canonicalProductId of canonicalProductIds) {
    try {
      await rebuildProductSaveAggregate(canonicalProductId);
    } catch (err) {
      log.general.warn(
        { err, canonicalProductId },
        '[Curation] product save aggregate rebuild after a merge failed; the #80 sweep will re-derive it',
      );
    }
  }
}

/** #76's rebuild, best-effort, for both sides of the move. */
async function rebuildReviewScopes(
  scope: 'product' | 'merchant',
  targetIds: readonly string[],
): Promise<void> {
  for (const targetId of targetIds) {
    try {
      await rebuildScopedAggregate(scope, targetId);
    } catch (err) {
      log.general.warn(
        { err, scope, targetId },
        '[Curation] review aggregate rebuild after a merge failed; #76 sweep will re-derive it',
      );
    }
  }
}
