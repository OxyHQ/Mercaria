/**
 * Stage 6 — rebuild the derived counts a backfill can leave behind, and
 * Stage 7 — request search reindexing for what the migration touched (#60
 * migration step 9).
 *
 * ## Why derived counts need rebuilding at all
 *
 * `canonical_products.variant_count` and
 * `canonical_product_families.product_count` are PROJECTIONS: each is maintained
 * by the write service that changes their input, and each is therefore only as
 * correct as the last write that remembered to refresh it. A bulk migration is
 * precisely the event that stresses that assumption — it mints thousands of
 * variants through one path and then re-runs after a crash through another. So
 * this stage re-derives both from their sources and records whether the stored
 * value had drifted.
 *
 * The recorded difference is the point. `projection_current` on every product is
 * evidence the maintaining writers are correct; a run full of
 * `projection_refreshed` is evidence one of them is not, and names which
 * products so somebody can find out which write path missed them.
 *
 * ## Search indexing is a REQUEST, and #61 owns the consumer
 *
 * `attribute_reindex_requests` (#94) is a durable queue with a lease shape and
 * deliberately NO consumer yet — ADR 0002 D21 forbids adding a search dependency
 * until #61 has benchmarked the real queries. So the honest thing this stage can
 * do is put rows in that queue, gated by `CANONICAL_SEARCH_INDEXING_ENABLED`,
 * and say so. It does not index anything, does not build a projection table and
 * does not add a search engine. When #61 lands its drain, these rows are already
 * waiting.
 *
 * The flag gates the REQUEST rather than the loop, which inverts the usual
 * "gate the loop, never the record" rule on purpose: there is no loop here to
 * gate, and a deployment that will never index does not want a queue growing one
 * row per canonical product. `reindex_disabled` / `skipped` records that the
 * decision was made, so the counter says how much work is waiting to be
 * requested rather than lost.
 */

import { asc, gt } from 'drizzle-orm';
import { getDb } from '../../../db/postgres.js';
import { config } from '../../../config/index.js';
import { canonicalProducts } from '../../../db/schema/canonicalCatalog.js';
import { attributeReindexRequests } from '../../../db/schema/attributeRegistry.js';
import { countVariantsForProduct } from '../../../db/canonical/canonicalVariantRepository.js';
import { refreshFamilyProductCount } from '../../../db/canonical/productFamilyRepository.js';
import { refreshBrandProductCount } from '../../../db/canonical/brandRepository.js';
import {
  countProductsForBrand,
  countProductsForFamily,
  updateCanonicalProduct,
} from '../../../db/canonical/canonicalProductRepository.js';
import {
  examineAll,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
  type SubjectVerdict,
} from '../stage-context.js';

/**
 * Re-derive one canonical product's `variant_count`, and its family's
 * `product_count` alongside it.
 *
 * The family is refreshed from the product's page rather than in a pass of its
 * own because a family's count is a function of its products, so the set of
 * families needing a refresh is exactly the set of families the products on this
 * page belong to — a second cursor over families would scan every family in the
 * catalogue to find them.
 */
export async function runRebuildProjectionsPage(
  context: StageContext,
): Promise<StagePageResult> {
  const db = getDb();
  const rows = await db
    .select({
      id: canonicalProducts.id,
      variantCount: canonicalProducts.variantCount,
      familyId: canonicalProducts.familyId,
      brandId: canonicalProducts.brandId,
    })
    .from(canonicalProducts)
    .where(context.cursor === null ? undefined : gt(canonicalProducts.id, context.cursor))
    .orderBy(asc(canonicalProducts.id))
    .limit(context.limit);

  const refreshedFamilies = new Set<string>();
  // #749: brands are re-derived here too. Before that the merge rollup was the
  // ONLY writer of `brands.product_count`, so a brand nobody merged had no
  // repair path at all and a corrected derivation could never reach it.
  const refreshedBrands = new Set<string>();
  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'canonical_product', canonicalProductId: row.id }),
    async (row): Promise<SubjectVerdict> => {
      const actual = await countVariantsForProduct(db, row.id);

      if (row.familyId !== null && !refreshedFamilies.has(row.familyId)) {
        refreshedFamilies.add(row.familyId);
        await refreshFamilyProductCount(
          db,
          row.familyId,
          await countProductsForFamily(db, row.familyId),
        );
      }

      if (row.brandId !== null && !refreshedBrands.has(row.brandId)) {
        refreshedBrands.add(row.brandId);
        await refreshBrandProductCount(db, row.brandId, await countProductsForBrand(db, row.brandId));
      }

      if (actual === row.variantCount) {
        return {
          reasonCode: 'projection_current',
          detail: `variant_count ${String(actual)}`,
          canonicalProductId: row.id,
        };
      }

      await updateCanonicalProduct(db, row.id, { variantCount: actual });
      return {
        reasonCode: 'projection_refreshed',
        detail: `variant_count ${String(row.variantCount)} → ${String(actual)}`,
        canonicalProductId: row.id,
      };
    },
  );

  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}

/**
 * Enqueue a reindex request per canonical product — or record that this
 * deployment has search indexing off.
 *
 * The request id is DETERMINISTIC (`attribute_reindex_requests.id` is a
 * caller-supplied text primary key), so a re-run of this stage converges on the
 * same rows instead of queueing the catalogue twice. That is #94's own
 * convention for the table and the reason it has no `generatedId()`.
 */
export async function runSearchReindexPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const rows = await db
    .select({ id: canonicalProducts.id })
    .from(canonicalProducts)
    .where(context.cursor === null ? undefined : gt(canonicalProducts.id, context.cursor))
    .orderBy(asc(canonicalProducts.id))
    .limit(context.limit);

  const enabled = config.canonicalRollout.searchIndexingEnabled;
  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'canonical_product', canonicalProductId: row.id }),
    async (row): Promise<SubjectVerdict> => {
      if (!enabled) {
        return {
          reasonCode: 'reindex_disabled',
          detail: 'CANONICAL_SEARCH_INDEXING_ENABLED is off',
          canonicalProductId: row.id,
        };
      }
      await db
        .insert(attributeReindexRequests)
        .values({
          id: `product:${row.id}:*:backfill`,
          entityKind: 'product',
          entityId: row.id,
          reason: 'backfill',
          enqueuedAt: context.now,
        })
        .onConflictDoNothing({ target: attributeReindexRequests.id });
      return {
        reasonCode: 'reindex_requested',
        detail: 'awaiting #61 consumer',
        canonicalProductId: row.id,
      };
    },
  );

  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}
