/**
 * Does this draft's barcode already belong to a DIFFERENT canonical product
 * (#367 workstream 7, "validate identifiers and collisions using existing
 * canonical rules").
 *
 * The half of that criterion `validation.ts` cannot answer. Whether a string is
 * a well-formed GTIN is arithmetic and pure; whether the catalogue already
 * knows whose it is, is a READ — so this module lives beside the pure validator
 * rather than inside it, and `validateDraftRow` merges its findings the way it
 * already merges `pendingProposalFindings`. That seam is the domain's existing
 * answer to "a rule that needs a row", and inventing a second one would make
 * two places decide what a validation is.
 *
 * ## It READS `product_identifiers` and writes nothing
 *
 * `catalog-authoring-isolation.test.ts`'s fifth wall forbids
 * `.insert|.update|.delete` against `productIdentifiers` and states the reason
 * in its own comment: "A read across a boundary is a join; a write across one
 * is a second authority." This is the join. It goes through
 * `findCanonicalProductsByIdentifier` — the read `db/catalogAuthoring/` already
 * owns and `canonical-search.service.ts` already calls — rather than a new
 * statement, so there is one spelling of "who owns this identifier" in the
 * domain.
 *
 * ## Why it does not call `canonical-search.service.ts`'s normalizer
 *
 * That module has a `normalizeIdentifier` of its own and it is deliberately
 * LENIENT: it accepts any 8–14 digit string and pads it, precisely so a
 * mistyped barcode falls through to a name search instead of answering "no such
 * product". That is right for a search box and wrong for an assertion. This
 * path uses `classifyBarcode`, which refuses a bad check digit — so a barcode
 * that is not a real GTIN is never compared against the catalogue at all, and
 * an author is told it is malformed rather than told nothing owns it.
 *
 * ## It reports PRODUCT-level ownership only
 *
 * A GTIN binds at `grain: 'variant'`, but the read this domain owns answers in
 * canonical PRODUCTS, and a product-level answer is the conservative one: "you
 * selected product P and this barcode belongs to product Q" is a contradiction
 * the author can act on, while a same-product different-configuration answer
 * would need a second read and would fire on packs and bundles that are
 * legitimately near each other. The narrower question is left to #58's matcher,
 * whose blocker CHECK already refuses an auto-merge on a conflicting identifier.
 */

import type { AuthoringValidationFinding } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findCanonicalProductsByIdentifier } from '../../db/catalogAuthoring/canonicalSearchRepository.js';
import { classifyBarcode } from './identifier.js';

/** One variant, as the collision read sees it. */
export interface VariantIdentifierForCollision {
  readonly position: number;
  readonly barcode: string | null;
}

/**
 * How many owners are read per barcode.
 *
 * A product legitimately carries several GTINs and a GTIN legitimately resolves
 * to one product, so the realistic owner count is one. The bound exists because
 * the read takes one, and it errs toward UNDER-reporting: if a value somehow had
 * more owners than this and every one of them were the selected product, the
 * page could truncate before reaching a foreign owner and the warning would not
 * fire. Under-reporting a warning is the safe direction — the finding is
 * advisory and #58's CHECK is what actually prevents the bad merge.
 */
const OWNER_PAGE = 5;

/**
 * Findings for every variant barcode the catalogue attributes elsewhere.
 *
 * Answers `[]` — with NO database call at all — when the draft names no
 * canonical product. That is not an optimisation: with nothing selected there is
 * no contradiction to report. A barcode the catalogue already owns is then
 * evidence the author is describing that product, which is what the matcher
 * exists to conclude, and reporting it would tell somebody their correct barcode
 * is a problem.
 */
export async function identifierCollisionFindings(
  db: DatabaseOrTransaction,
  input: {
    readonly selectedCanonicalProductId: string | null;
    readonly variants: readonly VariantIdentifierForCollision[];
  },
): Promise<AuthoringValidationFinding[]> {
  const selected = input.selectedCanonicalProductId;
  if (selected === null || selected === '') return [];

  /**
   * One lookup per DISTINCT canonical value, not per variant.
   *
   * Two variants sharing a barcode is already `duplicate_variant_barcode`; the
   * catalogue has one answer about that value either way, and asking twice would
   * put a second statement on a validate request for no new fact.
   */
  const positionsByCanonical = new Map<string, { normalized: string; positions: number[] }>();
  for (const variant of input.variants) {
    const classified = classifyBarcode(variant.barcode);
    // `invalid` is excluded deliberately as well as `unrecognized`: a string
    // that failed its check digit is not an identifier, so "nothing owns it" is
    // not a fact worth reading and `identifier_check_digit_invalid` has already
    // said the true thing about it.
    if (classified.kind !== 'valid') continue;
    const bucket = positionsByCanonical.get(classified.canonicalValue) ?? {
      normalized: classified.normalizedValue,
      positions: [],
    };
    bucket.positions.push(variant.position);
    positionsByCanonical.set(classified.canonicalValue, bucket);
  }
  if (positionsByCanonical.size === 0) return [];

  const findings: AuthoringValidationFinding[] = [];
  for (const [canonicalValue, bucket] of positionsByCanonical) {
    const owners = await findCanonicalProductsByIdentifier(
      db,
      bucket.normalized,
      canonicalValue,
      OWNER_PAGE,
    );
    // A FOREIGN owner, not merely "an owner". The selected product owning its
    // own barcode is the correct state and the commonest one — reporting it
    // would fire on every author who picked the right product.
    if (!owners.some((owner) => owner.id !== selected)) continue;
    for (const position of bucket.positions) {
      findings.push({
        code: 'identifier_collision',
        severity: 'warning',
        path: `variants[${position}].barcode`,
      });
    }
  }
  return findings;
}
