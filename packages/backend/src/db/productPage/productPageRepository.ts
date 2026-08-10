/**
 * The batched identity reads one product page needs (#71).
 *
 * READ ONLY, and deliberately narrow. This domain owns no table, writes
 * nothing, and adds no projection — #61 measured the canonical graph at a
 * million offers and adopted no materialized read model, so a product page is
 * composed from the same normalized reads every other surface uses.
 *
 * ## Why these are batched and the rest are not
 *
 * A page renders up to a page-size of offer rows, and each row names a seller.
 * Resolving that seller one row at a time is the N+1 whose cost grows with the
 * one thing a popular product has a lot of. Everything else the page reads —
 * the product, its variants, the comparison — is O(1) requests already.
 *
 * ## Every column here is public
 *
 * A name, a slug, a handle: exactly what a row renders and what a public page
 * already serves through `/merchants/:idOrSlug` and `/stores/:handle`. There is
 * no contact column, no payment column and no owner id beyond the Oxy account
 * id a public seller profile is already keyed on (#92), so a serializer cannot
 * leak what the query does not select.
 */

import { and, countDistinct, eq, inArray } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { listings } from '../schema/catalog.js';
import { merchants } from '../schema/merchants.js';
import { nativeListingLinks } from '../schema/offers.js';
import { stores } from '../schema/stores.js';

/** A canonical merchant, as an offer row names it. */
export interface ProductPageMerchantRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * Who owns one native listing.
 *
 * `ownerType` plus exactly one of the two owners — `listings_owner_exclusivity_check`
 * is what makes that true at the row, and the projection reads both columns
 * rather than inferring one from the other, so a widening of that CHECK cannot
 * silently turn a person's inventory into a store's.
 */
export interface ProductPageListingSellerRow {
  readonly listingId: string;
  readonly ownerType: string;
  readonly oxyUserId: string | null;
  readonly storeId: string | null;
  readonly storeName: string | null;
  readonly storeHandle: string | null;
}

/** Several merchants by id, in one round trip. */
export async function findProductPageMerchants(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<ProductPageMerchantRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: merchants.id, name: merchants.name, slug: merchants.slug })
    .from(merchants)
    .where(inArray(merchants.id, [...ids]));
}

/**
 * The owner of each native listing, with the store's public identity joined.
 *
 * A LEFT join, because a P2P listing has no store — an inner join would drop
 * every person's offer from the page and the symptom would be a comparison
 * that quietly contains only shops.
 */
export async function findProductPageListingSellers(
  db: DatabaseOrTransaction,
  listingIds: readonly string[],
): Promise<ProductPageListingSellerRow[]> {
  if (listingIds.length === 0) return [];
  return db
    .select({
      listingId: listings.id,
      ownerType: listings.ownerType,
      oxyUserId: listings.oxyUserId,
      storeId: listings.storeId,
      storeName: stores.name,
      storeHandle: stores.handle,
    })
    .from(listings)
    .leftJoin(stores, eq(stores.id, listings.storeId))
    .where(inArray(listings.id, [...listingIds]));
}

/**
 * How many ACTIVE native listings are attached to these canonical variants —
 * the listing-first half of the shadow comparison (ADR 0002 D24 phase 3).
 *
 * Deliberately a DIFFERENT route from the one the canonical page takes. The
 * page serves `offers` rows the converger materialised; this counts the
 * ATTACHMENTS the matcher wrote, joined to the live listing status. The two can
 * genuinely disagree — an attached listing whose offer was never converged, an
 * offer left standing after a listing was restricted — and a shadow comparison
 * measuring the same table twice would be a check that cannot distinguish
 * success from failure.
 *
 * `countDistinct` on the LISTING, because one listing attaches once per
 * configuration and counting links would report a five-variant listing as five
 * ways to buy the thing.
 */
export async function countActiveNativeListingsForCanonicalVariants(
  db: DatabaseOrTransaction,
  canonicalVariantIds: readonly string[],
): Promise<number> {
  if (canonicalVariantIds.length === 0) return 0;
  const rows = await db
    .select({ total: countDistinct(nativeListingLinks.listingId) })
    .from(nativeListingLinks)
    .innerJoin(listings, eq(listings.id, nativeListingLinks.listingId))
    .where(
      and(
        inArray(nativeListingLinks.canonicalVariantId, [...canonicalVariantIds]),
        eq(nativeListingLinks.status, 'active'),
        eq(listings.status, 'active'),
      ),
    );
  // `count` decodes as a JS string through postgres.js on a bigint-shaped
  // aggregate, and the arithmetic that follows is a comparison. Coerced at the
  // boundary rather than trusted from the inferred type.
  return Number(rows[0]?.total ?? 0);
}
