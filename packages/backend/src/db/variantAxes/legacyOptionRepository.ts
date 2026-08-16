/**
 * READ-ONLY access to the legacy free-text option tables (#367 step 4,
 * ADR 0007 D6/D13).
 *
 * `listing_options` and `product_variant_option_values` are RETAINED. This file
 * exists so the backfill can read them without any module in this domain being
 * able to write one: there is no insert, no update and no delete anywhere in it,
 * and `variant-axis-isolation.test.ts` fails the build if one appears. That is
 * ADR 0007 D13's "retained as legacy claims — not dropped, not silently
 * normalized" held by the call graph rather than by a promise.
 *
 * The write path for both tables stays `db/catalog/listingRepository.ts` and
 * `db/catalog/variantRepository.ts`, which replace a listing's whole option list
 * on every update. That REPLACEMENT is why nothing in this domain carries a
 * foreign key onto either table: the id of a legacy row is not stable across a
 * merchant editing their listing, so a claim keyed on one would be re-created on
 * every edit and a `restrict` edge would refuse every edit outright. The claims
 * converge on the CONTENT instead (`<table>_identity_key`), which survives the
 * churn.
 */

import { asc, countDistinct, eq, gt, inArray } from 'drizzle-orm';
import {
  listingOptions,
  listings,
  productVariantOptionValues,
  productVariants,
} from '../schema/catalog.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One page of listings to migrate, keyset-ordered so a resumed pass advances. */
export interface LegacyListingPage {
  readonly listingIds: readonly string[];
  /** The id to resume after, or `null` when the page reached the end. */
  readonly resumeAfterListingId: string | null;
}

/**
 * The listings that have at least one legacy option row, after a cursor.
 *
 * Keyset on the primary key rather than an offset: an offset pass re-reads
 * whatever the previous page shifted, and this one runs against a live
 * catalogue. The primary key is a uuid v7, which is k-sortable — but the pass
 * does NOT depend on that, because it only needs a total order to page through,
 * not a chronological one.
 *
 * A listing with NO options is skipped, so `scanned.listings` in the report
 * counts listings the pass actually looked at rather than the catalogue's size.
 */
export async function listListingIdsWithLegacyOptions(
  db: DatabaseOrTransaction,
  input: { afterListingId: string | null; limit: number },
): Promise<LegacyListingPage> {
  const rows = await db
    .selectDistinct({ listingId: listingOptions.listingId })
    .from(listingOptions)
    .innerJoin(listings, eq(listings.id, listingOptions.listingId))
    .where(
      input.afterListingId === null
        ? undefined
        : gt(listingOptions.listingId, input.afterListingId),
    )
    .orderBy(asc(listingOptions.listingId))
    .limit(input.limit);

  const listingIds = rows.map((row) => row.listingId);
  return {
    listingIds,
    resumeAfterListingId:
      listingIds.length < input.limit ? null : (listingIds[listingIds.length - 1] ?? null),
  };
}

/**
 * How many listings carry legacy options AT ALL — the pager's positive control.
 *
 * `scanned.listings === 0` is a perfectly good answer for a catalogue with
 * nothing to migrate, and it is also what a broken cursor, a wrong predicate or
 * an empty join produces. The two are indistinguishable from the counters alone,
 * and the report even satisfies its own sum check, because 0 = 0 + 0 + 0. This
 * is the number that tells them apart, and `assertReportSums` refuses a
 * first-page pass that scanned nothing while this is positive.
 *
 * One indexed aggregate over a table the pass is already reading, so it costs a
 * statement per pass rather than per listing.
 */
export async function countListingsWithLegacyOptions(
  db: DatabaseOrTransaction,
): Promise<number> {
  const [row] = await db
    .select({ total: countDistinct(listingOptions.listingId) })
    .from(listingOptions);
  return row?.total ?? 0;
}

export type LegacyListingOptionRow = typeof listingOptions.$inferSelect;
export type LegacyVariantOptionValueRow = typeof productVariantOptionValues.$inferSelect;

/** Every legacy option declared by a set of listings, in position order. */
export async function listLegacyListingOptions(
  db: DatabaseOrTransaction,
  listingIds: readonly string[],
): Promise<LegacyListingOptionRow[]> {
  if (listingIds.length === 0) return [];
  return db
    .select()
    .from(listingOptions)
    .where(inArray(listingOptions.listingId, [...listingIds]))
    .orderBy(asc(listingOptions.listingId), asc(listingOptions.position));
}

/** One variant and the listing it belongs to — the scope every write is checked against. */
export interface LegacyVariantRow {
  readonly variantId: string;
  readonly listingId: string;
}

/** Every variant of a set of listings. */
export async function listVariantsForListings(
  db: DatabaseOrTransaction,
  listingIds: readonly string[],
): Promise<LegacyVariantRow[]> {
  if (listingIds.length === 0) return [];
  const rows = await db
    .select({ variantId: productVariants.id, listingId: productVariants.listingId })
    .from(productVariants)
    .where(inArray(productVariants.listingId, [...listingIds]))
    .orderBy(asc(productVariants.listingId), asc(productVariants.position));
  return rows;
}

/** Every legacy option VALUE of a set of variants, in position order. */
export async function listLegacyVariantOptionValues(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<LegacyVariantOptionValueRow[]> {
  if (variantIds.length === 0) return [];
  return db
    .select()
    .from(productVariantOptionValues)
    .where(inArray(productVariantOptionValues.variantId, [...variantIds]))
    .orderBy(
      asc(productVariantOptionValues.variantId),
      asc(productVariantOptionValues.position),
    );
}
