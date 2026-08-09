/**
 * The mapping version, and the subject keys every report row is identified by
 * (#60 job behaviour 1: idempotent by listing, variant and mapping version).
 *
 * ## Why the version is a CONSTANT and not a table
 *
 * The mapping is ADR 0002 D23 phase 1's deterministic rule set — exact GTIN,
 * exact connector identity, and nothing else — and it lives in the code that
 * implements it. A `mapping_versions` table would let an operator publish a
 * version whose rules nobody shipped, which is the opposite of the property the
 * version exists to give: that a report is attributable to a rule set somebody
 * can read.
 *
 * `match_policy_versions` is a table for the opposite reason and the contrast is
 * worth keeping straight: a matching policy is WEIGHTS and THRESHOLDS, which are
 * data an operator tunes without shipping code. A backfill mapping is a
 * procedure.
 *
 * ## When to bump it
 *
 * Whenever a stage's DECISION would differ for a subject it has already
 * reported. Bumping mints a new report beside the old one (the identity key
 * carries the version), so the two rule sets are comparable and no earlier
 * verdict is silently reinterpreted — the `UNIQUE(evaluation_key,
 * policy_version_id)` shape #58 uses.
 *
 * Bumping is NOT needed for a bug fix that changes only how a decision is
 * carried out, nor for adding a stage: a new stage has no prior rows to
 * reinterpret.
 */

import type { CatalogBackfillSubjectKind } from '@mercaria/shared-types';

/**
 * Version 1 — ADR 0002 D23 phase 1 as written:
 *
 * 1. every ACTIVE native store mints a merchant and a verified
 *    `native_store_links` row;
 * 2. `listings.vendor` becomes brand CANDIDATES, never brands;
 * 3. every native variant of an eligible listing is enqueued for #58's matcher;
 * 4. an unmatched STORE listing mints a DRAFT canonical product plus one
 *    canonical variant per native variant, with identifiers taken only from
 *    barcodes that GTIN-validate, and attaches them;
 * 5. an unmatched P2P listing is left unattached and keeps operating;
 * 6. every attached listing is enqueued for #57's offer convergence.
 */
export const CATALOG_BACKFILL_MAPPING_VERSION = 1;

/**
 * The rule id recorded on everything this mapping version writes into another
 * domain — a `native_listing_links.match_rule`, a source link's `match_rule`.
 *
 * Carries the version, so an operator reading a link can tell which rule set
 * produced it without joining back to a run.
 */
export const CATALOG_BACKFILL_RULE_ID = `backfill:v${String(CATALOG_BACKFILL_MAPPING_VERSION)}`;

/**
 * The separator between a subject's kind and its id.
 *
 * `:` — which no uuid v7 contains, so two different subjects cannot render to
 * one key. The same reasoning as `offers.source_key`'s `|`, and the same
 * consequence if it were ever violated: two subjects sharing an identity key
 * would silently overwrite each other's verdicts.
 */
const SEPARATOR = ':';

/** A subject, as this domain addresses it. */
export type BackfillSubject =
  | { readonly kind: 'store'; readonly storeId: string }
  | { readonly kind: 'listing'; readonly listingId: string }
  | { readonly kind: 'product_variant'; readonly productVariantId: string }
  | { readonly kind: 'canonical_product'; readonly canonicalProductId: string }
  | { readonly kind: 'native_offer'; readonly offerId: string }
  /**
   * A normalized brand-candidate STRING, which is why this union has no common
   * `id` field: a vendor value is not a row anywhere, and a field named `id`
   * would invite a caller to treat it as one.
   */
  | { readonly kind: 'vendor_value'; readonly normalizedName: string };

/**
 * The stable identity of a subject.
 *
 * A `switch` over a union with no common `id` field, which is the
 * `cartOwnerForActor` device: the compiler forces every new subject kind to
 * decide what identifies it, and a store id can never be written into a key
 * claiming to name a listing.
 */
export function backfillSubjectKey(subject: BackfillSubject): string {
  switch (subject.kind) {
    case 'store':
      return `store${SEPARATOR}${subject.storeId}`;
    case 'listing':
      return `listing${SEPARATOR}${subject.listingId}`;
    case 'product_variant':
      return `product_variant${SEPARATOR}${subject.productVariantId}`;
    case 'canonical_product':
      return `canonical_product${SEPARATOR}${subject.canonicalProductId}`;
    case 'native_offer':
      return `native_offer${SEPARATOR}${subject.offerId}`;
    case 'vendor_value':
      // A vendor group's identity is its NORMALIZED name — the same grouping key
      // `extractVendorBrandCandidates` uses, so the two agree by construction.
      // An unnormalizable value groups under the empty string, which is a real
      // group with a real report row rather than a subject nobody can address.
      return `vendor_value${SEPARATOR}${subject.normalizedName}`;
  }
}

/** The subject KIND a key names, for a report row's typed column. */
export function backfillSubjectKind(subject: BackfillSubject): CatalogBackfillSubjectKind {
  return subject.kind;
}
