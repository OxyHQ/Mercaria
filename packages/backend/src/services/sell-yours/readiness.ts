/**
 * May this draft be published, and what stands in the way (#91 UX rule 1,
 * acceptance 2 and 5).
 *
 * ## Derived, never stored
 *
 * The inputs are the draft's own columns, its two child tables, the CATEGORY's
 * condition restrictions and the latest gate refusal — four tables in three
 * domains, which is the `deriveNativeCheckoutEligibility` divergence from the
 * one-stored-verdict rule and the same reasoning: a stored `publishable` boolean
 * would go stale the moment an operator restricted a condition in a category, or
 * a merge moved the product a refusal was about, and the place that must not
 * happen is a gate letting through a listing whose evidence no longer meets its
 * own condition's policy.
 *
 * ## Every reason names a fact the SELLER can act on
 *
 * None of them names another seller, a stock level, a moderation decision or a
 * catalogue operator's opinion. `match_review_required` is the closest, and it
 * says only that a person must look — never which product it disagreed with,
 * because the useful remedy is "change or remove the match", and the identity of
 * the conflicting product is somebody else's listing.
 *
 * ## The extreme-price WARNING is separate from every block, deliberately
 *
 * #91 asks for a warning on an extreme value and forbids blocking an unusual but
 * valid price in the same sentence. Two lists rather than one severity scale, so
 * a later "we should really stop them" cannot be expressed by nudging a number.
 */

import type {
  ItemConditionKey,
  SellerDraftBlockReason,
  SellerDraftReadiness,
  SellerDraftWarning,
  SellerPriceGuidance,
} from '@mercaria/shared-types';
import {
  CONDITION_DISCLOSURE_KINDS,
  SELLER_PRICE_EXTREME_FACTOR,
  conditionEvidencePolicy,
} from '@mercaria/shared-types';
import type {
  SellerDraftDetailRecord,
  SellerDraftImageRecord,
  SellerDraftRecord,
} from '../../db/sellYours/draftRepository.js';

/** Everything the derivation reads, gathered by the caller. */
export interface SellerReadinessFacts {
  readonly draft: SellerDraftRecord;
  readonly details: readonly SellerDraftDetailRecord[];
  readonly images: readonly SellerDraftImageRecord[];
  /** Condition keys this draft's category refuses (#90 policy rule 5). */
  readonly forbiddenConditionKeys: readonly ItemConditionKey[];
  /** Whether the deterministic gate has already refused a declared match. */
  readonly matchRefused: boolean;
  /** The guidance the extreme-price warning is measured against, when there is any. */
  readonly guidance?: SellerPriceGuidance;
}

/**
 * The one place a price is called extreme.
 *
 * Measured against the SAME-CONDITION segment only. Comparing a used item's
 * price against the `new` range would warn every seller of a like-new item that
 * their price is low, which is both true and useless.
 */
function priceWarnings(
  draft: SellerDraftRecord,
  guidance: SellerPriceGuidance | undefined,
): SellerDraftWarning[] {
  if (draft.priceAmount === null || !guidance) return [];
  const segment = guidance.segments.find(
    (candidate) => candidate.kind === 'current_same_condition',
  );
  if (!segment || segment.state !== 'available') return [];
  // Guidance is composed in a currency the caller asked for; a price in another
  // one is not comparable and produces no warning rather than a wrong one.
  if (draft.priceCurrency !== guidance.currency) return [];

  if (draft.priceAmount > segment.high.amount * SELLER_PRICE_EXTREME_FACTOR) {
    return ['price_far_above_guidance'];
  }
  if (segment.low.amount > draft.priceAmount * SELLER_PRICE_EXTREME_FACTOR) {
    return ['price_far_below_guidance'];
  }
  return [];
}

/** Derive whether a draft may be published. */
export function deriveSellerDraftReadiness(facts: SellerReadinessFacts): SellerDraftReadiness {
  const { draft } = facts;
  const blockReasons: SellerDraftBlockReason[] = [];

  if (draft.status === 'published') blockReasons.push('already_published');
  if (draft.status === 'discarded') blockReasons.push('draft_discarded');

  if (!draft.title || draft.title.trim().length === 0) blockReasons.push('title_missing');
  if (!draft.description || draft.description.trim().length === 0) {
    blockReasons.push('description_missing');
  }
  if (!draft.categoryId) blockReasons.push('category_missing');
  if (draft.priceAmount === null || draft.priceCurrency === null) {
    blockReasons.push('price_missing');
  }
  if (draft.quantity < 1) blockReasons.push('quantity_invalid');

  /**
   * `offered` stays refused AFTER #93, and the reason changed rather than
   * expiring.
   *
   * #93 landed collection, but it landed it for STORE locations: a publication
   * hangs off a `locations` row a store owns, and `derivePickupEligibility`
   * refuses a `user` seller for every actor. What #93 gives a P2P seller is
   * coarse local DISCOVERY — an area, not a collection promise — and the two
   * are kept apart deliberately (#93 P2P rules 6 and 8, acceptance 13), because
   * a person's home is not a shop front with published hours.
   *
   * So this stays the `role_email` device: the value is representable so the
   * gap is legible, and publishing a listing whose collection nothing honours
   * would be worse than saying so. What would close it is a P2P handover model
   * — meetup safety, evidence, value and category limits — which #112's
   * decision document names and does not grant.
   */
  if (draft.pickup === 'offered') blockReasons.push('pickup_not_supported');

  /**
   * A declaration the gate refused publishes UNMATCHED once the seller clears
   * it, and blocks until they do.
   *
   * The alternative — publish anyway and drop the match silently — is what makes
   * a false merge undiagnosable: the seller believes their item is on the
   * product page, the page does not show it, and nothing anywhere says why.
   */
  if (facts.matchRefused && draft.canonicalProductId !== null) {
    blockReasons.push('match_review_required');
  }
  // A product with no configuration has nothing to attach. One tap fixes it,
  // which is why it is worth asking for rather than silently unmatching.
  if (
    draft.canonicalProductId !== null &&
    draft.canonicalVariantId === null &&
    !facts.matchRefused
  ) {
    blockReasons.push('match_variant_missing');
  }

  const conditionKey = draft.conditionKey;
  if (!conditionKey) {
    blockReasons.push('condition_missing');
    return {
      publishable: false,
      blockReasons,
      warnings: priceWarnings(draft, facts.guidance),
      requiredItemPhotos: 0,
    };
  }

  if (facts.forbiddenConditionKeys.includes(conditionKey)) {
    blockReasons.push('category_forbids_condition');
  }

  const policy = conditionEvidencePolicy(conditionKey);
  if (policy.requiresItemPhotos && facts.images.length < policy.minimumItemPhotos) {
    blockReasons.push('item_photos_missing');
  }
  if (policy.requiresDefectAcknowledgement && draft.defectsAcknowledgedAt === null) {
    blockReasons.push('defects_not_acknowledged');
  }
  /**
   * A refurbished item must name who refurbished it (#90 evidence 7), and the
   * only place that can be said is a `repair_or_refurbishment` disclosure —
   * which #90 already requires to carry a written note. Reusing that vocabulary
   * rather than adding a `refurbisher` column is what stops two answers to one
   * question existing.
   */
  if (
    policy.requiresRefurbisherAttribution &&
    !facts.details.some(
      (detail) =>
        detail.kind === 'repair_or_refurbishment' && (detail.note ?? '').trim().length > 0,
    )
  ) {
    blockReasons.push('refurbisher_not_named');
  }

  return {
    publishable: blockReasons.length === 0,
    blockReasons,
    warnings: priceWarnings(draft, facts.guidance),
    requiredItemPhotos: policy.minimumItemPhotos,
  };
}

/**
 * Whether the seller has disclosed anything that needs acknowledging.
 *
 * Exported because the draft service needs the same answer when it decides
 * whether an acknowledgement is still current: #90's rule is that a seller
 * acknowledges what was disclosed AT THAT MOMENT, so adding a defect after
 * acknowledging clears the acknowledgement rather than being covered by it.
 */
export function hasDisclosedDefects(details: readonly SellerDraftDetailRecord[]): boolean {
  return details.some((detail) =>
    CONDITION_DISCLOSURE_KINDS.includes(detail.kind as (typeof CONDITION_DISCLOSURE_KINDS)[number]),
  );
}
