/**
 * The narrow reads the store price-analytics tool needs from tables it does not
 * own (`offers`, `listings`, `product_variants`, the canonical catalogue and
 * `native_store_links`).
 *
 * Each is a PROJECTION naming every column it selects — #82's
 * `priceSignalSubjectRepository` rule: a `select()` over `offers` would put a
 * source record, an affiliate template and a destination URL into a domain whose
 * output is about the store's competitors, and a projection that names its
 * columns cannot acquire one when somebody adds a column upstream.
 *
 * Nothing here reads `db/catalog/listingRepository.ts` or any ranking or search
 * repository: this domain answers a store about ITS OWN listings, and the
 * listing-first ordering engine is part of the discovery surface a plan module
 * may not reach (`merchant-plan-isolation.test.ts`).
 */

import { and, asc, count, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listings, productVariants } from '../schema/catalog.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { nativeStoreLinks } from '../schema/merchants.js';
import { offers } from '../schema/offers.js';

/** One of the store's live native listing variants that is matched to a canonical variant. */
export interface StoreComparableListing {
  readonly offerId: string;
  readonly productVariantId: string;
  readonly listingId: string;
  readonly listingTitle: string;
  readonly variantTitle: string | null;
  readonly sku: string | null;
  readonly canonicalVariantId: string;
  readonly canonicalProductId: string | null;
  readonly canonicalProductName: string | null;
  /** The offer's declared condition key (#90). */
  readonly condition: string;
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
}

/**
 * What makes a listing variant one of the store's comparable ones: an ACTIVE
 * native offer (the converger materialises one only for an active listing whose
 * variant is attached to a canonical variant, ADR 0002 D18) on a listing that is
 * still `active` and still the store's. The second listing condition is asked
 * again rather than trusted to the projection, so a listing archived a moment
 * ago is not analysed while its offer waits to be retired.
 */
function comparableWhere(storeId: string) {
  return and(
    eq(offers.kind, 'native'),
    eq(offers.status, 'active'),
    isNotNull(offers.productVariantId),
    eq(listings.storeId, storeId),
    eq(listings.status, 'active'),
  );
}

/**
 * The store's comparable listing variants, in a stable order (`product_variants.id`),
 * at most `limit` of them, starting after `afterProductVariantId`.
 */
export async function listStoreComparableListings(
  input: {
    readonly storeId: string;
    readonly limit: number;
    readonly afterProductVariantId?: string;
    readonly productVariantId?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<StoreComparableListing[]> {
  const rows = await db
    .select({
      offerId: offers.id,
      productVariantId: productVariants.id,
      listingId: listings.id,
      listingTitle: listings.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      canonicalVariantId: offers.canonicalVariantId,
      canonicalProductId: canonicalVariants.productId,
      canonicalProductName: canonicalProducts.name,
      condition: offers.condition,
      priceAmount: offers.priceAmount,
      priceCurrency: offers.priceCurrency,
    })
    .from(offers)
    .innerJoin(productVariants, eq(productVariants.id, offers.productVariantId))
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .leftJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .leftJoin(canonicalProducts, eq(canonicalProducts.id, canonicalVariants.productId))
    .where(
      and(
        comparableWhere(input.storeId),
        input.afterProductVariantId === undefined
          ? undefined
          : gt(productVariants.id, input.afterProductVariantId),
        input.productVariantId === undefined
          ? undefined
          : eq(productVariants.id, input.productVariantId),
      ),
    )
    .orderBy(asc(productVariants.id))
    .limit(input.limit);
  return rows.map((row) => ({
    ...row,
    variantTitle: row.variantTitle === 'Default Title' ? null : row.variantTitle,
  }));
}

/** How many comparable listing variants the store has — the denominator a truncated read states. */
export async function countStoreComparableListings(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(offers)
    .innerJoin(productVariants, eq(productVariants.id, offers.productVariantId))
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .where(comparableWhere(storeId));
  return Number(rows[0]?.value ?? 0);
}

/**
 * Which of `listingIds` belong to the store — so its OTHER listings of the same
 * product are the store's own and never counted as a competing seller.
 */
export async function listStoreOwnedListingIds(
  storeId: string,
  listingIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  const rows = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.storeId, storeId), inArray(listings.id, [...listingIds])));
  return new Set(rows.map((row) => row.id));
}

/**
 * The canonical merchant this store is VERIFIABLY the same seller as (ADR 0002 D4,
 * `native_store_links`), or `null`.
 *
 * A linked store's external offers — its own website through a feed, say — are
 * the store's own prices, and comparing a store against itself would report it
 * as its own competitor.
 */
export async function findActiveLinkedMerchantId(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const rows = await db
    .select({ merchantId: nativeStoreLinks.merchantId })
    .from(nativeStoreLinks)
    .where(and(eq(nativeStoreLinks.storeId, storeId), eq(nativeStoreLinks.status, 'active')))
    .limit(1);
  return rows[0]?.merchantId ?? null;
}
