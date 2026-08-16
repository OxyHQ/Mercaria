/**
 * `GET /catalog-authoring/canonical-search` (#367 step 5, ADR 0007 D10).
 *
 * An author asking "which product is this". The answer is a list of IDENTITIES
 * with the facts that tell two similar-looking things apart, and it carries no
 * price, no offer and no merchant — putting a number beside a candidate would
 * invite a seller to pick the row they liked, which is a false merge somebody
 * committed on purpose.
 *
 * ## An identifier hit is a different answer from a name search
 *
 * `exactIdentifierMatch` travels back with the candidates, because an author
 * confirming a barcode is making a far stronger statement than one picking the
 * closest-looking name — and the publication records both as
 * `merchant_declared`, so the surface is where the difference has to be visible.
 *
 * A recognisable identifier is answered ALONE: no fuzzy stage and no name
 * candidates beside it. That is #70's own rule for a bare identifier query, and
 * the reasoning carries: a GTIN that resolves is not improved by three
 * similarly-named phones underneath it, and offering them is how somebody
 * scanning a barcode picks the wrong one.
 *
 * ## This module matches NOTHING
 *
 * It issues SELECTs and ranks by trigram distance. #58 owns matching, #60 owns
 * minting a canonical product, #57 owns the attachment. A `create_new` is not
 * offered here at all: the missing-concept path is ADR 0007 D9's proposal, which
 * is #367 merge-order step 6, and inventing a canonical product from an
 * authoring search would be the auto-promotion D9 exists to refuse.
 */

import type { AuthoringCanonicalCandidate, AuthoringCanonicalSearchResult } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findCanonicalProductsByIdentifier,
  listIdentifiersForProducts,
  listSelectableCanonicalVariants,
  searchBrandsByName,
  searchCanonicalProductsByName,
} from '../../db/catalogAuthoring/canonicalSearchRepository.js';

/** What a caller may search for. */
export interface CanonicalSearchInput {
  readonly query: string;
  /** `canonical_product` unless the caller is filling a `canonical_reference` field. */
  readonly kind: 'canonical_product' | 'brand';
  /** Narrow to one product's configurations — the variant half of the picker. */
  readonly canonicalProductId?: string;
  readonly limit: number;
}

/**
 * The identifier normalizations this search recognises.
 *
 * DIGITS ONLY, and the canonical form is the zero-padded GTIN-14
 * `product_identifiers.canonical_value` already stores. An MPN is deliberately
 * NOT recognised as an identifier query: `product_identifiers` records MPNs and
 * they are unique at no grain Mercaria can enforce — the `product_variants.sku`
 * ruling, one table over — so an MPN that "matched" would be steering an author
 * onto whichever manufacturer used that part number first.
 */
function normalizeIdentifier(query: string): { normalized: string; canonical: string | null } | null {
  const digits = query.replace(/[\s-]/gu, '');
  if (!/^[0-9]{8,14}$/u.test(digits)) return null;
  // A GTIN-8, UPC-12, EAN-13 and GTIN-14 all collapse to a zero-padded 14 —
  // which is exactly what `product_identifiers_canonical_value_shape_check`
  // requires and what the collision gate indexes. Anything else in that length
  // band is compared on its own normalization only.
  const canonical = digits.length <= 14 ? digits.padStart(14, '0') : null;
  return { normalized: digits, canonical };
}

/** The normalization `canonical_products.normalized_name` is maintained as. */
function normalizeName(query: string): string {
  return query.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Search the canonical catalogue for an entity an author may select. */
export async function searchCanonicalEntities(
  db: DatabaseOrTransaction,
  input: CanonicalSearchInput,
): Promise<AuthoringCanonicalSearchResult> {
  if (input.kind === 'brand') {
    const brands = await searchBrandsByName(db, normalizeName(input.query), input.limit);
    return {
      candidates: brands.map((brand) => ({
        kind: 'brand' as const,
        id: brand.id,
        name: brand.name,
        brandName: null,
        identifiers: {},
        canonicalProductId: null,
      })),
      exactIdentifierMatch: false,
    };
  }

  if (input.canonicalProductId !== undefined) {
    const variants = await listSelectableCanonicalVariants(
      db,
      input.canonicalProductId,
      input.limit,
    );
    return {
      candidates: variants.map((variant) => ({
        kind: 'canonical_variant' as const,
        id: variant.id,
        // A configuration with no name is a real state — #56 makes
        // `canonical_variants.name` nullable — and rendering an empty string is
        // more honest than composing one from its option assignments, which
        // would be this surface inventing a display name the catalogue does not
        // carry.
        name: variant.name ?? '',
        brandName: null,
        identifiers: {},
        canonicalProductId: variant.productId,
      })),
      exactIdentifierMatch: false,
    };
  }

  const identifier = normalizeIdentifier(input.query);
  if (identifier !== null) {
    const hits = await findCanonicalProductsByIdentifier(
      db,
      identifier.normalized,
      identifier.canonical,
      input.limit,
    );
    if (hits.length > 0) {
      return {
        candidates: await withIdentifiers(db, hits),
        exactIdentifierMatch: true,
      };
    }
    // A recognisable identifier that resolved to NOTHING falls through to the
    // name search rather than answering empty. A mistyped barcode is not an
    // identifier (#70's rule), and answering "no such product" to a digit string
    // somebody typed by hand is how an author concludes the catalogue is empty.
  }

  const named = await searchCanonicalProductsByName(db, normalizeName(input.query), input.limit);
  return { candidates: await withIdentifiers(db, named), exactIdentifierMatch: false };
}

/** Attach each candidate's active identifiers — one statement for the whole page. */
async function withIdentifiers(
  db: DatabaseOrTransaction,
  products: readonly { id: string; name: string; brandName: string | null }[],
): Promise<AuthoringCanonicalCandidate[]> {
  const identifiers = await listIdentifiersForProducts(
    db,
    products.map((product) => product.id),
  );
  const byProduct = new Map<string, Record<string, string>>();
  for (const row of identifiers) {
    const bucket = byProduct.get(row.productId) ?? {};
    // The FIRST value per scheme wins, and the read is ordered by scheme so the
    // choice is stable across two calls. A product legitimately carries several
    // GTINs (a pack of one and a pack of three), and rendering all of them in a
    // picker row is noise an author cannot act on — the disambiguating fact is
    // that it HAS one.
    if (bucket[row.scheme] === undefined) bucket[row.scheme] = row.value;
    byProduct.set(row.productId, bucket);
  }
  return products.map((product) => ({
    kind: 'canonical_product' as const,
    id: product.id,
    name: product.name,
    brandName: product.brandName,
    identifiers: byProduct.get(product.id) ?? {},
    canonicalProductId: product.id,
  }));
}
