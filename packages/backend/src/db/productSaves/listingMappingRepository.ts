/**
 * The listing → canonical product mapping, read for #80.
 *
 * A READ of #57's `native_listing_links` and #56's `canonical_variants`, and
 * nothing else: this domain never writes an attachment, never decides a match
 * and never mints a canonical product. #58 owns the first two and #60 the third,
 * and `product-save-isolation.test.ts` fails the build if a module here starts
 * to import their write services.
 *
 * The read is here rather than in `db/offers/` because it answers a question
 * only #80 asks — "given a favorited LISTING, which canonical product, if any,
 * may a save point at" — and its confidence rule (`CONFIDENT_LINK_METHODS`) is
 * #80's policy, not #57's.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { NativeListingLinkMethod } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { nativeListingLinks } from '../schema/offers.js';
import { canonicalVariants } from '../schema/canonicalCatalog.js';

/** One listing's ACTIVE canonical attachment, resolved to its product. */
export interface ListingCanonicalMapping {
  readonly listingId: string;
  readonly productVariantId: string;
  readonly canonicalVariantId: string;
  readonly canonicalProductId: string;
  readonly method: NativeListingLinkMethod;
}

/**
 * The ACTIVE canonical attachments of a batch of listings, resolved to their
 * canonical products.
 *
 * A listing may have several variants and therefore several attachments — forty
 * colours of one phone attach to forty canonical variants of ONE product, which
 * is the ordinary case and why the return is a list per listing rather than an
 * optional single value. The caller decides what to do when they disagree; this
 * read states what is there.
 *
 * `status = 'active'` is not a convenience filter: a REVOKED attachment is an
 * operator saying the listing is not that product, and a save derived from one
 * would put a person's saved list on the wrong product page.
 *
 * Canonical variants of a MERGED product resolve through the variant's own
 * `product_id`, which the merge already repointed — so this read never returns a
 * tombstone unless the merge itself left one, which the merge plan's
 * `conflict_gated` variant disposition prevents.
 */
export async function findListingCanonicalMappings(
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, ListingCanonicalMapping[]>> {
  if (listingIds.length === 0) return new Map();

  const rows = await db
    .select({
      listingId: nativeListingLinks.listingId,
      productVariantId: nativeListingLinks.productVariantId,
      canonicalVariantId: nativeListingLinks.canonicalVariantId,
      canonicalProductId: canonicalVariants.productId,
      method: nativeListingLinks.method,
    })
    .from(nativeListingLinks)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, nativeListingLinks.canonicalVariantId))
    .where(
      and(
        inArray(nativeListingLinks.listingId, [...listingIds]),
        eq(nativeListingLinks.status, 'active'),
      ),
    );

  const byListing = new Map<string, ListingCanonicalMapping[]>();
  for (const row of rows) {
    const existing = byListing.get(row.listingId);
    if (existing) existing.push(row);
    else byListing.set(row.listingId, [row]);
  }
  return byListing;
}
