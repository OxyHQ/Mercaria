/**
 * The pure vocabulary of review scopes (#76) — no database, no HTTP, no clock.
 *
 * Everything a scope decision needs to be CORRECT lives here, so it can be
 * table-tested exhaustively and so the wall between "the product was bad" and
 * "the courier was slow" is one function rather than a habit spread over five
 * call sites.
 *
 * ## The three refusals this module owns
 *
 *  1. **A forbidden scope.** {@link assertScopeAllowed} refuses `brand` and its
 *     four siblings BY NAME. A brand rating computed by averaging product
 *     reviews is the exact thing #76 forbids, and the refusal says so rather
 *     than reporting "unrecognized value" — a message that reads like a typo.
 *  2. **A dimension from another scope.** {@link assertDimensionsForScope}
 *     refuses `condition_accuracy` on a `product` review and `durability` on a
 *     `merchant` one. This is where acceptance criteria 1 and 2 are enforced for
 *     the SUB-ratings; the headline rating is separated by the aggregate itself.
 *  3. **A forbidden evidence source.** {@link assertNotForbiddenEvidenceSource}
 *     refuses all fourteen by name. It exists because a refusal that says
 *     "unrecognized key" teaches whoever hit it to look for a typo, and the
 *     thing they actually did was try to make an email address prove a purchase.
 */

import {
  REVIEW_FORBIDDEN_EVIDENCE_SOURCES,
  REVIEW_FORBIDDEN_SCOPES,
  REVIEW_SCOPE_DIMENSION_KEYS,
  REVIEW_SCOPE_TARGET_TYPE,
  REVIEW_SCOPES,
  type ReviewDimension,
  type ReviewScope,
  type ReviewTargetType,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** A scope plus the thing it is about. */
export interface ScopedTarget {
  scope: ReviewScope;
  targetType: ReviewTargetType;
  targetId: string;
}

/** The one scope → target-type lookup, so no caller writes a second switch. */
export function targetTypeForScope(scope: ReviewScope): ReviewTargetType {
  return REVIEW_SCOPE_TARGET_TYPE[scope];
}

/** Build a {@link ScopedTarget}, deriving the target type rather than trusting one. */
export function scopedTarget(scope: ReviewScope, targetId: string): ScopedTarget {
  return { scope, targetType: targetTypeForScope(scope), targetId };
}

/**
 * Refuse a scope Mercaria will not compute, naming it.
 *
 * The forbidden list is checked FIRST and separately from the allowed list, so
 * `brand` produces "Mercaria does not compute a brand rating…" and a genuine
 * typo produces "not a review scope". Collapsing the two would hide the
 * interesting failure inside the boring one.
 */
export function assertScopeAllowed(scope: string): asserts scope is ReviewScope {
  if ((REVIEW_FORBIDDEN_SCOPES as readonly string[]).includes(scope)) {
    throw validationError(
      `Mercaria does not compute a '${scope}' rating. A brand, an organization, a product ` +
        'family, a category and the platform are all aggregates of other things people ' +
        'reviewed, and averaging reviews into one produces a number no reviewer wrote. ' +
        `Review a specific target instead: ${REVIEW_SCOPES.join(', ')}.`,
    );
  }
  if (!(REVIEW_SCOPES as readonly string[]).includes(scope)) {
    throw validationError(`'${scope}' is not a review scope`);
  }
}

/**
 * Refuse a signal that may never establish eligibility, naming it.
 *
 * Called by the eligibility service on every grant path, over the caller's
 * declared reason. It cannot be bypassed by omission: the grant functions take a
 * `ReviewEvidenceType`, which has exactly two members, and this is the guard for
 * a caller that reached for a string.
 */
export function assertNotForbiddenEvidenceSource(source: string): void {
  if ((REVIEW_FORBIDDEN_EVIDENCE_SOURCES as readonly string[]).includes(source)) {
    throw validationError(
      `'${source}' cannot establish review eligibility. It identifies a person, a device or ` +
        'an instrument; review eligibility comes from an order line and nothing else.',
    );
  }
}

/**
 * Refuse a dimension that does not belong to the scope, naming both.
 *
 * A CHECK cannot do this — it would have to read the parent review's scope, and
 * a CHECK admits no subquery — so this runs before any SQL is issued and
 * `insertScopedReview` is the single writer that calls it. Duplicates are
 * refused here too: `review_dimensions_review_id_key_key` would refuse them
 * anyway, but a 500 from a unique violation reads like a bug rather than like
 * "you sent `quality` twice".
 */
export function assertDimensionsForScope(
  scope: ReviewScope,
  dimensions: readonly ReviewDimension[] | undefined,
): void {
  if (!dimensions || dimensions.length === 0) return;

  const allowed = REVIEW_SCOPE_DIMENSION_KEYS[scope];
  const seen = new Set<string>();

  for (const dimension of dimensions) {
    if (!allowed.includes(dimension.key)) {
      throw validationError(
        `'${dimension.key}' is not a dimension of a '${scope}' review. A '${scope}' review ` +
          `may rate: ${allowed.join(', ')}.`,
      );
    }
    if (seen.has(dimension.key)) {
      throw validationError(`'${dimension.key}' was rated twice`);
    }
    seen.add(dimension.key);
  }
}

/**
 * The scopes a completed purchase of one order line unlocks.
 *
 * #76 verification rule 1: one completed native order verifies the PRODUCT, the
 * MERCHANT and the TRANSACTION. Which of the three are actually grantable
 * depends on what the line resolves to — a line whose listing has no canonical
 * product cannot grant a product eligibility, because there is nothing to
 * attach it to — and that resolution is the eligibility service's job. What is
 * decided HERE is the intent, so the list exists in one place rather than
 * implicitly in the order the service happens to try things.
 *
 * `p2p_listing` and `p2p_seller` are in the list too: a used-item purchase is
 * still a purchase, and the condition of what arrived is exactly what the buyer
 * is in a position to describe.
 */
export const SCOPES_A_PURCHASE_CAN_UNLOCK: readonly ReviewScope[] = [
  'product',
  'merchant',
  'native_transaction',
  'p2p_listing',
  'p2p_seller',
];

/**
 * The scopes whose aggregate is PROJECTED onto the target entity's own
 * denormalized rating columns, and which column pair each writes.
 *
 * A projection with ONE writer is not a second representation of a fact; a
 * second WRITER would be. `review-aggregate.service` is that writer, it writes
 * both in the same call from the same derived figures, and nothing else touches
 * either column. The columns predate #76 (`listings.rating` since the port,
 * `canonical_products.rating` from #56 product rule 11, `merchants.rating` from
 * #54) and this is what finally fills the last two in.
 *
 * `native_transaction` is absent deliberately: an order line has no rating
 * column, and adding one would turn a private transaction review into a public
 * star rating on somebody's purchase.
 */
export const SCOPES_WITH_ENTITY_PROJECTION: readonly ReviewScope[] = [
  'product',
  'merchant',
  'p2p_listing',
  'p2p_seller',
];
