/**
 * The candidate read behind `GET /catalog-authoring/canonical-search`
 * (#367 step 5, ADR 0007 D10).
 *
 * An author is choosing an IDENTITY: "which product is this". So the reads here
 * are deliberately narrow — an id, a kind, a name, a brand and the identifiers
 * that tell two similar-looking phones apart — and they carry no offer, no price
 * and no merchant. Putting a price beside a candidate would invite a seller to
 * pick the row with the number they liked, which is a false merge somebody
 * committed on purpose.
 *
 * ## An identifier hit and a name search are different questions
 *
 * {@link findCanonicalProductsByIdentifier} answers the first and
 * {@link searchCanonicalProductsByName} the second, and they are separate
 * functions rather than one with a branch — because the CALLER has to be able to
 * tell them apart. An author confirming a barcode is making a far stronger
 * statement than one picking the closest-looking name, and the response says
 * which happened.
 *
 * ## Nothing here matches, mints or attaches
 *
 * This module issues SELECTs only. #58 owns matching, #60 owns minting and #57
 * owns the attachment; a directly selected entity is linked by the publication
 * with method `merchant_declared` and is never handed to the matcher, which is
 * D10's rule and is a property of the publish path rather than of this file.
 */

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres.js';
import { brands } from '../schema/organizations.js';
import {
  canonicalProducts,
  canonicalVariants,
  productIdentifiers,
} from '../schema/canonicalCatalog.js';

/** One row a candidate is composed from. */
export interface CanonicalProductCandidateRow {
  readonly id: string;
  readonly name: string;
  readonly brandName: string | null;
}

/** One canonical variant a candidate is composed from. */
export interface CanonicalVariantCandidateRow {
  readonly id: string;
  readonly productId: string;
  readonly name: string | null;
}

/**
 * The statuses an author may select.
 *
 * `active` and nothing else. A `draft` canonical product is one #60 minted and
 * nobody has agreed; `merged` is a tombstone; `suppressed` is a decision to stop
 * showing it; `discontinued` is a product that is no longer made, which a
 * merchant listing new stock is not selling. Offering any of them would let an
 * explicit human selection land on a row the catalogue has already decided
 * against — the one thing D10 says must never be overruled, overruled in
 * advance.
 */
const SELECTABLE_STATUS = eq(canonicalProducts.status, 'active');

/**
 * Products carrying an identifier whose normalized or canonical form matches.
 *
 * Both forms are compared, and that is not belt-and-braces: `normalized_value`
 * is the SCHEME's own normalization (folded case for an MPN, digits for a GTIN)
 * while `canonical_value` is the cross-scheme GTIN-14, and a shopper typing a
 * 12-digit UPC matches only the second. Comparing one would silently answer
 * "no such product" for the commonest thing anybody scans.
 *
 * `status = 'active'` on the identifier too: a `disputed` or `withdrawn`
 * assertion is exactly the row an author must not be steered onto, because two
 * products claim it and picking one is the false merge #58 is shaped around.
 */
export async function findCanonicalProductsByIdentifier(
  db: DatabaseOrTransaction,
  normalized: string,
  canonical: string | null,
  limit: number,
): Promise<CanonicalProductCandidateRow[]> {
  const valueMatch =
    canonical === null
      ? eq(productIdentifiers.normalizedValue, normalized)
      : or(
          eq(productIdentifiers.normalizedValue, normalized),
          eq(productIdentifiers.canonicalValue, canonical),
        );

  const rows = await db
    .selectDistinct({
      id: canonicalProducts.id,
      name: canonicalProducts.name,
      brandName: brands.name,
    })
    .from(productIdentifiers)
    .innerJoin(canonicalProducts, eq(canonicalProducts.id, productIdentifiers.productId))
    .leftJoin(brands, eq(brands.id, canonicalProducts.brandId))
    .where(and(eq(productIdentifiers.status, 'active'), valueMatch, SELECTABLE_STATUS))
    .orderBy(asc(canonicalProducts.name))
    .limit(limit);
  return rows;
}

/**
 * Products whose name is close to a typed query.
 *
 * `ORDER BY name <-> $1` and NOT `ORDER BY similarity(name, $1) DESC`. They are
 * the same ordering — `<->` is `1 - similarity` — and only the first can be
 * served by a GiST index; #61 measured the difference at 81.6 ms scanning 31,094
 * rows against 16.6 ms scanning 25, and a realdb test asserts the candidate
 * search still spells it `<->`. Do not tidy the distance operator back into a
 * function call: it compiles, returns the same rows, and costs 6.6× more.
 */
export async function searchCanonicalProductsByName(
  db: DatabaseOrTransaction,
  normalizedQuery: string,
  limit: number,
): Promise<CanonicalProductCandidateRow[]> {
  return db
    .select({
      id: canonicalProducts.id,
      name: canonicalProducts.name,
      brandName: brands.name,
    })
    .from(canonicalProducts)
    .leftJoin(brands, eq(brands.id, canonicalProducts.brandId))
    .where(SELECTABLE_STATUS)
    .orderBy(sql`${canonicalProducts.normalizedName} <-> ${normalizedQuery}`)
    .limit(limit);
}

/** The identifiers of a candidate set — one statement, never one per product. */
export async function listIdentifiersForProducts(
  db: DatabaseOrTransaction,
  productIds: readonly string[],
): Promise<{ productId: string; scheme: string; value: string }[]> {
  if (productIds.length === 0) return [];
  const rows = await db
    .select({
      productId: productIdentifiers.productId,
      scheme: productIdentifiers.scheme,
      rawValue: productIdentifiers.rawValue,
    })
    .from(productIdentifiers)
    .where(
      and(
        inArray(productIdentifiers.productId, [...productIds]),
        eq(productIdentifiers.status, 'active'),
      ),
    )
    .orderBy(asc(productIdentifiers.scheme));

  const identifiers: { productId: string; scheme: string; value: string }[] = [];
  for (const row of rows) {
    // `product_identifiers_grain_check` allows a variant-grain row, whose
    // `product_id` is NULL. The `inArray` above cannot return one, but stating
    // the narrowing keeps the mapping honest under `strict: false`, where a
    // `string | null` would assign to a `string` field in silence.
    if (row.productId === null) continue;
    identifiers.push({ productId: row.productId, scheme: row.scheme, value: row.rawValue });
  }
  return identifiers;
}

/** A product's selectable configurations, for the variant half of the picker. */
export async function listSelectableCanonicalVariants(
  db: DatabaseOrTransaction,
  productId: string,
  limit: number,
): Promise<CanonicalVariantCandidateRow[]> {
  return db
    .select({
      id: canonicalVariants.id,
      productId: canonicalVariants.productId,
      name: canonicalVariants.name,
    })
    .from(canonicalVariants)
    .where(and(eq(canonicalVariants.productId, productId), eq(canonicalVariants.status, 'active')))
    .orderBy(desc(canonicalVariants.isDefault), asc(canonicalVariants.name))
    .limit(limit);
}

/**
 * Resolve a selected canonical product through any merge that has happened since
 * the author chose it.
 *
 * This is what replaces a foreign key on the draft's selection column, and it is
 * strictly better than one: a `restrict` FK would have let a half-finished form
 * BLOCK a catalogue merge, and every other `ON DELETE` would have destroyed or
 * silently emptied the author's answer. A merge leaves the loser in place with
 * `status = 'merged'` and `merged_into_id` set, so following that pointer at
 * PUBLISH time lands on the winner with no rehoming pass having run.
 *
 * The walk is bounded at eight hops. `canonical_products_merged_self_check`
 * refuses a self-merge and #59's merge job refuses a cycle, so the bound is not
 * what makes this terminate — it is what makes a corrupted chain answer `null`
 * instead of spinning, which is the `resolveCategoryRedirect` posture one domain
 * over.
 */
export async function resolveCanonicalProductSelection(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<{ id: string; hops: number } | null> {
  let current = productId;
  for (let hops = 0; hops <= 8; hops += 1) {
    const rows = await db
      .select({
        id: canonicalProducts.id,
        status: canonicalProducts.status,
        mergedIntoId: canonicalProducts.mergedIntoId,
      })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, current))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.status === 'active') return { id: row.id, hops };
    if (row.mergedIntoId === null) return null;
    current = row.mergedIntoId;
  }
  return null;
}

/** The same walk, for a selected configuration. */
export async function resolveCanonicalVariantSelection(
  db: DatabaseOrTransaction,
  variantId: string,
): Promise<{ id: string; productId: string; hops: number } | null> {
  let current = variantId;
  for (let hops = 0; hops <= 8; hops += 1) {
    const rows = await db
      .select({
        id: canonicalVariants.id,
        productId: canonicalVariants.productId,
        status: canonicalVariants.status,
        mergedIntoId: canonicalVariants.mergedIntoId,
      })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.id, current))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.status === 'active') return { id: row.id, productId: row.productId, hops };
    if (row.mergedIntoId === null) return null;
    current = row.mergedIntoId;
  }
  return null;
}

/** Whether a variant belongs to a product — the one consistency check a selection needs. */
export async function canonicalVariantBelongsToProduct(
  db: DatabaseOrTransaction,
  variantId: string,
  productId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: canonicalVariants.id })
    .from(canonicalVariants)
    .where(and(eq(canonicalVariants.id, variantId), eq(canonicalVariants.productId, productId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Brands whose name is close to a typed query — the `canonical_reference` value
 * policy's picker.
 *
 * A brand is a MERGEABLE entity and a draft stores its id with no foreign key,
 * so a merged brand is resolved the same way a merged product is. `isNull` on
 * `merged_into_id` here rather than a status filter, because
 * `canonicalLifecycleColumns` and `catalogLifecycleColumns` are two different
 * shapes and only the pointer is common to both.
 */
export async function searchBrandsByName(
  db: DatabaseOrTransaction,
  normalizedQuery: string,
  limit: number,
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: brands.id, name: brands.name })
    .from(brands)
    .where(isNull(brands.mergedIntoId))
    .orderBy(sql`${brands.normalizedName} <-> ${normalizedQuery}`)
    .limit(limit);
}
