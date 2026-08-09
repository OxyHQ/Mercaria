/**
 * The ONE place a native listing resolves to a canonical product, and a native
 * store to a canonical merchant (#76).
 *
 * Both the eligibility grant and the legacy-review classification job need these
 * answers, and they must give the SAME answer — a review classified onto product
 * X while its eligibility was granted against product Y is a rating nobody can
 * explain. So the resolutions live here, once, and both callers read them.
 *
 * ## Why the product resolution goes through an IDENTIFIER
 *
 * ADR 0002 D6 gives this job to `native_listing_links`, which #57/#71 own and
 * which does not exist yet. What DOES exist is `product_identifiers` and its
 * collision gate: `(canonical_scheme, canonical_value) WHERE status = 'active'`
 * admits exactly ONE active owner per GTIN, so "the active owner of this
 * barcode" is a decided fact rather than a guess — decided by #56's identifier
 * service, under its check-digit validation, with a newcomer written `disputed`
 * instead of stealing the key.
 *
 * That is a deliberately NARROW resolution and it is meant to be:
 *
 *  - no barcode on the purchased variant → no product target;
 *  - a barcode with no active identifier row → no product target;
 *  - a `disputed` or `superseded` identifier → no product target, because the
 *    collision gate is telling us two sources disagree about what this is;
 *  - a barcode whose active owner is a canonical VARIANT resolves to that
 *    variant's product, which is the grain a product review is written at
 *    (ADR 0002 D5: comparison happens at the product page).
 *
 * Every one of those returns `null`, and every caller treats `null` as "this
 * scope is not available for this line" rather than as an error. #76's migration
 * rule 1 asks for classification "without guessing ambiguous records"; refusing
 * to invent a product is what that means mechanically. When `native_listing_links`
 * lands it becomes the FIRST resolution attempted and this stays as the fallback
 * — neither of them ever guesses.
 */

import { and, eq } from 'drizzle-orm';
import type { IdentifierScheme } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { canonicalVariants, productIdentifiers } from '../schema/canonicalCatalog.js';
import { productVariants } from '../schema/catalog.js';
import { normalizeIdentifier } from '../../services/canonical/identifiers.js';
import { findActiveLinkByStore } from '../commerce-graph/nativeStoreLinkRepository.js';

/**
 * A bare barcode carries no scheme, so its DIGIT COUNT chooses one.
 *
 * That is how a GS1 barcode is read everywhere else too — the lengths are
 * disjoint by construction — and going through #56's registry rather than
 * reimplementing the check digit is what keeps a barcode that fails validation
 * resolving to nothing instead of to a plausible wrong product.
 *
 * A length outside the table resolves to nothing: `mpn` and `brand_model` need
 * a brand scope a native listing does not carry (#56 identifier rule 4), and
 * ISBNs arrive as their EAN form in a barcode field.
 */
const BARCODE_SCHEME_BY_DIGIT_COUNT: Readonly<Record<number, IdentifierScheme>> = Object.freeze({
  8: 'gtin8',
  12: 'upc',
  13: 'ean',
  14: 'gtin14',
});

/** The GTIN-14 an active identifier row would be keyed on, or `null`. */
function canonicalGtinFor(barcode: string): string | null {
  const digits = barcode.replace(/\D/gu, '');
  const scheme = BARCODE_SCHEME_BY_DIGIT_COUNT[digits.length];
  if (!scheme) return null;

  const normalized = normalizeIdentifier(scheme, digits);
  return normalized.kind === 'valid' ? (normalized.identifier.canonicalValue ?? null) : null;
}

/**
 * The canonical product a purchased VARIANT resolves to, or `null`.
 *
 * The variant and not the listing, because a barcode identifies one exact
 * purchasable configuration (ADR 0002 D5) and a listing may carry several.
 */
export async function findCanonicalProductIdForVariant(
  variantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const [variant] = await db
    .select({ barcode: productVariants.barcode })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!variant?.barcode) return null;

  const canonicalValue = canonicalGtinFor(variant.barcode);
  if (!canonicalValue) return null;

  const [identifier] = await db
    .select({
      productId: productIdentifiers.productId,
      variantId: productIdentifiers.variantId,
    })
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.canonicalScheme, 'gtin'),
        eq(productIdentifiers.canonicalValue, canonicalValue),
        eq(productIdentifiers.status, 'active'),
      ),
    )
    .limit(1);

  if (!identifier) return null;
  if (identifier.productId) return identifier.productId;
  if (!identifier.variantId) return null;

  const [canonicalVariant] = await db
    .select({ productId: canonicalVariants.productId })
    .from(canonicalVariants)
    .where(eq(canonicalVariants.id, identifier.variantId))
    .limit(1);

  return canonicalVariant?.productId ?? null;
}

/**
 * The canonical product a purchased LISTING resolves to, or `null`.
 *
 * A listing resolves only when EVERY one of its variants that carries a barcode
 * resolves to the SAME canonical product. A listing whose variants disagree is
 * not one product, and picking the first would be exactly the guess this module
 * refuses to make.
 */
export async function findCanonicalProductIdForListing(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const variants = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId));

  const resolved = new Set<string>();
  for (const variant of variants) {
    const productId = await findCanonicalProductIdForVariant(variant.id, db);
    if (productId) resolved.add(productId);
  }

  const [only] = [...resolved];
  return resolved.size === 1 && only ? only : null;
}

/**
 * The canonical merchant a native store resolves to, or `null`.
 *
 * One hop through `native_store_links`, whose paired partial uniques already
 * hold at most one ACTIVE link on each side (ADR 0002 D4) — so this cannot
 * return two answers and there is nothing here to disambiguate.
 *
 * This is also the whole of #76 migration rule 6. A store review classified to
 * `merchant` scope stops matching the legacy `store` filter in the same
 * statement that starts it matching the merchant one, so no review is ever in
 * both public aggregates; and `resolveStoreRatingSource` reads ONE of the two
 * and returns ONE number.
 */
export async function findMerchantIdForStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null> {
  const link = await findActiveLinkByStore(db, storeId);
  return link?.merchantId ?? null;
}
